// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createTmuxSessionLauncher,
  defaultWorkerBinaryProbe,
  readWindowLiveness,
  type TmuxRunner,
  type WorkerBinaryProbe,
  type WorkerCommandFactory,
} from "./session-launcher-tmux.js";
import { SessionLaunchError, type SessionLaunchOptions } from "./session-launcher.js";

// #29 is the tmux backend of the #28 `ISessionLauncher` port. The one impure edge (spawning
// `tmux`) is behind the injectable `TmuxRunner` seam, so these tests drive the FULL
// orchestration — ensure-session → new-window → attach hint → teardown — hermetically, with a
// recording fake and NO real tmux, exactly as the port's own contract test uses in-memory
// fakes. They pin the three ACs: `new-window` launches the worker (AC1), the surface is
// natively attachable with a concrete `tmux attach` hint (AC2), and the launched worker is the
// caller-supplied, control-server-wired command whose registration (AC3) the fenced e2e
// live-worker oracle proves end-to-end (never faked here).

/** A recording fake `TmuxRunner`. Simulates each tmux subcommand; records every invocation. */
function makeFakeRunner(config?: {
  /** Whether `has-session` succeeds (the ccctl session already exists). Default: false (absent). */
  readonly sessionExists?: boolean;
  /** What `new-window -P -F` prints: `"<window-id> <session>:<index>"`. Default: `"@1 ccctl:1"`. */
  readonly newWindowTarget?: string;
  /**
   * What `list-windows -a -F` prints for the liveness probe (#35) — one `"<id> <session> <attached>"`
   * line per window. Default: the launched `@1` alive in a detached `ccctl` session (still ours).
   * The shape is transcribed from a REAL tmux 3.7b (see `session-launcher-tmux.ts` §
   * `TMUX_LIVENESS_FORMAT`), not invented here.
   */
  readonly listWindows?: string;
  /** Inject a failure for calls matching a subcommand (e.g. simulate tmux absent / window gone). */
  readonly failSubcommand?: { readonly sub: string; readonly error: Error };
}): { readonly runner: TmuxRunner; readonly calls: readonly string[][] } {
  const calls: string[][] = [];
  const sessionExists = config?.sessionExists ?? false;
  const target = config?.newWindowTarget ?? "@1 ccctl:1";
  const listWindows = config?.listWindows ?? "@1 ccctl 0";
  const runner: TmuxRunner = (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    const sub = args[0];
    if (config?.failSubcommand !== undefined && sub === config.failSubcommand.sub) {
      return Promise.reject(config.failSubcommand.error);
    }
    if (sub === "has-session") {
      return sessionExists ? Promise.resolve("") : Promise.reject(new Error("can't find session: ccctl"));
    }
    if (sub === "new-window") {
      return Promise.resolve(target);
    }
    if (sub === "list-windows") {
      return Promise.resolve(listWindows);
    }
    // new-session / kill-window / anything else: succeed with no output.
    return Promise.resolve("");
  };
  return { runner, calls };
}

/** A worker-command factory that threads every launch option into a recognizable patched argv. */
const workerCommand: WorkerCommandFactory = (options: SessionLaunchOptions): readonly string[] => [
  "claude-patched",
  "--permission-mode",
  options.permissionMode,
  ...(options.project !== undefined ? ["--project", options.project] : []),
  ...(options.initialPrompt !== undefined ? ["--prompt", options.initialPrompt] : []),
];

/** The worker binary is runnable — what the real probe answers for an installed patched `claude`. */
const workerBinaryFound: WorkerBinaryProbe = () => true;

/** All recorded calls for one tmux subcommand (`has-session`, `new-window`, …). */
function callsFor(calls: readonly string[][], sub: string): readonly string[][] {
  return calls.filter((call) => call[0] === sub);
}

