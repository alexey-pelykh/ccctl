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
  /** Inject a failure for calls matching a subcommand (e.g. simulate tmux absent / window gone). */
  readonly failSubcommand?: { readonly sub: string; readonly error: Error };
}): { readonly runner: TmuxRunner; readonly calls: readonly string[][] } {
  const calls: string[][] = [];
  const sessionExists = config?.sessionExists ?? false;
  const target = config?.newWindowTarget ?? "@1 ccctl:1";
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
  try {
    execFileSync("tmux", ["kill-session", "-t", REAL_TMUX_SESSION], { stdio: "ignore" });
  } catch {
    // The session may never have been created, or already be gone — teardown is best-effort.
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
