// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSession,
  markSessionReady,
  NO_OP_LOGGER,
  type LogEvent,
  type Logger,
  type RequiresActionEnrichment,
  type Session,
} from "@ccctl/core";
import { createSessionEventRelays, relayFor } from "./event-stream.js";
import type { HookInstall } from "./hook-settings-installer.js";
import { closeSession, SESSION_CLOSED_EVENT_TYPE, type SessionCloseState } from "./session-close.js";

// The terminal-transition seam (#76) in ISOLATION — the one place a session ENDS, whichever of the two
// things ended it (the operator stopped it; its worker went terminally silent). Hermetic: no server, no
// HTTP, no surfaces. The wired-through behavior is covered by `ui-session-stop.test.ts` (the stop path)
// and `worker-channel.test.ts` (the #173 eviction path).

function makeState(logger: Logger = NO_OP_LOGGER): SessionCloseState {
  return {
    sessions: new Map<string, Session>(),
    eventRelays: createSessionEventRelays(),
    requiresActionEnrichments: new Map<string, RequiresActionEnrichment>(),
    hookInstalls: new Map<string, HookInstall>(),
    logger,
  };
}

/** A stand-in SSE subscriber: the response the relay writes to, plus the record of what it received. */
interface Watcher {
  /** The `ServerResponse` the relay writes to and ends. */
  readonly res: ServerResponse;
  /** The SSE chunks written to it, in arrival order — the bytes a watching phone would read. */
  readonly writes: string[];
  /**
   * How many writes had landed when the relay ended this stream, or `null` if it never did — AC1's
   * "before the stream ends" stated DIRECTLY rather than inferred from a side-effect.
   *
   * It is also the only thing here that can see an END THAT WROTE NOTHING, which `writes` is blind to by
   * construction — and that is what pins AC3's bystander. A `closeSessionRelay` that reaped EVERY
   * session's subscribers rather than one session's would leave the sibling's `writes` empty and every
   * frame-content assertion in this suite green; it fails here alone (measured: under that mutation,
   * `expected +0 to be null`).
   */
  endedAfter: number | null;
}

/**
 * A stand-in watcher. Only the three members the relay actually touches are implemented — `write` and
 * `end` (`event-stream.ts` § `broadcastEvent` / § `closeSessionRelay`) and the `writableEnded` its
 * `writeChunk` guard reads. The cast keeps the stub honest about being a stub rather than pretending to
 * be a half-built `ServerResponse`.
 */
function watch(state: SessionCloseState, sessionId: string): Watcher {
  const writes: string[] = [];
  const stub = {
    writableEnded: false,
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
    end(): void {
      watcher.endedAfter = writes.length;
      stub.writableEnded = true;
    },
  };
  const watcher: Watcher = { res: stub as unknown as ServerResponse, writes, endedAfter: null };
  relayFor(state.eventRelays, sessionId).subscribers.add(watcher.res);
  return watcher;
}

/** The payloads a watcher read off its stream, decoded from their SSE `data:` framing. */
function received(subscriber: { writes: string[] }): unknown[] {
  return subscriber.writes.map((chunk) => {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))
      .join("\n");
    return JSON.parse(data);
  });
}

/** A capturing sink so a test can assert the structured trail (#61) the transition emitted. */
function captureLogger(): { logger: Logger; events: LogEvent[] } {
  const events: LogEvent[] = [];
  return { logger: { log: (event) => events.push(event) }, events };
}