/** Is a real tmux on this host? The integration test below needs one; everything above fakes it. */
const TMUX_INSTALLED = ((): boolean => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const REAL_TMUX_SESSION = `ccctl-it-${process.pid}`;

/** The session whose sole job is to hold a tmux window that ATTACHES to {@link REAL_TMUX_SESSION} (#35). */
const OUTER_TMUX_SESSION = `ccctl-it-outer-${process.pid}`;

/** A session standing in for the operator's OWN workspace — somewhere to `move-window` a surface to (#35). */
const ELSEWHERE_TMUX_SESSION = `ccctl-it-elsewhere-${process.pid}`;

// `.native` is load-bearing, and the first run of the node-based fixture worker below proved why: on
// macOS `tmpdir()` is `/var/folders/…`, a symlink to `/private/var/folders/…`, and the worker's
// `getcwd(3)` reports the latter. Canonicalizing the root makes the launch cwd the same spelling the
// kernel will report, so the assertion can be a bare string equality against ground truth with no
// normalization of its own — the production daemon hands the launcher exactly such a path, because
// `resolveLaunchCwd` (`pending-launch.ts`) canonicalizes before `launch()` is ever called.
const realTmuxRoot = TMUX_INSTALLED ? realpathSync.native(mkdtempSync(join(tmpdir(), "ccctl-tmux-it-"))) : "";

afterAll(() => {
  if (!TMUX_INSTALLED) {
    return;
  }
  for (const session of [OUTER_TMUX_SESSION, ELSEWHERE_TMUX_SESSION, REAL_TMUX_SESSION]) {
    try {
      execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
    } catch {
      // The session may never have been created, or already be gone — teardown is best-effort.
    }
  }
  rmSync(realTmuxRoot, { recursive: true, force: true });
});

// The ONE test in this file that hands its arguments to a REAL tmux — and the reason it exists is
// that everything above cannot. A fake `TmuxRunner` records the argv the backend builds; it cannot
// tell you what tmux DOES with that argv, and what tmux does with an unescaped format in `-c` is
// expand it, boot the worker in $HOME instead, and still report success. A fully green suite passed
// over that for three adversarial review rounds, because no test ever gave the real binary a chance
// to disagree with the fake.
//
// Skipped (not silently passed) where tmux is absent — the assertion is about tmux's behavior, and a
// host without tmux has nothing to assert against.
describe.skipIf(!TMUX_INSTALLED)("createTmuxSessionLauncher against a REAL tmux", () => {
  /**
   * A worker that reports its REAL `getcwd(3)` into `outFile` and lingers — the one fact the whole
   * launch↔registration correlation depends on, since the patched `claude` sends exactly this at §2.
   *
   * It must be a node child, NOT `sh -c 'pwd'`. `pwd` is a shell BUILTIN that prints `$PWD`, and tmux
   * SETS `PWD` in the child from its own `-c` argument — so a `pwd` fixture just echoes back the
   * string tmux was handed, and would agree with the launcher no matter how wrong the launcher was.
   * That is a tautology dressed as an integration test. `process.cwd()` asks the kernel.
   */
  function cwdReportingWorker(outFile: string): readonly string[] {
    return [
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(outFile)}, process.cwd()); setTimeout(() => {}, 5000);`,
    ];
  }

  /**
   * The window NAMES currently in the real ccctl test session — deliberately not the indices, which
   * are the very thing under test. `new-window -n` also pins the name (it disables tmux's
   * `automatic-rename`), so a window that is still open is still findable under the name it launched
   * with, no matter how tmux has since renumbered it.
   */
  function listWindows(): string[] {
    return execFileSync("tmux", ["list-windows", "-t", REAL_TMUX_SESSION, "-F", "#{window_name}"])
      .toString()
      .trim()
      .split("\n");
  }

  /** The durable `@id` of the window launched under `project` — the handle its liveness is keyed on (#35). */
  function windowIdNamed(project: string): string {
    const line = execFileSync("tmux", ["list-windows", "-a", "-F", "#{window_name} #{window_id}"])
      .toString()
      .trim()
      .split("\n")
      .find((entry) => entry.startsWith(`${project} `));
    if (line === undefined) {
      throw new Error(`ccctl test: no real tmux window named \`${project}\``);
    }
    return line.split(" ")[1] ?? "";
  }

  /**
   * Wait until tmux reports {@link REAL_TMUX_SESSION} as attached (or not) — polled, because a client
   * attaching is a THIRD process handshaking with the tmux server, so it is not observable the instant
   * `new-session` returns. Polling tmux's own answer beats sleeping a guess: it fails fast and loud on
   * a real regression instead of going flaky under load.
   */
  async function waitForAttachState(attached: boolean): Promise<void> {
    const want = attached ? "1" : "0";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const reading = execFileSync("tmux", [
        "display-message",
        "-p",
        "-t",
        REAL_TMUX_SESSION,
        "-F",
        "#{session_attached}",
      ])
        .toString()
        .trim();
      if (reading === want) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`ccctl test: tmux never reported session_attached=${want}`);
  }

  it("boots the worker in the cwd it was launched at, even when the path contains a tmux format", async () => {
    // `#S` — tmux's session-name format. The choice of directory name is load-bearing: `C#sharp` or
    // `issue#33` would prove NOTHING, because `#` before a non-format character passes through
    // untouched and the test would pass against the unescaped backend too. It has to be a `#` that
    // tmux would actually eat.
    const cwd = join(realTmuxRoot, "proj#Sales");
    mkdirSync(cwd);
    const reported = join(realTmuxRoot, "reported-cwd.txt");

    const launcher = createTmuxSessionLauncher({
      sessionName: REAL_TMUX_SESSION,
      workerCommand: (): readonly string[] => cwdReportingWorker(reported),
    });

    const session = await launcher.launch({ cwd, permissionMode: "default", project: "proj#Sales" });
    await new Promise((resolve) => setTimeout(resolve, 900));

    // The launched worker is where the server thinks it is. Without the escape this reads as the
    // operator's HOME (tmux expanded `#S`, got a path that does not exist, and fell back) — the
    // server's correlation key then never matches the cwd the worker reports at §2 registration, and
    // #33's eviction timer closes the terminal of a live, registered session ten seconds later.
    expect(readFileSync(reported, "utf8").trim()).toBe(cwd);
    expect(session.attachment.attachable).toBe(true);

    await session.close();
  });

  // tmux RENUMBERS window indices, so a captured `session:index` is not a durable handle — and this
  // backend's `close()` is what #33's eviction calls to reap a ghost. With a stale index, the reap
  // lands on whichever window now holds that number.
  //
  // The ORDER here is the whole test. Closing the FIRST window proves nothing: renumbering only shifts
  // the windows AFTER the one that closed, so a stale `:1` still names its original window and a
  // broken backend passes. The trigger has to shift the target — so an earlier ghost is evicted first,
  // which slides the LIVE session down into the index the second ghost was captured at. Reaping that
  // second ghost by index then kills the live session and leaves the ghost running: both ACs, exactly
  // inverted. Measured against a real tmux — this test failed on the `session:index` backend.
  //
  // `renumber-windows on` is a common `~/.tmux.conf` setting, and it makes eviction generate its own
  // trigger: every ghost reaped re-indexes every session after it.
  it("closes the window it launched, not whichever one now holds that index (tmux renumbers)", async () => {
    const launcher = createTmuxSessionLauncher({
      sessionName: REAL_TMUX_SESSION,
      workerCommand: (): readonly string[] => [process.execPath, "-e", "setTimeout(() => {}, 10000);"],
    });
    const launch = (project: string): Promise<{ close: () => Promise<void> }> =>
      launcher.launch({ cwd: realTmuxRoot, permissionMode: "default", project });

    execFileSync("tmux", ["set-option", "-t", REAL_TMUX_SESSION, "renumber-windows", "on"]);
    const firstGhost = await launch("first-ghost"); // index N
    const ghost = await launch("ghost"); // index N+1  ← the handle under test
    const live = await launch("live"); // index N+2  ← a registered session; must survive
    expect(listWindows()).toEqual(expect.arrayContaining(["first-ghost", "ghost", "live"]));

    // One ghost's eviction timer fires. Renumbering slides `ghost` and `live` each down by one — so
    // the index `ghost` was captured at (N+1) now names `live`.
    await firstGhost.close();

    // …and now the SECOND ghost is evicted. It must close the window IT opened.
    await ghost.close();

    const windows = listWindows();
    expect(windows).not.toContain("ghost"); // the ghost was reaped (AC2/AC3)…
    expect(windows).toContain("live"); // …and it was not the live session that died

    await live.close();
  });

  // The LIVENESS probe (#35) against the real binary — and this is the half that most needs it. The
  // fake runner above can only replay a string I wrote; it agrees with whatever I believed
  // `#{session_attached}` means. Only tmux can say. This is the same lesson the escaping test above
  // learned the hard way: a fully green suite proved nothing until the real binary was given a chance
  // to disagree.
  describe("liveness (#35)", () => {
    /** A launcher on the real ccctl test session, launching a worker that just lingers. */
    function realLauncher(): ReturnType<typeof createTmuxSessionLauncher> {
      return createTmuxSessionLauncher({
        sessionName: REAL_TMUX_SESSION,
        workerCommand: (): readonly string[] => [process.execPath, "-e", "setTimeout(() => {}, 10000);"],
      });
    }

    it("reads a launched, unattached window as `alive-server-owned` — nobody has taken it", async () => {
      const launched = await realLauncher().launch({ cwd: realTmuxRoot, permissionMode: "default", project: "owned" });

      // Ground truth: tmux really does report `#{session_attached}` as `0` for a session no client is
      // on. If it did not, this reads `taken-over` and teardown would never reap anything again.
      await expect(launched.liveness()).resolves.toBe("alive-server-owned");

      await launched.close();
    });

    it("reads a window whose session an operator has ATTACHED to as `taken-over` (AC2)", async () => {
      const launched = await realLauncher().launch({
        cwd: realTmuxRoot,
        permissionMode: "default",
        project: "attached",
      });
      expect(await launched.liveness()).toBe("alive-server-owned");

      // The operator sits down and attaches to the ccctl session. Staged with tmux itself as the pty —
      // `tmux attach` needs a terminal, and an outer tmux window IS one, which keeps this portable (no
      // node-pty, no platform-specific `script`). `TMUX=` is load-bearing: tmux refuses to nest a
      // client into a window that already has one, and unsetting it is how you say "yes, really".
      execFileSync("tmux", [
        "new-session",
        "-d",
        "-s",
        OUTER_TMUX_SESSION,
        `TMUX= tmux attach -t ${REAL_TMUX_SESSION}`,
      ]);
      await waitForAttachState(true);

      // THE SCENARIO: "a launched session the operator has attached to and is driving locally".
      await expect(launched.liveness()).resolves.toBe("taken-over");

      // …and when they detach, they have handed it back: the surface is the server's to reap again.
      execFileSync("tmux", ["kill-session", "-t", OUTER_TMUX_SESSION]);
      await waitForAttachState(false);
      await expect(launched.liveness()).resolves.toBe("alive-server-owned");

      await launched.close();
    });

    it("reads a window the operator MOVED out of the ccctl session as `taken-over`", async () => {
      const launched = await realLauncher().launch({ cwd: realTmuxRoot, permissionMode: "default", project: "moved" });
      const windowId = windowIdNamed("moved");

      // `move-window` into the operator's own workspace — a takeover stated about as plainly as tmux
      // lets one state it. The window is alive and findable (`-a` spans every session), but it is not
      // in ours, so it is not ours to reap.
      execFileSync("tmux", ["new-session", "-d", "-s", ELSEWHERE_TMUX_SESSION, "-n", "keep", "sleep 10"]);
      execFileSync("tmux", ["move-window", "-s", windowId, "-t", `${ELSEWHERE_TMUX_SESSION}:`]);

      await expect(launched.liveness()).resolves.toBe("taken-over");

      execFileSync("tmux", ["kill-session", "-t", ELSEWHERE_TMUX_SESSION]);
    });

    it("reads a window that is gone as `exited` — absence from the enumeration is the fact", async () => {
      const launched = await realLauncher().launch({ cwd: realTmuxRoot, permissionMode: "default", project: "gone" });
      const windowId = windowIdNamed("gone");

      // The operator closed the window (or the worker exited on its own).
      execFileSync("tmux", ["kill-window", "-t", windowId]);

      await expect(launched.liveness()).resolves.toBe("exited");
      // And teardown of it is the AC4 no-op: it completes, without error.
      await expect(launched.close()).resolves.toBeUndefined();
    });
  });
});

