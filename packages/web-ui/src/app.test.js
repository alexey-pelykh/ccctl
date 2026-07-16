// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// The REAL builders the shell wires its controls to. Each outbound body below is asserted against the
// builder's OWN output rather than a hand-written copy of the wire shape: the shell's job is to route
// a control to the right builder and send what it returns intact, and that is exactly what comparing
// against the builder tests. It also keeps the wire VOCABULARY out of this file — `command.js` owns
// that a redirect goes out as `interrupt` (and `command.test.js` / `@ccctl/e2e` pin it there), so a
// literal here would be a second copy of a contract this file has no business restating.
import { approveCommand, inputCommand, redirectCommand } from "./command.js";
import { launchRequest } from "./launch.js";
import { stopRequest } from "./stop.js";
// The INBOUND half of the same rule: `push.js` owns what a service-worker→client navigate looks like
// (and `push.test.js` pins that decode), so the wiring test below names the type rather than re-spelling it.
import { NAVIGATE_MESSAGE_TYPE } from "./push.js";

// The SHELL, driven against the REAL markup (#199).
//
// `app.js` is deliberately thin — every decode / classify / format / diff decision lives in a
// DOM-free module beside it, each unit-tested — but "thin" was an aspiration the toolchain did not
// enforce, and this file is the enforcement. Before it, a mutation to the shell survived a fully
// green `pnpm run test`: deleting a control's whole `addEventListener` wiring, dropping a branch of
// the stop-status clear, renaming an id in `index.html`. `typecheck` is `node --check` (syntax, not
// semantics) and `@ccctl/e2e` imports the pure modules but never the shell, so nothing looked.
//
// This is the DEEP half of #199 (its option 1); `app.contract.test.js` (option 2) is the complete-but-
// shallow half. The split is the point: the contract checks EVERY id the shell binds and nothing about
// behaviour; this checks that the controls are actually WIRED, which only real events can show. A
// source-text assertion (grep app.js for `addEventListener`) was rejected — it would pass an emptied
// handler, and it asserts the source rather than the behaviour, which is the tautology `stop.test.js`
// already refuses on its own contract.
//
// jsdom is a DEV dependency of this package only. The served artifact is unchanged: `files` ships
// `index.html` + `src`, `build` deletes `*.test.js` out of `dist`, and nothing here is imported by
// anything shipped — so the zero-build, no-bundler, dependency-free RUNTIME is intact (#199 AC4).
// Only this file pays the jsdom cost: the `@vitest-environment` docblock above is per-file, so the
// pure-module suites beside it keep running in the fast node environment with no config to drift.
//
// What this harness does NOT reach: anything about LAYOUT or paint. jsdom has no layout engine, so
// the responsive/tap-target criteria (#83) are out of scope here by construction, not by omission.

const INDEX_HTML = readFileSync(join(import.meta.dirname, "..", "index.html"), "utf8");

/** A `SessionSummaryWire` row — the `GET /api/sessions` shape, as `sessions.test.js` fixtures it. */
function summary(id) {
  return { id, status: "ready", activity: { kind: "running" }, notificationsDegraded: false };
}

/**
 * The shell reads `localStorage` for its pairing token (#74). jsdom exposes no storage here, and a
 * Map-backed double is the honest stand-in: it keeps each load hermetic (no token bleeds between
 * tests) and `pairing.js` already takes its storage as a parameter, so this is the same seam it has.
 */
function fakeStorage() {
  const entries = new Map();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };
}

/**
 * The downstream leg. jsdom implements no `EventSource`, so the stream is a double that records what
 * the shell subscribed to and lets a test deliver a frame — which is all the shell's wiring needs to
 * be observed against.
 */
class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.closed = false;
    this.handlers = new Map();
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, handler) {
    this.handlers.set(type, handler);
  }

  close() {
    this.closed = true;
  }

  /** Fire one subscribed handler, as the real stream would. */
  emit(type, event = {}) {
    this.handlers.get(type)?.(event);
  }
}

/**
 * The service-worker leg. jsdom's navigator carries none, so BOTH of the shell's
 * `"serviceWorker" in navigator` branches are dead unless a test asks for this double — which records
 * the `message` handler the shell subscribes to and lets a test deliver one, as a tapped push does.
 *
 * `register` resolves to a registration with NO `pushManager`, deliberately: that keeps the push flow
 * on the same can't-here branch it takes with no worker at all, so opting in to the worker never
 * quietly re-routes the enable-push test below into a path it was not written for.
 */
function fakeServiceWorker() {
  const handlers = new Map();
  return {
    addEventListener: (type, handler) => handlers.set(type, handler),
    register: async () => ({}),
    /** Deliver one worker→client message, as the real worker does for a tap on an ALREADY-OPEN app. */
    emit: (type, event) => handlers.get(type)?.(event),
  };
}

