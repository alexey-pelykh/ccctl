// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { createSession, markSessionReady, type Session } from "@ccctl/core";
import { createSessionEventRelays, relayFor } from "./event-stream.js";
import { closeSession, type SessionCloseState } from "./session-close.js";

// The terminal-transition seam (#76) in ISOLATION — the one place a session ENDS, whichever of the two
// things ended it (the operator stopped it; its worker went terminally silent). Hermetic: no server, no
// HTTP, no surfaces. The wired-through behavior is covered by `ui-session-stop.test.ts` (the stop path)
// and `worker-channel.test.ts` (the #173 eviction path).

function makeState(): SessionCloseState {
  return { sessions: new Map<string, Session>(), eventRelays: createSessionEventRelays() };
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