describe("createTmuxSessionLauncher (#29 tmux backend)", () => {
  it("AC1: `tmux new-window` launches the patched worker rooted at cwd, named after the project", async () => {
    const { runner, calls } = makeFakeRunner();
    const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });

    await launcher.launch({ cwd: "/work/atlas", permissionMode: "acceptEdits", project: "atlas" });

    const newWindow = callsFor(calls, "new-window");
    expect(newWindow).toHaveLength(1);
    expect(newWindow[0]).toEqual([
      "new-window",
      "-P",
      "-F",
      // The window ID (`@N`) leads: it is the handle `close()` and eviction fire at, and unlike the
      // human-readable `session:index` beside it, tmux never reassigns it.
      "#{window_id} #{session_name}:#{window_index}",
      "-c",
      "/work/atlas",
      "-n",
      "atlas",
      "claude-patched",
      "--permission-mode",
      "acceptEdits",
      "--project",
      "atlas",
    ]);
  });

  it("AC2: the surface is natively attachable, addressing the window by its durable id", async () => {
    const { runner } = makeFakeRunner({ newWindowTarget: "@7 ccctl:3" });
    const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });

    const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    // `select-window -t @7` then `attach -t ccctl`: the operator lands ON their session's window even
    // if tmux has renumbered it since launch. `attach -t ccctl:3` would be a stale coordinate.
    expect(session.attachment.attachable).toBe(true);
    expect(session.attachment.hint).toBe("tmux select-window -t @7 \\; attach -t ccctl");
  });

  // The liveness probe's WIRING (#35): the argv it asks tmux, that it keys on the window this launch
  // actually opened, and how it behaves when tmux cannot be asked at all. What the readings MEAN is
  // `readWindowLiveness`'s own block below; that they are true of a real tmux is the fenced block above.
  describe("liveness (#35)", () => {
    it("enumerates windows with `list-windows -a`, and asks tmux nothing else", async () => {
      const { runner, calls } = makeFakeRunner({ newWindowTarget: "@7 ccctl:3" });
      const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });
      const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

      await session.liveness();

      // `-a` spans every session, so a window the operator MOVED out of ours is still found (and read
      // as taken-over) rather than mistaken for gone. `display-message -t @7` is the shape NOT taken:
      // against a missing window it exits 0 with an empty answer, which cannot be told from "tmux said
      // nothing" — see `TMUX_LIVENESS_FORMAT`.
      expect(callsFor(calls, "list-windows")).toEqual([
        ["list-windows", "-a", "-F", "#{window_id} #{session_name} #{session_attached}"],
      ]);
      // A probe is a READ. It must never reach for a destructive verb.
      expect(callsFor(calls, "kill-window")).toEqual([]);
    });

    it("keys the reading on THIS launch's window id, not on another window in the same session", async () => {
      // `@7` is ours and quietly detached; `@1` is a sibling ccctl window whose session line says
      // attached. A probe that read the first line, or "any ccctl window", answers `taken-over` and
      // teardown never reaps anything again.
      const { runner } = makeFakeRunner({
        newWindowTarget: "@7 ccctl:3",
        listWindows: "@1 ccctl 1\n@7 ccctl 0",
      });
      const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });
      const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

      await expect(session.liveness()).resolves.toBe("alive-server-owned");
    });

    it("reads OUR configured session name, not the hardcoded default", async () => {
      // A launcher configured onto a non-default session must not read every window in it as moved-out.
      const { runner } = makeFakeRunner({ newWindowTarget: "@7 work:1", listWindows: "@7 work 0" });
      const launcher = createTmuxSessionLauncher({
        runner,
        workerCommand,
        workerBinaryProbe: workerBinaryFound,
        sessionName: "work",
      });
      const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

      await expect(session.liveness()).resolves.toBe("alive-server-owned");
    });

    it("answers `unknown` when tmux cannot be asked at all — never `alive-server-owned` (AC5)", async () => {
      // No tmux server is running (a real `list-windows` exits 1 there), the binary is gone, the socket
      // is unreachable. We do not know what became of this window — and a probe that cannot see must
      // never be optimized into permission to kill.
      const { runner } = makeFakeRunner({
        failSubcommand: { sub: "list-windows", error: new Error("no server running on /tmp/tmux-501/default") },
      });
      const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });
      const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

      // It RESOLVES `unknown` rather than rejecting: the reading is the backend's honest answer, not an
      // error for the release rule to interpret.
      await expect(session.liveness()).resolves.toBe("unknown");
    });

    it("re-probes on every call — a reading is never cached from launch", async () => {
      // The whole question is whether something CHANGED since launch (the operator attached, the window
      // died). A value captured at launch could only ever say what was true then.
      const readings = ["@7 ccctl 0", "@7 ccctl 1"];
      let call = 0;
      const runner: TmuxRunner = (args: readonly string[]): Promise<string> => {
        if (args[0] === "list-windows") {
          const reading = readings[call] ?? "";
          call += 1;
          return Promise.resolve(reading);
        }
        if (args[0] === "has-session") {
          return Promise.resolve("");
        }
        return Promise.resolve(args[0] === "new-window" ? "@7 ccctl:3" : "");
      };
      const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });
      const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

      expect(await session.liveness()).toBe("alive-server-owned");
      // The operator attached in between.
      expect(await session.liveness()).toBe("taken-over");
    });
  });

  it("passes every launch parameter through to the worker command — permission mode, project, initial prompt", async () => {
    const { runner, calls } = makeFakeRunner();
    const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });

    await launcher.launch({
      cwd: "/work/project",
      permissionMode: "bypassPermissions",
      project: "orion",
      initialPrompt: "start the failing test",
    });

    const [newWindow] = callsFor(calls, "new-window");
    // The worker argv (everything after `-n <name>`) carries mode, project, and prompt.
    expect(newWindow).toEqual(
      expect.arrayContaining([
        "claude-patched",
        "--permission-mode",
        "bypassPermissions",
        "--project",
        "orion",
        "--prompt",
        "start the failing test",
      ]),
    );
  });

  it("names the window with a default when the launch carries no project", async () => {
    const { runner, calls } = makeFakeRunner();
    const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });

    await launcher.launch({ cwd: "/repo", permissionMode: "plan" });

    const [newWindow] = callsFor(calls, "new-window");
    const nameFlagIndex = newWindow?.indexOf("-n") ?? -1;
    expect(newWindow?.[nameFlagIndex + 1]).toBe("claude");
  });

  it("creates the shared ccctl session on first launch (has-session absent → new-session -d)", async () => {
    const { runner, calls } = makeFakeRunner({ sessionExists: false });
    const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });

    await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    expect(callsFor(calls, "has-session")).toEqual([["has-session", "-t", "ccctl"]]);
    expect(callsFor(calls, "new-session")).toEqual([["new-session", "-d", "-s", "ccctl"]]);
    // Ordering: the session is ensured BEFORE the window is created inside it.
    const order = calls.map((call) => call[0]);
    expect(order.indexOf("new-session")).toBeLessThan(order.indexOf("new-window"));
  });

  it("reuses the ccctl session when it already exists (has-session ok → NO new-session)", async () => {
    const { runner, calls } = makeFakeRunner({ sessionExists: true });
    const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });

    await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    expect(callsFor(calls, "has-session")).toHaveLength(1);
    expect(callsFor(calls, "new-session")).toHaveLength(0);
    expect(callsFor(calls, "new-window")).toHaveLength(1);
  });

  it("tolerates a concurrent launch creating the ccctl session first (a benign new-session race)", async () => {
    // Two cold-start launches race: ours sees the session absent, but a sibling wins the
    // create before ours runs `new-session` (which then fails "duplicate"). A re-check finds
    // the session up, so the race is benign and the window is still created.
    let sessionUp = false;
    const calls: string[][] = [];
    const runner: TmuxRunner = (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      const sub = args[0];
      if (sub === "has-session") {
        return sessionUp ? Promise.resolve("") : Promise.reject(new Error("can't find session: ccctl"));
      }
      if (sub === "new-session") {
        sessionUp = true; // a sibling launch created it between our check and now
        return Promise.reject(new Error("duplicate session: ccctl"));
      }
      if (sub === "new-window") {
        return Promise.resolve("@5 ccctl:2");
      }
      return Promise.resolve("");
    };
    const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });

    const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    expect(session.attachment.attachable).toBe(true);
    expect(session.attachment.hint).toBe("tmux select-window -t @5 \\; attach -t ccctl");
    expect(callsFor(calls, "new-window")).toHaveLength(1);
  });

  it("rejects a TYPED `backend-unavailable` when tmux cannot bring a surface up, so the caller falls back (owned-pty #30)", async () => {
    // tmux absent: BOTH has-session and new-session spawn-fail (ENOENT).
    const enoent = Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
    const runner: TmuxRunner = () => Promise.reject(enoent);
    const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });

    const error = await launcher.launch({ cwd: "/repo", permissionMode: "default" }).catch((e: unknown) => e);

    // The typed reject (#33): this backend cannot bring a surface up HERE — fall back.
    expect(error).toBeInstanceOf(SessionLaunchError);
    expect((error as SessionLaunchError).code).toBe("backend-unavailable");
    // The underlying failure is never swallowed — it survives as `cause` for a log, even though only
    // the code reaches the wire.
    expect((error as SessionLaunchError).cause).toBe(enoent);
  });

  it("rejects a TYPED `backend-unavailable` when the window itself cannot be created (new-window fails)", async () => {
    const newWindowFailure = new Error("tmux: no server running");
    const { runner } = makeFakeRunner({
      sessionExists: true,
      failSubcommand: { sub: "new-window", error: newWindowFailure },
    });
    const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });

    const error = await launcher.launch({ cwd: "/repo", permissionMode: "default" }).catch((e: unknown) => e);

    // tmux reports every cause as a non-zero exit plus prose, so this backend does not pretend to
    // distinguish them: it says the one true thing (no surface here) and keeps the prose as `cause`.
    expect((error as SessionLaunchError).code).toBe("backend-unavailable");
    expect((error as SessionLaunchError).cause).toBe(newWindowFailure);
  });

  // The teardown target is the window ID, never the `session:index` printed beside it. tmux renumbers
  // indices (a `renumber-windows on` config does it on every close), so an index captured at launch
  // names a DIFFERENT window later — and this `close()` is what #33's eviction calls to reap a ghost.
  // Firing it at a recycled index reaps a live operator's session instead. See the real-tmux
  // renumbering test above, where exactly that was measured.
  it("tears the window down on close via kill-window with the DURABLE window id, not the index", async () => {
    const { runner, calls } = makeFakeRunner({ newWindowTarget: "@5 ccctl:2" });
    const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });
    const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    await session.close();

    expect(callsFor(calls, "kill-window")).toEqual([["kill-window", "-t", "@5"]]);
  });

  it("close is idempotent: a second call is a safe no-op (kill-window runs exactly once)", async () => {
    const { runner, calls } = makeFakeRunner();
    const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });
    const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();

    expect(callsFor(calls, "kill-window")).toHaveLength(1);
  });

  it("close resolves even when the window is already gone (kill-window failure is swallowed)", async () => {
    const { runner } = makeFakeRunner({
      failSubcommand: { sub: "kill-window", error: new Error("can't find window: ccctl:1") },
    });
    const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });
    const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    await expect(session.close()).resolves.toBeUndefined();
  });

  it("honors a custom session name and tmux binary in the commands and the attach hint", async () => {
    const { runner, calls } = makeFakeRunner({ sessionExists: true, newWindowTarget: "@1 myctl:1" });
    const launcher = createTmuxSessionLauncher({
      runner,
      workerCommand,
      workerBinaryProbe: workerBinaryFound,
      sessionName: "myctl",
      tmuxBin: "/opt/tmux/bin/tmux",
    });

    const session = await launcher.launch({ cwd: "/repo", permissionMode: "default" });

    expect(callsFor(calls, "has-session")).toEqual([["has-session", "-t", "myctl"]]);
    expect(session.attachment.hint).toBe("/opt/tmux/bin/tmux select-window -t @1 \\; attach -t myctl");
  });

  // tmux prints what `-F` asked for — but a tmux too old for `#{window_id}`, or a `-P` that came back
  // empty, would hand back a string this backend cannot address a window with. Fail CLOSED (a typed
  // `backend-unavailable`, so the composite falls back to owned-pty) rather than carrying a garbage
  // handle: every later `kill-window -t <garbage>` silently no-ops, and #33's eviction would then
  // report a ghost reaped while its terminal ran on forever.
  it("rejects a launch whose window handle it cannot read, rather than carrying an unaddressable one", async () => {
    const { runner } = makeFakeRunner({ newWindowTarget: "ccctl:3" }); // no `@id` — a pre-1.7 tmux
    const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });

    const error = await launcher.launch({ cwd: "/repo", permissionMode: "default" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SessionLaunchError);
    expect((error as SessionLaunchError).code).toBe("backend-unavailable");
    expect((error as SessionLaunchError).cause).toMatchObject({
      message: expect.stringContaining("unreadable window handle") as unknown as string,
    });
  });

  // tmux FORMAT-EXPANDS `-c` and `-n`, and both carry operator-supplied strings. Unescaped, a `#` in
  // a directory name (`~/src/C#`) makes `new-window` succeed — exit 0, a window target printed —
  // while the worker comes up somewhere else entirely. The launched session then registers from a
  // directory the server never launched it at, its pending launch is never claimed, and the #33
  // eviction timer closes the terminal of a live session ten seconds later.
  it("escapes `#` in the cwd and the window name — tmux format-expands both", async () => {
    const { runner, calls } = makeFakeRunner({ sessionExists: true });
    const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: workerBinaryFound });

    await launcher.launch({ cwd: "/work/C#sharp", permissionMode: "default", project: "proj#1" });

    const [newWindow] = callsFor(calls, "new-window");
    expect(newWindow?.[newWindow.indexOf("-c") + 1]).toBe("/work/C##sharp");
    expect(newWindow?.[newWindow.indexOf("-n") + 1]).toBe("proj##1");
    // The worker argv is exec'd directly and is NOT format-expanded — escaping it would corrupt a
    // legitimate `#` in an argument, so it must pass through verbatim.
    expect(newWindow).toContain("--project");
    expect(newWindow).toContain("proj#1");
  });

  it("rejects a typed `worker-not-found` when the worker binary is not runnable — tmux cannot tell us", async () => {
    const { runner, calls } = makeFakeRunner({ sessionExists: true });
    const launcher = createTmuxSessionLauncher({ runner, workerCommand, workerBinaryProbe: () => false });

    await expect(launcher.launch({ cwd: "/repo", permissionMode: "default" })).rejects.toMatchObject({
      code: "worker-not-found",
    });
    // Pre-flight, not post-mortem: tmux is never even asked. `new-window` would have answered exit 0
    // and a window target for a command that does not exist, leaving a dead window and a session that
    // silently vanishes at the eviction timeout with no error ever surfaced.
    expect(calls).toEqual([]);
  });

  it("rejects a typed `spawn-failed` when the worker-command factory yields an empty argv", async () => {
    const { runner, calls } = makeFakeRunner({ sessionExists: true });
    const launcher = createTmuxSessionLauncher({
      runner,
      workerCommand: () => [],
      workerBinaryProbe: workerBinaryFound,
    });

    await expect(launcher.launch({ cwd: "/repo", permissionMode: "default" })).rejects.toMatchObject({
      code: "spawn-failed",
    });
    // `new-window … <nothing>` opens a bare SHELL — a window that looks alive, never registers, and
    // outlives its eviction as an orphan the operator has to find by hand.
    expect(calls).toEqual([]);
  });
});