/** Every request the shell made, in order — the observable a wiring test asserts against. */
let requests = [];

/**
 * Load the shell exactly as the browser does: the REAL `index.html` in the document, then
 * `import("./app.js")`, which binds its controls and wires them at module scope. `resetModules` forces
 * a fresh evaluation per test — the shell holds its selection / poll state in module scope, so a
 * cached instance would leak one test's session into the next.
 *
 * Loading the real markup rather than a fixture is load-bearing: a fixture would be a copy of the page
 * that drifts from it, and the drift IS the bug (#199) — the harness would then agree with itself
 * while the real page was down.
 *
 * @param sessions - the rows `GET /api/sessions` answers with, until `setSessions` replaces them.
 * @param respond - per-request override, for the legs a test needs to answer as the server would
 *   (a typed refusal, a failure); anything it does not answer takes the accepted default.
 * @param serviceWorker - give this load a service worker (default: none, as jsdom has none). Opt-in
 *   rather than default, so the push flow's can't-here branch keeps reading the honest jsdom navigator.
 */
async function loadShell({ sessions = [], respond, serviceWorker = false } = {}) {
  vi.resetModules();
  FakeEventSource.instances = [];
  requests = [];

  let listed = sessions;

  document.documentElement.innerHTML = INDEX_HTML.slice(INDEX_HTML.indexOf("<head"));

  // Installed straight onto jsdom's own `navigator` rather than through `vi.stubGlobal`, which would
  // have to replace the WHOLE navigator to reach one property; `afterEach` deletes it, so this still
  // meets the real-teardown bar the stubs below meet.
  if (serviceWorker) {
    Object.defineProperty(navigator, "serviceWorker", { value: fakeServiceWorker(), configurable: true });
  }

  // Stubbed through `vi.stubGlobal` rather than assigned onto `globalThis`, so the `afterEach`
  // restore below is real teardown rather than ceremony: these three would otherwise outlive the file.
  vi.stubGlobal("localStorage", fakeStorage());
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path, init = {}) => {
      const method = init.method ?? "GET";
      requests.push({ path, method, body: init.body });
      const override = respond?.({ path, method });
      if (override !== undefined) {
        return { ok: true, status: 200, json: async () => ({}), ...override };
      }
      const payload = path === "/api/sessions" && method === "GET" ? { sessions: listed } : {};
      return { ok: true, status: 200, json: async () => payload };
    }),
  );

  await import("./app.js");
  // The first poll + device list fire at module scope; let them settle so a test that drives a control
  // sees the shell in the state the operator would — a session selected, its stream open.
  await vi.waitFor(() => {
    expect(requests.some((request) => request.path === "/api/sessions")).toBe(true);
  });
  await settle();
  FakeEventSource.instances.at(-1)?.emit("open");
  requests = [];

  return {
    /** Answer the next poll with a different list — how a session ARRIVES, or goes away (#173/#77). */
    setSessions: (next) => {
      listed = next;
    },
    /** Re-list now, via the control the operator would use. */
    poll: async () => {
      document.getElementById("refresh-sessions").click();
      await settle();
    },
  };
}

/**
 * Drain the microtask queue the shell's fetch chains resolve on. The deepest chain reached from here is
 * fetch → json → render, so a couple of turns is all it currently needs; the count is deliberately
 * GENEROUS rather than tuned, to absorb an `await` added to a shell path without silently under-draining.
 *
 * Being sufficient is load-bearing, and not only for the tests that wait for something to appear —
 * `vi.waitFor` retries, so those would tolerate a short drain. It is the tests asserting state is
 * UNCHANGED after a poll ("KEEPS a stop SUCCESS") that need it: an under-drain there passes because the
 * work has not happened YET, which is a vacuous pass wearing a green tick. That those tests fail on a
 * shell that over-clears is what proves the drain reaches far enough; it is verified by mutation, not
 * by the count.
 */
async function settle() {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
}

/** The requests the shell made since the last checkpoint, narrowed to one leg. */
function requestsTo(predicate) {
  return requests.filter(predicate);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // `unstubAllGlobals` does not reach a property defined straight onto jsdom's navigator, so the
  // service-worker double (when a test opted in) is removed by hand — otherwise the next load would
  // find a worker where jsdom has none and silently take a different branch.
  delete navigator.serviceWorker;
});

