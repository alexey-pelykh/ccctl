// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `@ccctl/cli` — the `ccctl` command-line entry point.
 *
 * Three verbs orchestrate the local setup, each delegating to a real capability
 * behind an injectable seam ({@link CliDependencies}):
 *
 *   - `ccctl patch` — delegate to the external `ccctl-patch` binary to prepare the
 *     patched Claude Code worker (the patcher ships in its own repository, not this
 *     workspace).
 *   - `ccctl serve` — start the loopback-bound {@link https://ccctl | @ccctl/server}
 *     daemon, optionally exposing it through a tunnel in one step (`--tunnel`).
 *   - `ccctl tunnel <kind>` — establish a {@link https://ccctl | @ccctl/tunnel-adapters}
 *     tunnel to an already-running loopback server, or take one back down (`--off`).
 *
 * Composed, they are the working local setup: `patch` the worker, `serve` the daemon,
 * and expose it via a `tunnel`. Each tunnel path also brackets the ACL grant the adapter
 * may provision to the tunnel's lifetime (#242), which is what makes the grant revertible:
 * `serve --tunnel` retains its tunnel so the daemon's shutdown releases it, while the
 * fire-and-forget `tunnel` verb (whose `--bg` mapping is meant to outlive it) is reverted
 * out-of-band by `--off`. `serve` still enforces the baseline startup guards
 * (refuse-start-without-auth + localhost-bind, #14) BEFORE anything binds; completing
 * each guard to spec is tracked separately (the auth credential boundary is #57, the
 * full localhost-bind guarantee is #58).
 *
 * Three more verbs are the launch/attach UX (#38 began it, #72 completes it) — unlike the three
 * above (which stand the local setup up), these are CLIENTS of an already-running daemon's
 * browser-facing session namespace, driving it from the command line the same way the phone does:
 *
 *   - `ccctl launch` — drive a UC2 "New session" launch (`POST /api/sessions`) on the running
 *     daemon and report how to attach the surface it brought up.
 *   - `ccctl attach` — the UC1 attach flow: with NO id, LIST the daemon's running sessions
 *     (`GET /api/sessions`) to pick one; with a session ID, SELECT that one and report how to drive
 *     it — the on-ramp's "select a session to attach to" completion.
 *   - `ccctl steer` — take over a selected session: push ONE steer verb at it
 *     (`POST /api/sessions/{id}/command` — send a prompt, approve a pending action, or interrupt),
 *     the very control path the phone drives.
 *   - `ccctl stop` — the emergency stop (#77): kill ONE session's terminal outright
 *     (`POST /api/sessions/{id}/stop`, #76) and report the terminal state it reached. The last verb
 *     of a session's life, and the opposite of `steer` despite the adjacent route — a steer ASKS the
 *     worker to do something and needs it listening; a stop kills the surface the worker RUNS ON and
 *     needs only the handle the daemon has held since it launched it, which is exactly why it works
 *     on the session that stopped answering.
 *
 * All go THROUGH the daemon, so a CLI-launched session lands in the same `/api/sessions` list as
 * the phone-driven ones AND is steerable the same way (the issue's second AC) — and, for `stop`, so
 * the shell and the phone drive the SAME server-side emergency-stop rather than two copies of a rule
 * that could disagree about which kills are legal (#77 AC3). This module builds the command tree;
 * `cli.ts` is the thin executable that runs it.
 */

import { Command } from "commander";
import {
  buildPairingUrl,
  formatAuthority,
  isPermissionMode,
  loggablePairingUrl,
  PERMISSION_MODES,
  type HostEndpoint,
  type PermissionMode,
  type SessionActivity,
} from "@ccctl/core";
import {
  createJsonLineLogger,
  DEFAULT_HOST,
  HEAP_SNAPSHOT_SIGNAL,
  INSPECTOR_DIAGNOSTICS_SIGNAL,
  mintDeviceToken,
  requireLocalServerAuth,
  resolveBindHost,
  resolveHeapSnapshotDir,
  revokeAllPairedDevices,
  SHUTDOWN_SIGNALS,
  type CcctlServer,
  type SessionLaunchOptions,
  type SessionStopOptions,
  type StopAcceptedWire,
} from "@ccctl/server";
import type { Tunnel, TunnelKind } from "@ccctl/tunnel-adapters";
import { defaultDependencies, type CliDependencies } from "./dependencies.js";
import type { SteerCommand } from "./session-client.js";

/**
 * Parse a `--port` option into a bound port number, failing closed on anything that
 * is not an integer in `0`–`65535` (`0` selects an ephemeral port). A clear upfront
 * error beats a confusing failure deep inside the daemon's `listen`.
 */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`ccctl: invalid port "${value}" — expected an integer between 0 and 65535`);
  }
  return port;
}

/**
 * Narrow an operator-supplied tunnel name to a {@link TunnelKind}, failing closed on
 * an unknown one. Validated against the injected `adapters` (the backends actually
 * available), so the accepted set and the error's advice never drift from what can
 * run.
 */
function requireTunnelKind(adapters: CliDependencies["adapters"], value: string): TunnelKind {
  if (!(value in adapters)) {
    throw new Error(`ccctl: unknown tunnel "${value}" — expected one of ${Object.keys(adapters).join(", ")}`);
  }
  return value as TunnelKind;
}

/** Render a bound `host:port` as an `http://` URL, bracketing an IPv6 host correctly. */
function serverUrl(host: string, port: number): string {
  return `http://${formatAuthority(host, port)}`;
}

/**
 * Establish `local` through the chosen tunnel and report it to the operator: first the
 * "reachable via" line the patched worker's `--sdk-url` allowlist needs, then the QR-pair
 * onboarding block (#74) — mint a per-device token, encode the tunnel origin + token into a
 * scannable QR, and print a REDACTED pairing-URL hint. The token leaves ONLY on the QR
 * (scanned by the phone) and over the operator's own tunnel; the printed hint is redacted, so
 * the raw token is never logged in plaintext. The single place that reports a freshly-exposed
 * tunnel, shared by `serve --tunnel` and the standalone `tunnel` verb — both make the loopback
 * server reachable off-box, so both are device-onboarding moments.
 *
 * TAKES the tunnel rather than constructing one (#255). The instance owns the lifecycle state
 * `teardown` needs (the serve mapping, and any ACL grant the adapter provisioned), so a caller
 * that outlives the establish — the `serve` daemon — must hold it to have a revert path at all.
 * #242 had this RETURN it for that, but a return only reaches the caller on SUCCESS: a rejected
 * establish still dropped the instance, and with it the only handle to the half-up serve
 * underneath. Constructing it in the caller is what makes the failure path releasable — whoever
 * owns the tunnel's lifetime holds it from the start, across both exits. `serve --tunnel` retains
 * it for the shutdown path AND releases it on a failed establish; the fire-and-forget `tunnel`
 * verb has nothing to retain it FOR and discards it deliberately (see that verb).
 */
async function establishAndReport(deps: CliDependencies, tunnel: Tunnel, local: HostEndpoint): Promise<void> {
  const established = await tunnel.establish(local);
  console.log(`ccctl: reachable via ${established.kind} at ${established.publicHost}`);

  // Mint a fresh per-device token and print it as a QR the phone scans to open the UI already
  // authenticated (no copy/paste). `publicHost` is the tunnel's reachable host — a bare host on
  // 443 — so the pairing URL carries no port; the token rides the URL fragment, so it is applied
  // client-side and never reaches the server in the request line. Durable persistence of the
  // minted token is #84; server-side verification is a later credentialed-wave item.
  const token = mintDeviceToken();
  const pairingUrl = buildPairingUrl({ host: established.publicHost, token });
  console.log("ccctl: scan to pair a device (opens the UI already authenticated):");
  console.log(deps.renderQr(pairingUrl));
  // Print the URL redacted — the QR is the token's only intended exit surface, so the plaintext
  // token never lands in the terminal scrollback or a captured log.
  console.log(`ccctl: pairing URL — ${loggablePairingUrl(pairingUrl)}`);
}

/** Describe a thrown value for a cleanup report — an `Error`'s message, else the value itself. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Release whatever a FAILED {@link Tunnel.establish} left behind (#255) — the missing half of
 * `serve --tunnel`'s atomicity claim.
 *
 * `TailscaleTunnel.establish` records its serve mapping the moment `tailscale serve --bg` lands —
 * BEFORE it verifies auth and resolves the host — precisely so a half-up serve stays releasable.
 * Nothing ever called the `teardown` that releasability was for, so `ccctl serve --tunnel tailscale`
 * against a node that is not an authenticated tailnet member left a detached mapping pointing at the
 * port it then closed. `teardown` is total (a clean no-op when the serve never landed), so this is
 * safe however far the establish got and needs no guess about which step failed.
 *
 * NEVER masks the establish error — which is the whole reason this is not a bare `teardown()` in the
 * catch. The operator's question is *why the tunnel could not be established*; a release failure is a
 * footnote to it, not an answer. So a failed release is reported here and swallowed, leaving the
 * caller to rethrow the original untouched: `cli.ts` prints `error.message` and nothing else, so any
 * wrapper ({@link AggregateError}, `{ cause }`) would REPLACE that answer with a summary rather than
 * add to it. The report names what may still be out there and the verb that clears it, exactly as the
 * shutdown path's `tunnel-teardown-failed` does (`@ccctl/server`'s `shutdown-signal.ts`).
 *
 * Names only the MAPPING, unhedged — unlike that shutdown report, which must also hedge about the ACL
 * grant. On the leak this closes, a rejected `establish` cannot have left one: provisioning is its last
 * fallible step and records only after its write succeeds, so `teardown` skips the revert entirely and
 * drives a purely local `tailscale serve … off`. That is also why this is not time-boxed the way the
 * shutdown release is — no third-party API round-trip on this path to budget against.
 *
 * That precision is a property of WHAT can reject, though, not of this function — worth stating because
 * the caller's `try` spans `establishAndReport`, the establish PLUS the reporting after it. A step that
 * threw AFTER a successful establish would arrive here with a grant already recorded: `teardown` would
 * revert it over the API, unbudgeted, and this message would name half of what was left behind. No such
 * step exists today — the reporting is string concatenation and a QR encode whose only failure mode is a
 * payload orders of magnitude past a ~96-char pairing URL — and releasing there would still be RIGHT
 * (the daemon is coming down either way, so a fully-up tunnel pointing at a closed port is the worse
 * outcome). But a fallible step added later inherits both gaps: give this the budget
 * `shutdown-signal.ts` gives its own release, and hedge this message about the grant.
 */
async function releaseFailedEstablish(tunnel: Tunnel, kind: TunnelKind): Promise<void> {
  try {
    await tunnel.teardown();
  } catch (error) {
    console.error(
      `ccctl: could not release the half-up ${kind} tunnel — its serve mapping may still be in place; ` +
        `clear it with \`ccctl tunnel ${kind} --off\`: ${reasonOf(error)}`,
    );
  }
}

/**
 * Close the daemon a failed `serve --tunnel` establish is abandoning — the second half of that
 * unwind, and {@link releaseFailedEstablish}'s sibling in every respect that matters.
 *
 * Reports rather than throws, for the identical reason: `close` is a cleanup step, and a cleanup
 * failure must not become the answer to "why could the tunnel not be established". It is the SAME
 * masking #255's AC names for the release — reached one step later, through `close` rather than
 * `teardown` — so it gets the same treatment rather than a careful non-masking release two lines
 * above a silent one. `@ccctl/server`'s shutdown floor already settles this shape the same way: each
 * step reported and survived independently, neither failure skipping or standing in for the other.
 *
 * A rejected `close` is worth naming loudly, which is why it is reported and not swallowed silently:
 * the process was relying on that close to stop the listening socket from holding it open, so a
 * failure here is exactly when `ccctl` exits non-zero and then does not exit at all.
 */
async function closeFailedServe(server: CcctlServer): Promise<void> {
  try {
    await server.close();
  } catch (error) {
    console.error(
      `ccctl: could not close the daemon after the tunnel failed — it may still be listening; ` +
        `stop it with ${SHUTDOWN_SIGNALS.join(" / ")} (Ctrl-C, or \`kill ${process.pid}\`): ${reasonOf(error)}`,
    );
  }
}

/**
 * Take a previously-established tunnel down (`ccctl tunnel <kind> --off`, #242) — the revert half of
 * the fire-and-forget `tunnel` verb, and the one the ACL grant needs: turn the mapping off and remove
 * the grant the establish appended.
 *
 * Works ACROSS processes, which is the whole point. `tailscale serve --bg` is detached and outlives the
 * `ccctl tunnel` that created it, so this runs with none of that establish's in-process lifecycle state
 * — it rebuilds the release handles via {@link https://ccctl | Tunnel.adopt} from the same two
 * operator-supplied inputs the establish used: the endpoint (the same `--host`/`--port`, which is why
 * they live on the one verb) and the declared grant (the same `CCCTL_TAILSCALE_ACL_GRANT`, resolved by
 * the same composition root). Give it a different endpoint than you served and it targets a different
 * mapping — the adapter tears down what it is told to, exactly as `tailscale serve … off` does.
 *
 * No QR / pairing block, unlike {@link establishAndReport}: nothing has been exposed, so there is no
 * device to onboard. A rejected teardown propagates (the adapter leaves the tunnel established and
 * retryable, so a retry is the operator's next move) and `cli.ts` turns it into a non-zero exit.
 */
async function tearDownAndReport(deps: CliDependencies, kind: TunnelKind, local: HostEndpoint): Promise<void> {
  const tunnel = deps.adapters[kind]();
  tunnel.adopt(local);
  await tunnel.teardown();
  console.log(
    `ccctl: ${kind} tunnel for ${serverUrl(local.host, local.port)} is down — any ACL grant it provisioned is removed.`,
  );
}

/**
 * Narrow an operator-supplied permission mode to a {@link PermissionMode}, failing closed on an
 * unknown one — the same fail-fast, no-side-effects discipline as {@link parsePort} /
 * {@link requireTunnelKind}, so a typo is a clear upfront error BEFORE any network round-trip
 * rather than a daemon-side `400`. The accepted set is the pinned `@ccctl/core` one, so it never
 * drifts from what a launch actually honors.
 */
function requirePermissionMode(value: string): PermissionMode {
  if (!isPermissionMode(value)) {
    throw new Error(`ccctl: invalid permission mode "${value}" — expected one of ${PERMISSION_MODES.join(", ")}`);
  }
  return value;
}

/**
 * Render a session's derived {@link SessionActivity} as a one-line phrase for the `attach` listing
 * and single-session selection. Exhaustive over the union so a new activity kind is a compile error
 * here rather than a silently-dropped state.
 */
function describeActivity(activity: SessionActivity): string {
  switch (activity.kind) {
    case "running":
      return "running";
    case "requires_action":
      return `requires action — ${activity.detail}`;
    case "idle":
      return "idle";
  }
}

/**
 * Render an accepted stop (#77) as the operator's one-line answer: WHICH session is over, on WHICH
 * daemon, HOW it ended, and the terminal state it reached — the AC's "reflect the resulting terminal
 * state", carried from the daemon rather than asserted here.
 *
 * The two outcomes stay distinct sentences because they are different FACTS: we killed it, or it was
 * already gone and there was nothing left to kill. Both are what the operator asked for; only one of
 * them is a kill, and the daemon is careful not to claim the other is.
 *
 * Names the daemon in every branch, like `attach`'s sentences: `--host`/`--port` exist because there
 * can be more than one, and "which one answered" is not a detail to the operator who is killing a
 * runaway.
 *
 * An outcome this build does not recognize gets a neutral third sentence rather than being folded
 * into `already-exited`: `ccctl` can be older than the daemon it drives, and "it had already exited"
 * is a specific claim about what happened — the kind this verb must not invent. The web UI's reader
 * degrades identically (`@ccctl/web-ui`'s `describeStopAccepted`), which is the same contract read
 * the same way on both surfaces rather than two guesses.
 */
function describeStopAccepted(stopped: StopAcceptedWire, where: string): string {
  switch (stopped.outcome) {
    case "stopped":
      return `stopped session ${stopped.sessionId} on ${where} — ${stopped.status}`;
    case "already-exited":
      return `session ${stopped.sessionId} on ${where} had already exited — ${stopped.status}`;
    default:
      return `session ${stopped.sessionId} on ${where} is stopped — ${stopped.status}`;
  }
}

/**
 * The three steer verbs the daemon maps to worker frames, mirrored from the server's steer contract
 * (`ui-command.ts`) and the web UI (`@ccctl/web-ui`'s `command.js`): `prompt` sends input as a user
 * turn, `approve` clears a pending action, `interrupt` redirects the current turn. Held here (not
 * imported from `@ccctl/core`, which pins only `prompt`) so the CLI and the browser steer one
 * vocabulary. Each string is ALSO the `ccctl steer` flag name (`--prompt` / `--approve` /
 * `--interrupt`), so the echoed subtype reads back as the flag the operator typed.
 */
const STEER_PROMPT_SUBTYPE = "prompt";
const STEER_APPROVE_SUBTYPE = "approve";
const STEER_INTERRUPT_SUBTYPE = "interrupt";

/** The verb flags a `ccctl steer` invocation carries — exactly one selects the steer; see {@link requireSteerCommand}. */
interface SteerFlags {
  readonly prompt?: string;
  readonly approve?: boolean;
  readonly toolUseId?: string;
  readonly interrupt?: string;
}

/**
 * Narrow a steer's text argument to a non-empty string, failing closed on a blank one BEFORE any
 * network round-trip — the same fail-fast discipline the other verbs apply (an empty steer is a
 * daemon `400` anyway). The operator's exact text is preserved (only whitespace-only is rejected),
 * so leading/trailing spacing they intended in a prompt survives to the worker.
 */
function requireSteerText(value: string, flag: string): string {
  if (value.trim() === "") {
    throw new Error(`ccctl: ${flag} requires non-empty text`);
  }
  return value;
}

/**
 * Build the ONE steer a `ccctl steer` invocation carries from its verb flags, or fail closed BEFORE
 * any network round-trip. EXACTLY one of `--prompt` / `--approve` / `--interrupt` is required — zero
 * is nothing to steer, two is ambiguous — and `--tool-use-id` only qualifies `--approve` (it names
 * WHICH pending action to clear). Mirrors the web UI's per-verb command builders, collapsed to the
 * CLI's single-invocation shape.
 */
function requireSteerCommand(flags: SteerFlags): SteerCommand {
  const verbCount = [flags.prompt !== undefined, flags.approve === true, flags.interrupt !== undefined].filter(
    Boolean,
  ).length;
  if (verbCount === 0) {
    throw new Error("ccctl: steer requires one of --prompt <text>, --approve, or --interrupt <reason>");
  }
  if (verbCount > 1) {
    throw new Error("ccctl: steer takes exactly one of --prompt, --approve, or --interrupt");
  }
  if (flags.toolUseId !== undefined && flags.approve !== true) {
    throw new Error("ccctl: --tool-use-id is only valid with --approve");
  }
  if (flags.prompt !== undefined) {
    return { subtype: STEER_PROMPT_SUBTYPE, payload: { text: requireSteerText(flags.prompt, "--prompt") } };
  }
  if (flags.interrupt !== undefined) {
    return { subtype: STEER_INTERRUPT_SUBTYPE, payload: { reason: requireSteerText(flags.interrupt, "--interrupt") } };
  }
  // `approve` is the only verb with no required argument; `--tool-use-id`, when given, names WHICH
  // pending action to clear (omitted → the single pending one, matching the web UI's payload-less approve).
  return flags.toolUseId === undefined
    ? { subtype: STEER_APPROVE_SUBTYPE }
    : { subtype: STEER_APPROVE_SUBTYPE, payload: { toolUseId: flags.toolUseId } };
}

/**
 * Build the `ccctl` command tree. `deps` are the injectable I/O seams (defaulting to
 * the real daemon / tunnels / patcher); a test passes fakes so the verbs are exercised
 * without binding a socket or spawning a process. Exposed for testing and `cli.ts`.
 */
export function buildProgram(deps: CliDependencies = defaultDependencies): Command {
  const program = new Command();
  // Positional options let the `patch` verb pass unknown flags through to the patcher
  // (see its command below); it is a no-op for `serve` / `tunnel`, whose options sit
  // after the subcommand name.
  program.enablePositionalOptions();

  program.name("ccctl").description("Self-hosted control plane for Claude Code").version("0.0.0");

  const tunnelChoices = Object.keys(deps.adapters).join(" | ");

  // --- patch: delegate to the external patcher --------------------------------------
  program
    .command("patch")
    .description("Prepare the patched Claude Code worker by delegating to the ccctl-patch binary")
    .argument("[patcherArgs...]", "arguments forwarded verbatim to ccctl-patch (use `--` before flags)")
    .allowUnknownOption()
    .passThroughOptions()
    .action((patcherArgs: string[]) => {
      // The patcher owns "prepare the binary"; the CLI only delegates. Returning the
      // promise lets `cli.ts` surface a patcher failure as a non-zero exit.
      return deps.runPatcher(patcherArgs);
    });

  // --- serve: start the daemon (optionally behind a tunnel) -------------------------
  program
    .command("serve")
    .description("Start the local control-plane server, optionally behind a tunnel")
    .option("-p, --port <port>", "loopback port to bind", "4321")
    .option("--host <host>", "bind host", DEFAULT_HOST)
    .option("-t, --tunnel <kind>", `expose via a tunnel (${tunnelChoices})`)
    .action(async (options: { port: string; host: string; tunnel?: string }) => {
      // Baseline security guards run BEFORE anything binds (#14). Refuse-start-without-auth:
      // with no configured local-server auth the daemon refuses to start — this throw
      // propagates to `cli.ts`, which sets a non-zero exit code. Localhost-bind: refuse the
      // `0.0.0.0` wildcard so nothing is exposed off-box. Both are the server's own invariants
      // (@ccctl/server); the daemon only applies them.
      requireLocalServerAuth();
      const host = resolveBindHost(options.host);
      // Validate the tunnel choice up front, before binding, so an unknown one fails fast
      // with no side effects.
      const kind = options.tunnel === undefined ? undefined : requireTunnelKind(deps.adapters, options.tunnel);
      const port = parsePort(options.port);

      // Inject the session launcher so a `POST /api/sessions` "New session" (UC2) actually spawns
      // the PATCHED `claude` worker (#157) — without it the daemon tracks sessions but fails a launch
      // closed with a 501. The launcher is a seam so a test drives `serve` without a real tmux/worker.
      //
      // Inject the structured-log sink (#61) so the daemon actually EMITS its diagnostic trail — one
      // JSON line per session-lifecycle / registration / detection / notification / error event, enough
      // to diagnose a stalled or leaked long-running daemon. Absent this the server falls back to the
      // no-op sink; the daemon is the composition root that turns the trail on. The `LogEvent` shape is
      // JSON-safe by construction, so no credential (account Bearer, session-ingress token) can ride it.
      // One structured-log sink for the whole daemon: the server's diagnostic trail (#61) AND the
      // on-demand heap-snapshot events (#62) ride the same JSON-lines stdout, so both are `… | jq`-able.
      const logger = createJsonLineLogger();
      const server = await deps.startServer({
        host,
        port,
        launcher: deps.launcher,
        logger,
      });
      // The tunnel this daemon owns, once it is up (#242). Retained — rather than dropped the moment
      // `establish` returned, which left nothing able to call `teardown` — because the daemon owns the
      // tunnel's lifetime and so owns its teardown: the shutdown handler below reads this on its way
      // out to release the mapping AND remove any ACL grant the adapter provisioned for it.
      let tunnel: Tunnel | null = null;
      // The establish while it is IN FLIGHT, and only then (#259) — the one state `tunnel` alone cannot
      // express. "No tunnel yet" and "no tunnel ever" both read as `null` on that variable, but only the
      // first has something to release: `TailscaleTunnel.establish` records its serve mapping the moment
      // `tailscale serve --bg` lands, BEFORE the slow `tailscale status --json` and any ACL write. This
      // tells the two apart, so the shutdown thunk below can answer "wait and see" instead of "nothing".
      let establishing: Promise<void> | null = null;
      // Arm the on-demand heap-snapshot trigger (#62): SIGUSR2 dumps a LIVE snapshot without a restart,
      // reachable only by a same-uid local process (OS-enforced local auth — unreachable off-box). The
      // disposer is intentionally not held: the handler lives for the daemon's lifetime and process exit
      // tears it down.
      deps.installHeapSnapshotHandler({ logger });
      // Arm the on-demand inspector-attach + FD/handle-count diagnostics trigger (#63): SIGUSR1 samples
      // the daemon's active FD/handle counts onto the trail, reads the unref'd-TIMER census the ref'd
      // tally cannot see (#238 — armed lazily on the first poke, so an undiagnosed daemon pays no
      // async_hooks cost), AND attaches the loopback-bound Node inspector for deeper diagnosis —
      // reachable only by a same-uid local process (OS-enforced local auth, the same choice as the heap
      // snapshot). Same one shared #61 sink; disposer not held (the handler lives for the daemon's
      // lifetime and process exit tears it down, which disposes the census with it).
      deps.installInspectorDiagnosticsHandler({ logger });
      // Arm the local-shutdown floor (#82): SIGTERM/SIGINT gracefully closes the daemon — releasing
      // every session this server owns, then releasing the tunnel that exposed it (#242, best-effort and
      // time-boxed so the floor is never gated on a third-party API) — and exits, an OS-signal control
      // unreachable over the tunnel and needing no device token (the "stop the server from the local
      // machine" half of the floor, sibling to `ccctl revoke-all`). Armed AFTER the server binds so there
      // is a bound server to close, but deliberately BEFORE the tunnel is established, so a Ctrl-C during
      // a slow establish still shuts down gracefully — hence the tunnel is passed as a thunk the handler
      // resolves at SIGNAL time. The disposer is intentionally not held (the handler lives for the
      // daemon's lifetime and process exit tears it down), matching the two diagnostic handlers above.
      //
      // The thunk answers WHAT THE DAEMON OWNS — and, while an establish is IN FLIGHT, a releaser that
      // WAITS TO FIND OUT (#259, the window `establishing` above describes). A signal there released
      // nothing and exited `0`, stranding the mapping on the port it had just closed.
      //
      // It WAITS rather than releasing the half-up instance directly, because the establish is still
      // WRITING the state a teardown must read. `teardown` decides the ACL revert from a synchronous
      // read of the grant the adapter records only AFTER its policy write lands — so a teardown racing a
      // provision reads `null`, skips the revert, and lets the write it never saw survive as an orphaned
      // grant, a worse leak than the mapping this closes. Waiting orders the two: the establish finishes
      // recording, THEN the teardown reads. #82's floor is not gated on it — the shutdown races this
      // whole releaser against its own teardown budget, so a wedged establish is reported as
      // `tunnel-teardown-failed` and the daemon still exits.
      deps.installShutdownHandler({
        server,
        logger,
        tunnel: () => {
          const inFlight = establishing;
          if (inFlight === null) {
            return tunnel;
          }
          return {
            teardown: async () => {
              // SETTLEMENT, not success: a rejected establish leaves a half-up serve just as releasable
              // (#255's whole point), and the establish error is that path's to report, never this
              // one's — so it is swallowed here and the release runs on both outcomes.
              await inFlight.catch(() => undefined);
              // Whatever the establish turned out to own: the tunnel it landed, or nothing when it
              // failed. Nothing is the RIGHT answer there rather than a gap — the `catch` below is
              // already releasing that instance inline (#255), so `tunnel` staying `null` is exactly
              // what keeps this from becoming a second concurrent `serve … off` on the same mapping.
              await tunnel?.teardown();
            },
          };
        },
      });
      // Report the address actually bound (`server.address` carries the resolved port,
      // which matters when `--port 0` selects an ephemeral one).
      console.log(`ccctl: serving on ${serverUrl(server.address.host, server.address.port)}`);
      // One-time operator hints (plain text, printed before the JSON trail flows — like the line above):
      // how to take a heap snapshot and where it lands (the file is written owner-only 0600 because it
      // holds process memory), and how to attach the inspector / dump FD-handle counts / read the timer
      // census for a leak hunt. The census's "poke twice" is the one instruction an operator CANNOT infer
      // and would otherwise misread: the first poke ARMS it (async_hooks reports nothing it was not yet
      // listening for), so that poke's census reads ~0 on a daemon full of timers. Naming the action —
      // poke again — rather than the mechanism keeps the hint actionable.
      console.log(
        `ccctl: heap snapshot on ${HEAP_SNAPSHOT_SIGNAL} (\`kill -s ${HEAP_SNAPSHOT_SIGNAL} ${process.pid}\`) → ${resolveHeapSnapshotDir()}`,
      );
      console.log(
        `ccctl: inspector attach + FD/handle report + timer census on ${INSPECTOR_DIAGNOSTICS_SIGNAL} (\`kill -s ${INSPECTOR_DIAGNOSTICS_SIGNAL} ${process.pid}\`) → loopback inspector URL + counts on the trail`,
      );
      console.log(
        `ccctl: the first ${INSPECTOR_DIAGNOSTICS_SIGNAL} arms the timer census — poke again later to read an accumulation`,
      );
      // The local-control floor (#82): how to stop the daemon from the box — a graceful shutdown on
      // Ctrl-C or SIGTERM that needs no device token and is unreachable over the tunnel. Paired with
      // `ccctl revoke-all`, it is the always-available local recovery even with a lost/all-revoked phone.
      console.log(
        `ccctl: stop the daemon with ${SHUTDOWN_SIGNALS.join(" / ")} (Ctrl-C, or \`kill ${process.pid}\`) → graceful local shutdown, no device token needed`,
      );

      if (kind !== undefined) {
        // Expose the bound endpoint through the chosen tunnel. If it cannot be established, release
        // whatever the half-up establish left behind AND tear the daemon back down, rather than leave
        // either behind: the server's listening socket would otherwise keep the process alive with the
        // exit code set but never applied, and the serve mapping would outlive the port it points at.
        // `--tunnel` is atomic — both come up, or it fails clean — and #255 is what made the mapping
        // half of that claim true.
        //
        // Constructed HERE rather than inside `establishAndReport` (#255): the daemon owns this
        // tunnel's lifetime, and a handle that only arrives on the success path cannot release a
        // failure.
        const exposing = deps.adapters[kind]();
        // Published BEFORE it is awaited, so the thunk armed above can see an establish is running from
        // its first tick (#259) — the window the signal races is open the moment this starts.
        establishing = establishAndReport(deps, exposing, server.address);
        try {
          await establishing;
          // Retained for the shutdown handler armed above — assigned only on success, so a failed
          // establish leaves the thunk answering `null`. Nothing is lost by that: the daemon never owns a
          // tunnel it could not establish, because the catch below releases it inline and the process is
          // on its way out. Handing the shutdown path a released instance would be harmless — a teardown
          // no-ops once its state is cleared — but it would claim an ownership that never existed.
          tunnel = exposing;
        } catch (error) {
          // Unwind in reverse, then rethrow the establish error UNTOUCHED. Release BEFORE closing is
          // plain LIFO, and free here: the shutdown path closes FIRST only because ITS teardown is a
          // network round-trip #82's floor must not be gated on (`shutdown-signal.ts`), while this
          // release is purely local (see `releaseFailedEstablish`). Neither order is a safety question —
          // a mapping pointing at a closed port authorizes nobody, as that same header settles. What
          // matters is that BOTH steps run even if the other failed — a broken close is no reason to
          // strand a mapping, and vice versa — and that NEITHER throws: each reports its own failure, so
          // what propagates is always the establish error, the operator's actual answer, never a cleanup
          // failure standing in for it.
          await releaseFailedEstablish(exposing, kind);
          await closeFailedServe(server);
          throw error;
        } finally {
          // The establish is settled either way, so the thunk goes back to answering `tunnel` directly
          // (#259) — a releaser that waits on a promise already settled would only add a tick. Clearing
          // it cannot strand a signal that arrived mid-establish: that thunk call already CAPTURED the
          // promise, and its continuation was registered after this block's, so `tunnel` is assigned
          // before the waiter resumes to read it.
          establishing = null;
        }
      }

      // The listening socket keeps the process alive; there is nothing more to do here.
    });

  // --- tunnel: establish a tunnel to an already-running server (or take one down) ---
  //
  // The verb stays FIRE-AND-FORGET (#242): `tailscale serve --bg` is a DETACHED mapping that is meant
  // to outlive the command, so `ccctl tunnel` establishes it and exits — it does not hold the tunnel
  // open and tear it down on Ctrl-C. Bracketing its own lifetime would make it a blocking verb, which
  // is a different verb with different semantics (and `serve --tunnel` is already the one that holds a
  // tunnel for as long as something is being served). The revert half is `--off` instead: the same verb
  // with the SAME `--host`/`--port`, because the off-target must name the mapping the establish made —
  // which is also why the two share one option surface rather than living in a separate `tunnel down`.
  program
    .command("tunnel")
    .description("Establish a tunnel exposing an already-running loopback server, or take one down (--off)")
    .argument("<kind>", `tunnel backend (${tunnelChoices})`)
    .option("-p, --port <port>", "loopback port the server is on", "4321")
    .option("--host <host>", "loopback host the server is on", DEFAULT_HOST)
    .option("--off", "take the tunnel down instead: release the mapping and remove the ACL grant it provisioned")
    .action(async (kindArg: string, options: { port: string; host: string; off?: boolean }) => {
      const kind = requireTunnelKind(deps.adapters, kindArg);
      const host = resolveBindHost(options.host);
      const port = parsePort(options.port);

      if (options.off === true) {
        await tearDownAndReport(deps, kind, { host, port });
        return;
      }
      // Fire-and-forget: the mapping is detached and outlives this process, so the tunnel instance is
      // deliberately not retained — `--off` (above) rebuilds what it needs to release it. Nothing here
      // could hold it anyway: the verb has no listening socket and the process exits on return. Hence
      // no `releaseFailedEstablish` here, unlike `serve --tunnel` (#255): that verb releases because it
      // is tearing its own daemon back down and promises atomicity; this one exposes a server it does
      // not own and cannot assume the operator wants a mapping cleared on its way out.
      await establishAndReport(deps, deps.adapters[kind](), { host, port });
    });

  // --- launch: drive a UC2 "New session" launch on a running daemon -----------------
  program
    .command("launch")
    .description("Launch a new session (UC2) on a running ccctl daemon and report how to attach it")
    .option("-p, --port <port>", "loopback port the daemon is on", "4321")
    .option("--host <host>", "loopback host the daemon is on", DEFAULT_HOST)
    .option("--cwd <path>", "working directory to root the session at", process.cwd())
    .option("-m, --permission-mode <mode>", `permission mode (${PERMISSION_MODES.join(" | ")})`, "default")
    .option("--project <name>", "logical project label carried to the session surface")
    .option("--initial-prompt <text>", "seed the session with a first prompt")
    .action(
      async (options: {
        port: string;
        host: string;
        cwd: string;
        permissionMode: string;
        project?: string;
        initialPrompt?: string;
      }) => {
        // Validate every input up front — a bad host/port/mode fails fast with no network round-trip,
        // the same fail-closed-before-side-effects discipline `serve` applies before binding. The
        // optionals are OMITTED (not set to `undefined`) when absent, matching the daemon's launch
        // body under `exactOptionalPropertyTypes`.
        const target: HostEndpoint = { host: resolveBindHost(options.host), port: parsePort(options.port) };
        const launchOptions: SessionLaunchOptions = {
          cwd: options.cwd,
          permissionMode: requirePermissionMode(options.permissionMode),
          ...(options.project !== undefined ? { project: options.project } : {}),
          ...(options.initialPrompt !== undefined ? { initialPrompt: options.initialPrompt } : {}),
        };

        const accepted = await deps.sessionClient.launch(target, launchOptions);
        // Name the session it started (#33): the daemon mints the id AT launch and the session is
        // already listed (as `registering`), so the operator can address the row that is theirs
        // instead of guessing which of N it is.
        console.log(`ccctl: launched session ${accepted.sessionId} on ${serverUrl(target.host, target.port)}`);
        // The tmux backend is fully attachable (a concrete `tmux attach` line); the owned-pty
        // fallback surfaces its degradation instead of pretending otherwise — pass the daemon's
        // own hint through either way.
        console.log(
          accepted.attachable
            ? `ccctl: attach it with — ${accepted.hint}`
            : `ccctl: this surface is not fully attachable — ${accepted.hint}`,
        );
        // It is listed from birth, but it is not LIVE until its worker checks in over the bridge —
        // and if it never does, the daemon evicts it rather than leaving a ghost behind (#33).
        console.log("ccctl: it is `registering` until its worker checks in — `ccctl attach` shows its status.");
      },
    );

  // --- attach: the UC1 attach flow — list a running daemon's sessions, or select one ----------
  program
    .command("attach")
    .description("Attach to a running ccctl daemon's sessions: list them, or select one by id")
    .argument("[session-id]", "a session id to select (omit to list every session — the attach on-ramp)")
    .option("-p, --port <port>", "loopback port the daemon is on", "4321")
    .option("--host <host>", "loopback host the daemon is on", DEFAULT_HOST)
    .action(async (sessionId: string | undefined, options: { port: string; host: string }) => {
      const target: HostEndpoint = { host: resolveBindHost(options.host), port: parsePort(options.port) };
      // The list carries EVERY tracked session, whatever launched it — so a phone-driven session
      // and a `ccctl launch` one enumerate side by side here (the shared `/api/sessions` collection).
      const sessions = await deps.sessionClient.list(target);
      const where = serverUrl(target.host, target.port);

      // With an id: SELECT that one session — the on-ramp's "pick one to attach to" completion.
      // Resolved from the SAME shared list, so selecting a phone-driven session is identical to
      // selecting a CLI-launched one; a missing id fails closed rather than steering blind.
      if (sessionId !== undefined) {
        const selected = sessions.find((session) => session.id === sessionId);
        if (selected === undefined) {
          throw new Error(
            `ccctl: no session ${sessionId} on ${where} — run \`ccctl attach\` to see the running sessions.`,
          );
        }
        console.log(
          `ccctl: session ${selected.id} on ${where} — [${selected.status}] ${describeActivity(selected.activity)}`,
        );
        console.log(`ccctl: steer it with — ccctl steer ${selected.id} --prompt "…"`);
        return;
      }

      // With no id: LIST every session (the attach on-ramp).
      if (sessions.length === 0) {
        console.log(`ccctl: no sessions on ${where} yet — launch one with \`ccctl launch\`.`);
        return;
      }
      console.log(`ccctl: ${sessions.length} session${sessions.length === 1 ? "" : "s"} on ${where}:`);
      for (const session of sessions) {
        console.log(`  ${session.id}  [${session.status}] ${describeActivity(session.activity)}`);
      }
    });

  // --- steer: take over a selected session — push one steer verb at it ----------------
  program
    .command("steer")
    .description("Steer one session on a running daemon: send a prompt, approve, or interrupt")
    .argument("<session-id>", "the session to steer (from `ccctl attach`)")
    .option("-p, --port <port>", "loopback port the daemon is on", "4321")
    .option("--host <host>", "loopback host the daemon is on", DEFAULT_HOST)
    .option("--prompt <text>", "send input text to the session's current turn")
    .option("--approve", "approve the session's pending action")
    .option("--tool-use-id <id>", "which pending tool call to approve (with --approve)")
    .option("--interrupt <reason>", "redirect the current turn, with a reason")
    .action(
      // The verb flags ({@link SteerFlags}) plus the shared daemon-target options.
      async (sessionId: string, options: SteerFlags & { port: string; host: string }) => {
        // Resolve the steer verb first (a pure usage error, before any network), then the target —
        // both fail closed before the round-trip, matching the other verbs' validate-then-act order.
        const command = requireSteerCommand(options);
        const target: HostEndpoint = { host: resolveBindHost(options.host), port: parsePort(options.port) };

        const id = await deps.sessionClient.steer(target, sessionId, command);
        // Echo the wire subtype (which equals the flag the operator typed) and the daemon's minted
        // correlation id, so a successful steer is confirmed with a handle for the reply on the stream.
        console.log(`ccctl: steered ${sessionId} on ${serverUrl(target.host, target.port)} (${command.subtype}).`);
        console.log(`ccctl: the daemon accepted it (correlation ${id}).`);
      },
    );

  // --- stop: the emergency stop — kill one session's terminal outright -----------------
  program
    .command("stop")
    .description("Stop one session on a running daemon: kill its terminal and end the session")
    .argument("<session-id>", "the session to stop (from `ccctl attach`)")
    .option("-p, --port <port>", "loopback port the daemon is on", "4321")
    .option("--host <host>", "loopback host the daemon is on", DEFAULT_HOST)
    .option("--force", "stop it even if it has been taken over at a terminal, or its backend would not report on it")
    .action(async (sessionId: string, options: { port: string; host: string; force?: boolean }) => {
      const target: HostEndpoint = { host: resolveBindHost(options.host), port: parsePort(options.port) };
      // `--force` is a boolean flag, so commander gives `true` when present and `undefined` when not;
      // normalized to a literal boolean because the daemon's parse REFUSES a non-boolean rather than
      // coercing it (`undefined` would serialize the key away, which happens to be right, but relying
      // on that would make the destructive field's correctness an accident of JSON.stringify).
      const stopOptions: SessionStopOptions = { force: options.force === true };

      const stopped = await deps.sessionClient.stop(target, sessionId, stopOptions);
      console.log(`ccctl: ${describeStopAccepted(stopped, serverUrl(target.host, target.port))}`);
    });

  // --- revoke-all: the panic kill — revoke every paired device at once -------------------
  program
    .command("revoke-all")
    .description("Revoke every paired device at once (panic kill) — invalidate all device tokens and force re-pairing")
    .action(async () => {
      // Adapter-agnostic AND daemon-independent by design: operate directly on the server-side
      // device store (no tunnel adapter, no running daemon or network round-trip), which is exactly
      // what makes this a robust panic control — it works even when the daemon or its tunnel is down.
      // Emptying the registry drops every device's at-rest token hash, so every existing token is
      // refused on next use and every device must re-pair. Unlike `ccctl stop <id>` (one session) or
      // per-device revoke, this wipes ALL paired devices in one action.
      const revoked = await revokeAllPairedDevices(deps.deviceStore);
      if (revoked === 0) {
        console.log("ccctl: no devices are paired — nothing to revoke.");
        return;
      }
      console.log(
        `ccctl: revoked ${revoked} device${revoked === 1 ? "" : "s"} — every device must re-pair (scan a fresh QR from \`ccctl serve --tunnel\` / \`ccctl tunnel\`).`,
      );
    });

  return program;
}