// The probe is the seam every test above injects a fake into, which is exactly why it needs its own
// tests: a stub that always answers `true` proves the backend calls a probe, never that the REAL one
// answers the question the exec inside the tmux window will ask. Each case below is a way to get that
// question subtly wrong — and each wrong answer is confident, silent, and lands as a ghost session.
describe("defaultWorkerBinaryProbe (the real PATH walk)", () => {
  const probeRoot = mkdtempSync(join(tmpdir(), "ccctl-probe-"));
  const withPath = <T>(value: string | undefined, body: () => T): T => {
    const saved = process.env["PATH"];
    if (value === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = value;
    }
    try {
      return body();
    } finally {
      if (saved === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = saved;
      }
    }
  };
  /** An executable file at `probeRoot/<relative>` (dirs created), `0755`. */
  const executable = (relative: string): string => {
    const path = join(probeRoot, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
    return path;
  };

  afterAll(() => {
    rmSync(probeRoot, { recursive: true, force: true });
  });

  it("finds a bare command on the PATH, and misses one that is not on it", () => {
    const binDir = dirname(executable("bin/claude-real"));

    expect(withPath(binDir, () => defaultWorkerBinaryProbe("claude-real", probeRoot))).toBe(true);
    expect(withPath(binDir, () => defaultWorkerBinaryProbe("claude-absent", probeRoot))).toBe(false);
  });

  it("resolves a RELATIVE command against the LAUNCH cwd, not the daemon's own", () => {
    // `./bin/claude` in the operator's repo. The daemon's cwd is this vitest process's — anywhere.
    // Resolving against it would false-MISS a launch that would have worked (and, from a daemon that
    // happens to sit somewhere else with a matching name, false-HIT into a silent ghost).
    executable("repo/bin/claude-rel");

    expect(defaultWorkerBinaryProbe("./bin/claude-rel", join(probeRoot, "repo"))).toBe(true);
    expect(defaultWorkerBinaryProbe("./bin/claude-rel", probeRoot)).toBe(false);
  });

  it("treats a POSIX-empty PATH element as the LAUNCH cwd", () => {
    // `PATH=/nowhere:` — the trailing empty element means "the current directory", which for the
    // launched worker is the window's cwd. sh(1) and execvp(3) both honour it.
    executable("repo/claude-cwd");
    const path = `${join(probeRoot, "nowhere")}${delimiter}`;

    expect(withPath(path, () => defaultWorkerBinaryProbe("claude-cwd", join(probeRoot, "repo")))).toBe(true);
    expect(withPath(path, () => defaultWorkerBinaryProbe("claude-cwd", probeRoot))).toBe(false);
  });

  it("does NOT mistake an executable DIRECTORY on the PATH for a runnable binary", () => {
    // Directories carry `+x` — that is how they are traversed — so an `X_OK` check alone reports a
    // directory named `claude` on the PATH as perfectly runnable. tmux would then open a window on a
    // command that cannot exec, and #33's whole point is that tmux does not tell us.
    const binDir = join(probeRoot, "dirbin");
    mkdirSync(join(binDir, "claude-dir"), { recursive: true });

    expect(withPath(binDir, () => defaultWorkerBinaryProbe("claude-dir", probeRoot))).toBe(false);
  });

  it("does NOT accept a present-but-non-executable file", () => {
    const path = join(probeRoot, "noexec", "claude-noexec");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "#!/bin/sh\n", { mode: 0o644 });

    // A file that is there but not `+x` fails to launch just as surely as an absent one.
    expect(defaultWorkerBinaryProbe(path, probeRoot)).toBe(false);
  });

  it("takes an ABSOLUTE command as given, and does not consult the PATH for it", () => {
    const absolute = executable("abs/claude-abs");

    expect(withPath("", () => defaultWorkerBinaryProbe(absolute, probeRoot))).toBe(true);
    expect(withPath("", () => defaultWorkerBinaryProbe(join(probeRoot, "abs", "nope"), probeRoot))).toBe(false);
  });

  it("fails CLOSED with no PATH at all, rather than throwing out of the launch path", () => {
    expect(withPath(undefined, () => defaultWorkerBinaryProbe("claude", probeRoot))).toBe(false);
  });
});