describe("the shell against the real index.html (#199)", () => {
  it("binds every control it reaches for — a renamed id is the whole page, not one button", async () => {
    // The sharpest mutation #199 names: `app.js` does `getElementById("stop-button")` at module scope
    // and dereferences it unconditionally, so renaming that id in `index.html` makes the binding null
    // and throws on the first use — killing the UI outright. Loading the shell against the REAL markup
    // is what notices; nothing here has to name the ids, because the shell already does.
    await expect(loadShell({ sessions: [summary("sess-1")] })).resolves.not.toThrow();
  });

  it("views the first session on load, so the page is useful without a click", async () => {
    await loadShell({ sessions: [summary("sess-1")] });

    expect(FakeEventSource.instances.at(-1)?.url).toBe("/api/sessions/sess-1/events");
  });
});

// Every wiring the shell registers at module scope — eight DOM controls, plus the service-worker
// `message` listener that is not a control at all. Deleting any one of them is what these fail on.
describe("the shell's module-scope wiring (#199)", () => {
  it("wires Refresh to re-list the sessions", async () => {
    await loadShell({ sessions: [summary("sess-1")] });

    document.getElementById("refresh-sessions").click();
    await vi.waitFor(() => {
      expect(requestsTo((request) => request.path === "/api/sessions" && request.method === "GET")).not.toEqual([]);
    });
  });

  it("wires the stop button to the selected session's stop leg", async () => {
    await loadShell({ sessions: [summary("sess-1")] });

    document.getElementById("stop-button").click();
    await vi.waitFor(() => {
      const [stop] = requestsTo((request) => request.path === "/api/sessions/sess-1/stop");
      expect(stop).toBeDefined();
      expect(stop.method).toBe("POST");
      // The BARE body — the plain stop never mentions force (`stop.js` owns that rule, and the
      // escalation is offered only by a forceable refusal, never by this control).
      expect(JSON.parse(stop.body)).toEqual(stopRequest());
    });
  });

  it("leaves the stop button disabled with nothing selected — a stop is never inferred (#20)", async () => {
    await loadShell({ sessions: [] });

    expect(document.getElementById("stop-button").disabled).toBe(true);
    document.getElementById("stop-button").click();
    expect(requestsTo((request) => request.path.endsWith("/stop"))).toEqual([]);
  });

  it("wires the launch form to POST a new session", async () => {
    await loadShell({ sessions: [] });

    document.getElementById("launch-cwd").value = "/home/alex/code/app";
    document.getElementById("launch-project").value = "app";
    document.getElementById("launch-prompt").value = "ship it";
    document.getElementById("launch-form").requestSubmit();

    await vi.waitFor(() => {
      const [launch] = requestsTo((request) => request.path === "/api/sessions" && request.method === "POST");
      expect(launch).toBeDefined();
      // All three fields, read off the three inputs and passed to the builder intact — a shell that
      // dropped `project` or crossed two of these inputs would still POST, and still pass a
      // body-shape-only assertion.
      expect(JSON.parse(launch.body)).toEqual(
        launchRequest({ cwd: "/home/alex/code/app", project: "app", initialPrompt: "ship it" }),
      );
    });
  });

  it("wires the prompt form to steer the selected session", async () => {
    await loadShell({ sessions: [summary("sess-1")] });

    document.getElementById("prompt-input").value = "keep going";
    document.getElementById("prompt-form").requestSubmit();

    await vi.waitFor(() => {
      const [steer] = requestsTo((request) => request.path === "/api/sessions/sess-1/command");
      expect(steer).toBeDefined();
      expect(JSON.parse(steer.body)).toEqual(inputCommand("keep going"));
    });
    // The input is cleared optimistically, so the operator's decision does not read as still-unsent.
    expect(document.getElementById("prompt-input").value).toBe("");
  });

  it("wires the redirect form to steer the selected session", async () => {
    await loadShell({ sessions: [summary("sess-1")] });

    document.getElementById("redirect-input").value = "stop and write tests instead";
    document.getElementById("redirect-form").requestSubmit();

    await vi.waitFor(() => {
      const [steer] = requestsTo((request) => request.path === "/api/sessions/sess-1/command");
      expect(steer).toBeDefined();
      expect(JSON.parse(steer.body)).toEqual(redirectCommand("stop and write tests instead"));
    });
  });

  it("wires the approve button to steer the selected session", async () => {
    await loadShell({ sessions: [summary("sess-1")] });

    document.getElementById("approve-button").click();

    await vi.waitFor(() => {
      const [steer] = requestsTo((request) => request.path === "/api/sessions/sess-1/command");
      expect(steer).toBeDefined();
      expect(JSON.parse(steer.body)).toEqual(approveCommand());
    });
  });

  it("wires the devices Refresh to re-list the paired devices", async () => {
    await loadShell({ sessions: [] });

    document.getElementById("refresh-devices").click();
    await vi.waitFor(() => {
      expect(requestsTo((request) => request.path === "/api/devices")).not.toEqual([]);
    });
  });

  it("wires Enable notifications to the push flow", async () => {
    await loadShell({ sessions: [] });

    document.getElementById("enable-push").click();

    // jsdom's navigator carries no service worker, so the flow takes its honest can't-here branch —
    // which is itself the observable proving the click was wired to it at all.
    await vi.waitFor(() => {
      expect(document.getElementById("push-status").dataset.push).toBe("blocked");
    });
  });

  it("wires a push TAPPED WHILE THE APP IS OPEN to the session it names (#52)", async () => {
    // The shell's ninth module-scope wiring, and the one every test above is structurally blind to: a
    // tap landing on an already-open app cannot cold-open a URL, so the service worker posts the target
    // session to this live client instead. jsdom has no worker, so `"serviceWorker" in navigator` is
    // false and the whole branch is DEAD unless a load opts in — which is why deleting this wiring
    // survived both gates until this test existed (the id contract sees ids, not listeners).
    await loadShell({ sessions: [summary("sess-1"), summary("sess-2")], serviceWorker: true });
    expect(FakeEventSource.instances.at(-1)?.url, "precondition: viewing the auto-selected first session").toBe(
      "/api/sessions/sess-1/events",
    );

    navigator.serviceWorker.emit("message", { data: { type: NAVIGATE_MESSAGE_TYPE, session_id: "sess-2" } });
    await settle();

    // Switched the viewed session IN PLACE: the stream now follows the tapped session. Only the routing
    // is pinned here — that a malformed message must not steer is `navigateMessageSessionId`'s rule, and
    // `push.test.js` owns it.
    expect(FakeEventSource.instances.at(-1)?.url).toBe("/api/sessions/sess-2/events");
  });
});