describe("closeSession", () => {
  // Rule: A stopped session transitions to a terminal state.
  //
  //   Scenario: A live session is ended
  //     Given a session that is ready and being watched
  //     When it is closed
  //     Then it reaches its terminal status
  //     And it is no longer listed
  //     And its UI relay is reaped
  it("ends a session TOTALLY — terminal status returned, row dropped, relay reaped (AC4)", () => {
    const state = makeState();
    state.sessions.set("sess-1", markSessionReady(createSession("sess-1", "default")));
    relayFor(state.eventRelays, "sess-1"); // a UI is watching this session.

    const closed = closeSession(state, "sess-1");

    // "transitions to a terminal state" — RETURNED, not merely computed. This is the whole point of the
    // seam: before it, eviction built the closed session and dropped it on the next line, so the status
    // reached nobody and `closed` was a state no client of this server could observe. A caller with
    // someone to answer now has something to answer WITH (`ui-session-stop.ts` puts it on the wire).
    expect(closed?.status).toBe("closed");
    // "reflected to clients" — the row leaves the list, and the stream ends.
    expect(state.sessions.has("sess-1")).toBe(false);
    expect(state.eventRelays.has("sess-1")).toBe(false);
  });

  it("reaps a buffered AskUserQuestion enrichment — a closed session leaves no decoration behind (#264)", () => {
    // A session closing WHILE blocked in `requires_action` never trips the transition-out drop (close moves
    // `status`, not `activity`), so this seam is the only thing standing between that decoration and an
    // entry that outlives the session's row — a per-closed-session leak, exactly what the relay reap on the
    // line above it exists to prevent.
    const state = makeState();
    state.sessions.set("sess-1", markSessionReady(createSession("sess-1", "default")));
    state.requiresActionEnrichments.set("sess-1", {
      sequenceNum: 1,
      questions: [{ questionId: "q0", prompt: "Approve?", options: [{ label: "Yes" }], multiSelect: false }],
    });

    closeSession(state, "sess-1");

    expect(state.sessions.has("sess-1")).toBe(false);
    expect(state.requiresActionEnrichments.has("sess-1")).toBe(false);
  });

  it("cleans up a session's AskUserQuestion hook install — settings + handoff files removed, consumed or not (#262)", () => {
    // A session may close with its hook install NEVER consumed: no `AskUserQuestion` was ever asked, or
    // one was asked but the session ended before `worker-channel.ts` § `reconcileHookHandoff` ever ran.
    // Either way, this seam — not the consumer — is what must not let those files outlive the session,
    // exactly mirroring the enrichment reap above for a SEPARATE, file-based piece of per-session state.
    const scratch = mkdtempSync(join(tmpdir(), "ccctl-hook-close-"));
    try {
      const settingsPath = join(scratch, "install.settings.json");
      const handoffPath = join(scratch, "install.handoff.json");
      writeFileSync(settingsPath, "{}");
      writeFileSync(handoffPath, "{}");
      const state = makeState();
      state.sessions.set("sess-1", markSessionReady(createSession("sess-1", "default")));
      state.hookInstalls.set("sess-1", { settingsPath, handoffPath });

      closeSession(state, "sess-1");

      expect(state.hookInstalls.has("sess-1")).toBe(false);
      expect(existsSync(settingsPath)).toBe(false);
      expect(existsSync(handoffPath)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("is a no-op for a session with no hook install — closing never throws when nothing was ever wired (#262)", () => {
    // The ordinary case: most sessions never call `AskUserQuestion`, so `hookInstalls` holds no entry
    // for them at all. Every OTHER test in this file already exercises this path implicitly (none of
    // them populate `hookInstalls`); this test states it as its own claim rather than leaving it
    // merely implied by the others not crashing.
    const state = makeState();
    state.sessions.set("sess-1", markSessionReady(createSession("sess-1", "default")));

    expect(() => closeSession(state, "sess-1")).not.toThrow();
    expect(state.hookInstalls.size).toBe(0);
  });

  it("does not clobber an `errored` session to `closed` — the diagnosis outlives the stop (AC4)", () => {
    // A session that already reached a terminal state of its own keeps the more useful of the two
    // facts. Reporting `closed` here would overwrite WHY it died with the fact that someone eventually
    // pressed stop — and the wire carries what this returns, so the lie would reach the operator.
    const state = makeState();
    const errored: Session = { ...createSession("sess-1", "default"), status: "errored" };
    state.sessions.set("sess-1", errored);

    const closed = closeSession(state, "sess-1");

    expect(closed?.status).toBe("errored");
    // Ended all the same: terminal is terminal, and the session is over either way.
    expect(state.sessions.has("sess-1")).toBe(false);
  });

  it("answers `undefined` for a session that is not there — idempotent, not an error", () => {
    // Both callers need this, from opposite directions: an eviction timer may fire against a session a
    // stop already ended, and a stop may name one an eviction already reaped. Neither is a failure —
    // the session is over, which is what both asked for. A throw would make the two paths racing each
    // other an incident instead of a non-event.
    const state = makeState();

    expect(closeSession(state, "never-existed")).toBeUndefined();
  });

  it("ends ONLY the session it names — never a sibling (#20)", () => {
    const state = makeState();
    state.sessions.set("sess-1", createSession("sess-1", "default"));
    state.sessions.set("sess-2", createSession("sess-2", "default"));
    relayFor(state.eventRelays, "sess-1");
    relayFor(state.eventRelays, "sess-2");

    closeSession(state, "sess-1");

    expect(state.sessions.has("sess-2")).toBe(true);
    expect(state.eventRelays.has("sess-2")).toBe(true);
  });
});

describe("closeSession terminal frame — reflected to WATCHERS, not just the initiator (#196)", () => {
  // Rule: a session's stream is never reaped in silence. #76's AC4 ("reflected to clients") reached the
  // client that ASKED for the stop — `closeSession` returns the terminal status and the handler puts it
  // on the wire. A client merely WATCHING got a bare `res.end()`, which is what a dead link also looks
  // like, so it had to re-poll the session list to find out — and learned only that the row was gone,
  // never what the session became.
  //
  //   Scenario: A watcher learns why its stream ended
  //     Given a session with a client watching its stream
  //     When the session is closed
  //     Then that client receives a frame naming the session and its terminal status
  //     And it receives it BEFORE the stream ends

  it("tells a watcher the session ended, naming it and its terminal status (AC1)", () => {
    const state = makeState();
    state.sessions.set("sess-1", markSessionReady(createSession("sess-1", "default")));
    const watcher = watch(state, "sess-1");

    closeSession(state, "sess-1");

    expect(received(watcher)).toEqual([{ type: SESSION_CLOSED_EVENT_TYPE, session_id: "sess-1", status: "closed" }]);
  });

  it("tells it BEFORE ending the stream — a farewell after the reap reaches nobody (AC1)", () => {
    // The ordering IS the feature, and a swap fails most of this suite rather than only this test —
    // `session-close.ts` § `closeSession` carries why, and is where that argument lives. What THIS test
    // adds is the ordering stated DIRECTLY rather than inferred (see `Watcher.endedAfter`).
    const state = makeState();
    state.sessions.set("sess-1", markSessionReady(createSession("sess-1", "default")));
    const watcher = watch(state, "sess-1");

    closeSession(state, "sess-1");

    expect(watcher.endedAfter).toBe(1); // the stream was ended AFTER exactly one frame — the farewell.
    expect(watcher.writes).toHaveLength(1);
  });

  it("carries the SAME terminal status the initiator is told — `errored` is not clobbered (AC2)", () => {
    // The seam already refuses to overwrite a diagnosis with `closed` for its RETURN value. The frame is
    // built from that same closed session rather than a literal, so the watcher reads the diagnosis too —
    // otherwise the two audiences would be told different things about one session, which is precisely
    // the split this frame exists to end.
    const state = makeState();
    state.sessions.set("sess-1", { ...createSession("sess-1", "default"), status: "errored" });
    const watcher = watch(state, "sess-1");

    const closed = closeSession(state, "sess-1");

    expect(received(watcher)).toEqual([{ type: SESSION_CLOSED_EVENT_TYPE, session_id: "sess-1", status: "errored" }]);
    // The watcher's frame and the initiator's answer are the same fact, not merely similar ones.
    expect(closed?.status).toBe("errored");
  });

  it("reaches EVERY watcher of that session — a stop has more than one audience (AC1)", () => {
    // The case #196 says #77's stop button makes normal rather than exotic: two clients on one session.
    // The initiator is answered by the handler; everyone else is answered by this frame.
    const state = makeState();
    state.sessions.set("sess-1", markSessionReady(createSession("sess-1", "default")));
    const first = watch(state, "sess-1");
    const second = watch(state, "sess-1");

    closeSession(state, "sess-1");

    // Each watcher's frame is pinned by CONTENT rather than against the other's. Asserting they merely
    // match would pass vacuously the moment neither received anything (`[]` equals `[]`) — a "reached
    // every watcher" check that is happiest when it reached none.
    const frame = { type: SESSION_CLOSED_EVENT_TYPE, session_id: "sess-1", status: "closed" };
    expect(received(first)).toEqual([frame]);
    expect(received(second)).toEqual([frame]);
    expect(second.endedAfter).toBe(1);
  });

  it("tells ONLY that session's watchers — a sibling's stream is never written to (AC3, #20)", () => {
    // A terminal frame on the wrong stream would tell a phone that a perfectly live session it is
    // watching has ended — and the client half acts on that word by closing its own stream. Structurally
    // impossible (the broadcast selects the relay by id before a byte is written), and pinned because
    // "impossible" is a claim about code that can change.
    const state = makeState();
    state.sessions.set("sess-1", markSessionReady(createSession("sess-1", "default")));
    state.sessions.set("sess-2", markSessionReady(createSession("sess-2", "default")));
    const doomed = watch(state, "sess-1");
    const bystander = watch(state, "sess-2");

    closeSession(state, "sess-1");

    expect(received(doomed)).toHaveLength(1);
    expect(bystander.writes).toEqual([]); // never written to ...
    expect(bystander.endedAfter).toBeNull(); // ... and never ended.
  });

  it("says nothing for a session that was already gone — an idempotent no-op announces no death", () => {
    // The eviction timer and the stop race each other by design (both are idempotent). The loser must not
    // broadcast a second farewell onto a relay the winner already reaped — which, since a broadcast
    // MATERIALIZES a relay lazily, would also resurrect one for a session that no longer exists.
    const state = makeState();

    closeSession(state, "never-existed");

    expect(state.eventRelays.has("never-existed")).toBe(false);
  });

  it("reaps the relay even though the farewell materialized it — no session outlives its stream", () => {
    // A session nobody ever watched has no relay until the broadcast lazily creates one. The reap on the
    // next line must still drop it, or every closed session would leak the relay its own farewell built.
    const state = makeState();
    state.sessions.set("sess-1", markSessionReady(createSession("sess-1", "default")));

    closeSession(state, "sess-1");

    expect(state.eventRelays.has("sess-1")).toBe(false);
  });
});

describe("closeSession structured logging (#61)", () => {
  // Rule: every session death funnels through this one seam, so a `created` with no matching `closed`
  // is a leaked slot the trail exposes.
  it("emits a `session`/`closed` event naming the session and its terminal status", () => {
    const { logger, events } = captureLogger();
    const state = makeState(logger);
    state.sessions.set("sess-1", markSessionReady(createSession("sess-1", "default")));

    closeSession(state, "sess-1");

    expect(events).toEqual([
      {
        category: "session",
        level: "info",
        event: "closed",
        sessionId: "sess-1",
        status: "closed",
        detail: "session ended (closed)",
      },
    ]);
  });

  it("carries the terminal status through — an errored session is logged `errored`, not overwritten", () => {
    const { logger, events } = captureLogger();
    const state = makeState(logger);
    state.sessions.set("sess-1", { ...createSession("sess-1", "default"), status: "errored" });

    closeSession(state, "sess-1");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ category: "session", event: "closed", status: "errored" });
  });

  it("emits NOTHING for a session that was already gone — an idempotent no-op does not fabricate a death", () => {
    const { logger, events } = captureLogger();
    const state = makeState(logger);

    closeSession(state, "never-existed");

    expect(events).toEqual([]);
  });
});