// The pure half of the tmux liveness probe (#35): what a `list-windows -a -F` enumeration MEANS for
// one window. Hermetic — no tmux, no runner, just tmux's output shape in and a reading out. The
// enumerations below are transcribed from a real tmux 3.7b, not invented; the fenced integration
// block above is what keeps them honest.
describe("readWindowLiveness (#35)", () => {
  const OURS = "ccctl";

  it("reads a window in OUR session with no client attached as `alive-server-owned`", () => {
    expect(readWindowLiveness("@1 ccctl 0", "@1", OURS)).toBe("alive-server-owned");
  });

  it("reads a window whose session has a client ATTACHED as `taken-over` (AC2)", () => {
    // The operator is at the desk, in the ccctl session. Every window in it is in human hands.
    expect(readWindowLiveness("@1 ccctl 1", "@1", OURS)).toBe("taken-over");
  });

  it("reads a window MOVED out of our session as `taken-over` — it is not ours anymore", () => {
    expect(readWindowLiveness("@1 operators-own-workspace 0", "@1", OURS)).toBe("taken-over");
  });

  it("reads a window absent from the enumeration as `exited` (AC4)", () => {
    // tmux listed every window it has; ours is not among them. That is a fact, not an inference.
    expect(readWindowLiveness("@2 ccctl 0\n@3 ccctl 0", "@1", OURS)).toBe("exited");
  });

  it("reads an EMPTY enumeration as `exited`, never as ours to kill", () => {
    expect(readWindowLiveness("", "@1", OURS)).toBe("exited");
  });

  it("picks OUR window out of a busy enumeration, ignoring every other window's state", () => {
    // The decisive case for `-a`: sibling ccctl windows, an attached unrelated session, and ours —
    // quietly detached in the middle of it. A probe that keyed on anything but our own line (the first
    // line, the attached one, "any window in an attached session") gets this wrong.
    const enumeration = ["@1 ccctl 0", "@2 someones-editor 1", "@3 ccctl 0", "@4 ccctl 0"].join("\n");

    expect(readWindowLiveness(enumeration, "@3", OURS)).toBe("alive-server-owned");
  });

  it("does not confuse a window id with a PREFIX of another (`@1` vs `@10`)", () => {
    // tmux ids are `@N` and go past 9 in any long-lived session. A substring/startsWith match here
    // would read @10's state as @1's — and one of them may be the operator's.
    expect(readWindowLiveness("@10 ccctl 1", "@1", OURS)).toBe("exited");
    expect(readWindowLiveness("@1 ccctl 0\n@10 ccctl 1", "@10", OURS)).toBe("taken-over");
  });

  it("reads a session name containing SPACES — the fields are found where tmux puts them", () => {
    // tmux allows spaces in a session name (`new-session -s 'my session'`), so the session name is not
    // one whitespace-separated field. Parsed outside-in, `@1`'s session is the whole middle.
    expect(readWindowLiveness("@1 my work session 0", "@1", "my work session")).toBe("alive-server-owned");
    expect(readWindowLiveness("@1 my work session 1", "@1", "my work session")).toBe("taken-over");
    // …and one moved into a spaced session that is NOT ours is still a takeover.
    expect(readWindowLiveness("@1 someones other session 0", "@1", OURS)).toBe("taken-over");
  });

  it("does not misparse a spaced session name into OUR session plus an unattached count", () => {
    // The kill hiding in a naive three-field destructure: a window in a session literally named
    // `ccctl 0` would parse as ("ccctl", "0") — our session, unattached, ours to reap — and teardown
    // would close the operator's window. Outside-in, the session reads `ccctl 0` (not ours) and the
    // attach count reads `1`. Contrived; the point is that it cannot happen at all.
    expect(readWindowLiveness("@1 ccctl 0 1", "@1", OURS)).toBe("taken-over");
  });

  it("falls to the SAFE side on a malformed line — never `alive-server-owned`", () => {
    // A line we cannot parse must not become permission to kill. A truncated line cannot match our id
    // (so it reads `exited`, and closing an already-gone surface is the harmless no-op); a garbled
    // attach count is not `0`, so it reads `taken-over` rather than ours.
    expect(readWindowLiveness("@1", "@1", OURS)).toBe("taken-over");
    expect(readWindowLiveness("@1 ccctl", "@1", OURS)).toBe("taken-over");
    expect(readWindowLiveness("@1 ccctl ?", "@1", OURS)).toBe("taken-over");
    expect(readWindowLiveness("garbage", "@1", OURS)).toBe("exited");
  });

  it("tolerates the trailing newline and padding a real tmux emits", () => {
    expect(readWindowLiveness("@1 ccctl 0\n", "@1", OURS)).toBe("alive-server-owned");
    expect(readWindowLiveness("  @1 ccctl 0  \n", "@1", OURS)).toBe("alive-server-owned");
  });
});
