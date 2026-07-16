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
 *     tunnel to an already-running loopback server.
 *
 * Composed, they are the working local setup: `patch` the worker, `serve` the daemon,
 * and expose it via a `tunnel`. `serve` still enforces the baseline startup guards
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
  type SessionLaunchOptions,
  type SessionStopOptions,
  type StopAcceptedWire,
} from "@ccctl/server";
import type { TunnelKind } from "@ccctl/tunnel-adapters";
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
 */
async function establishAndReport(deps: CliDependencies, kind: TunnelKind, local: HostEndpoint): Promise<void> {
  const established = await deps.adapters[kind]().establish(local);
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
      // Arm the on-demand heap-snapshot trigger (#62): SIGUSR2 dumps a LIVE snapshot without a restart,
      // reachable only by a same-uid local process (OS-enforced local auth — unreachable off-box). The
      // disposer is intentionally not held: the handler lives for the daemon's lifetime and process exit
      // tears it down.
      deps.installHeapSnapshotHandler({ logger });
      // Arm the on-demand inspector-attach + FD/handle-count diagnostics trigger (#63): SIGUSR1 samples
      // the daemon's active FD/handle counts onto the trail AND attaches the loopback-bound Node
      // inspector for deeper diagnosis — reachable only by a same-uid local process (OS-enforced local
      // auth, the same choice as the heap snapshot). Same one shared #61 sink; disposer not held (the
      // handler lives for the daemon's lifetime and process exit tears it down).
      deps.installInspectorDiagnosticsHandler({ logger });
      // Arm the local-shutdown floor (#82): SIGTERM/SIGINT gracefully closes the daemon — releasing
      // every session this server owns — and exits, an OS-signal control unreachable over the tunnel
      // and needing no device token (the "stop the server from the local machine" half of the floor,
      // sibling to `ccctl revoke-all`). Armed AFTER the server binds so there is a bound server to
      // close; the disposer is intentionally not held (the handler lives for the daemon's lifetime and
      // process exit tears it down), matching the two diagnostic handlers above.
      deps.installShutdownHandler({ server, logger });
      // Report the address actually bound (`server.address` carries the resolved port,
      // which matters when `--port 0` selects an ephemeral one).
      console.log(`ccctl: serving on ${serverUrl(server.address.host, server.address.port)}`);
      // One-time operator hints (plain text, printed before the JSON trail flows — like the line above):
      // how to take a heap snapshot and where it lands (the file is written owner-only 0600 because it
      // holds process memory), and how to attach the inspector / dump FD-handle counts for a leak hunt.
      console.log(
        `ccctl: heap snapshot on ${HEAP_SNAPSHOT_SIGNAL} (\`kill -s ${HEAP_SNAPSHOT_SIGNAL} ${process.pid}\`) → ${resolveHeapSnapshotDir()}`,
      );
      console.log(
        `ccctl: inspector attach + FD/handle report on ${INSPECTOR_DIAGNOSTICS_SIGNAL} (\`kill -s ${INSPECTOR_DIAGNOSTICS_SIGNAL} ${process.pid}\`) → loopback inspector URL + counts on the trail`,
      );
      // The local-control floor (#82): how to stop the daemon from the box — a graceful shutdown on
      // Ctrl-C or SIGTERM that needs no device token and is unreachable over the tunnel. Paired with
      // `ccctl revoke-all`, it is the always-available local recovery even with a lost/all-revoked phone.
      console.log(
        `ccctl: stop the daemon with ${SHUTDOWN_SIGNALS.join(" / ")} (Ctrl-C, or \`kill ${process.pid}\`) → graceful local shutdown, no device token needed`,
      );

      if (kind !== undefined) {
        // Expose the bound endpoint through the chosen tunnel. If it cannot be established, tear
        // the daemon back down rather than leave a half-up, loopback-only server running — its
        // listening socket would otherwise keep the process alive with the exit code set but never
        // applied. `--tunnel` is atomic: both come up, or it fails clean.
        try {
          await establishAndReport(deps, kind, server.address);
        } catch (error) {
          await server.close();
          throw error;
        }
      }

      // The listening socket keeps the process alive; there is nothing more to do here.
    });

  // --- tunnel: establish a tunnel to an already-running server ----------------------
  program
    .command("tunnel")
    .description("Establish a tunnel exposing an already-running loopback server")
    .argument("<kind>", `tunnel backend (${tunnelChoices})`)
    .option("-p, --port <port>", "loopback port the server is on", "4321")
    .option("--host <host>", "loopback host the server is on", DEFAULT_HOST)
    .action(async (kindArg: string, options: { port: string; host: string }) => {
      const kind = requireTunnelKind(deps.adapters, kindArg);
      const host = resolveBindHost(options.host);
      const port = parsePort(options.port);

      await establishAndReport(deps, kind, { host, port });
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
    .option("--force", "stop it even if it has been taken over at a terminal")
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