// The branch a poll takes when the SELECTED session is gone from the list — by eviction (#173) or
// because the operator just stopped it (#77), which is what promotes this from an edge case to the
// emergency-stop's happy path. Two of the four mutations #199 demonstrated surviving live here, and
// both are about not leaving a CLAIM on screen about a session that no longer exists.
describe("the shell when the viewed session goes away (#199)", () => {
  it("drops the current-turn indicator — it is a live claim about a session that is gone", async () => {
    const shell = await loadShell({ sessions: [summary("sess-1")] });
    const activity = document.getElementById("activity");
    // The indicator is revealed by the session's first frame; show it the way the stream would.
    FakeEventSource.instances.at(-1).emit("message", {
      lastEventId: "1",
      data: JSON.stringify({ type: "control_event", subtype: "worker_status", payload: { status: "running" } }),
    });
    await settle();
    expect(activity.hidden, "precondition: the viewed session's activity is on screen").toBe(false);

    shell.setSessions([]);
    await shell.poll();

    // Leaving it up is how an operator who just emergency-stopped a runaway reads "running" over the
    // session they killed.
    expect(activity.hidden).toBe(true);
    expect(document.getElementById("status").textContent).toBe("no session selected");
    expect(document.getElementById("stop-button").disabled).toBe(true);
  });

  it("drops a stop REFUSAL — its subject is gone, and its escalation would outlive it", async () => {
    const shell = await loadShell({
      sessions: [summary("sess-1")],
      respond: ({ path }) =>
        path === "/api/sessions/sess-1/stop"
          ? { ok: false, status: 409, json: async () => ({ code: "taken-over", message: "someone is driving it" }) }
          : undefined,
    });
    const stopStatus = document.getElementById("stop-status");

    document.getElementById("stop-button").click();
    await vi.waitFor(() => {
      expect(stopStatus.dataset.stop).toBe("failed");
    });
    // A forceable refusal puts a live "Stop anyway" on screen — the thing that must not outlive its
    // session, since it re-sends a kill addressed to it.
    expect(document.getElementById("stop-force-button")).not.toBeNull();

    shell.setSessions([]);
    await shell.poll();

    expect(stopStatus.hidden).toBe(true);
    expect(stopStatus.dataset.stop).toBeUndefined();
    expect(document.getElementById("stop-force-button")).toBeNull();
  });

  it("KEEPS a stop SUCCESS — this is the branch a successful stop itself arrives on", async () => {
    // The asymmetry with the refusal above is the rule, not an oversight: a successful stop REMOVES
    // the session, so it lands here by construction. Clearing the line here would wipe the
    // "stopped — closed" answer the operator is reading, every single time it is true.
    const shell = await loadShell({ sessions: [summary("sess-1")] });
    const stopStatus = document.getElementById("stop-status");

    document.getElementById("stop-button").click();
    await vi.waitFor(() => {
      expect(stopStatus.dataset.stop).toBe("stopped");
    });

    shell.setSessions([]);
    await shell.poll();

    expect(stopStatus.hidden).toBe(false);
    expect(stopStatus.dataset.stop).toBe("stopped");
  });
});
