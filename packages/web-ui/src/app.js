// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * @ccctl/web-ui — zero-build UI.
 *
 * Vanilla ES module, no framework and no bundler. It talks to @ccctl/server
 * over four channels, the last three all SESSION-ADDRESSED (#20) so more than one
 * running session can be carried at once:
 *   - launch:     a fetch() POST of `/api/sessions` LAUNCHES a fresh session (#37/#31, UC2) —
 *     the "New session" control's optional initial prompt + working directory/project. The
 *     launched session is `registering` from birth (#33), so the list leg below surfaces it;
 *   - list:       a fetch() GET of `/api/sessions`, POLLED on an interval, enumerates the
 *     sessions the daemon is carrying (#20) and keeps each row's per-session status live as
 *     sessions change state (#25); the user picks one to view + steer.
 *   - downstream: an EventSource (Server-Sent Events) on `/api/sessions/{id}/events`
 *     receives the control_event frames the server relays from the SELECTED session's
 *     Claude Code worker (#15) — never another session's (#20);
 *   - upstream:   fetch() POSTs one of three steer verbs — input / approve /
 *     redirect — to `/api/sessions/{id}/command`, which the server re-frames as a
 *     control_request onto THAT session's worker channel (#16/#20).
 *
 * This shell is deliberately thin: every decode/classify/format decision lives
 * in the DOM-free `./transcript.js` (unit-tested), every verb→frame decision
 * in the DOM-free `./command.js` (unit-tested), every list diff / label /
 * selection decision in the DOM-free `./sessions.js` (unit-tested), every launch
 * body / typed-failure decision in the DOM-free `./launch.js` (unit-tested), and the
 * connection-health verdict in the DOM-free `./connection.js` (unit-tested).
 * Here we only wire DOM controls to those builders and apply their results to
 * the page. Each poll updates the picker IN PLACE (only the rows that changed)
 * so it stays live without flicker; the always-visible connection-health
 * indicator reflects the two TRANSPORT legs — the poll (fetch) heartbeat and the
 * selected session's SSE stream — as live / reconnecting / offline (#75), never a
 * session's worker status; an accepted launch refreshes the picker so the new session
 * shows at once and a failed one surfaces its TYPED code (#37); selecting a session
 * (re)opens its stream and clears the prior session's transcript; a `worker_status`
 * frame updates the CURRENT-TURN indicator in place; every other control event is
 * appended to the TRANSCRIPT; an undecodable line is surfaced verbatim rather than
 * dropped; and an accepted steer is echoed into the transcript (marked outbound) so
 * it is reflected in the viewed session.
 */

import { processEventData } from "./transcript.js";
import {
  SESSIONS_PATH,
  sessionEventsPath,
  sessionCommandPath,
  inputCommand,
  approveCommand,
  redirectCommand,
  describeCommand,
} from "./command.js";
import { diffSessionList, nextSelection, notificationsDegraded } from "./sessions.js";
import { connectionHealth } from "./connection.js";
import { applyPairingToken, authHeader } from "./pairing.js";
import { DEVICES_PATH, deviceLabel, isCurrentDevice, isRenderableDevice } from "./devices.js";
import { launchRequest, launchFailure, describeLaunchAccepted } from "./launch.js";
import { sessionStopPath, stopRequest, stopFailure, describeStopAccepted, keepStopControlDisabled } from "./stop.js";
import {
  PUSH_VAPID_PUBLIC_KEY_PATH,
  PUSH_SUBSCRIPTION_PATH,
  urlBase64ToUint8Array,
  pushSubscribeOptions,
  vapidPublicKeyFromResponse,
  toServerSubscription,
} from "./push.js";

const connectionEl = document.getElementById("connection");
const statusEl = document.getElementById("status");
const activityEl = document.getElementById("activity");
const eventsEl = document.getElementById("events");
const sessionListEl = document.getElementById("session-list");
const refreshSessionsEl = document.getElementById("refresh-sessions");
const launchFormEl = document.getElementById("launch-form");
const launchCwdEl = document.getElementById("launch-cwd");
const launchProjectEl = document.getElementById("launch-project");
const launchPromptEl = document.getElementById("launch-prompt");
const launchButtonEl = document.getElementById("launch-button");
const launchStatusEl = document.getElementById("launch-status");
const promptFormEl = document.getElementById("prompt-form");
const promptInputEl = document.getElementById("prompt-input");
const redirectFormEl = document.getElementById("redirect-form");
const redirectInputEl = document.getElementById("redirect-input");
const approveButtonEl = document.getElementById("approve-button");
const stopButtonEl = document.getElementById("stop-button");
const stopStatusEl = document.getElementById("stop-status");
const deviceListEl = document.getElementById("device-list");
const refreshDevicesEl = document.getElementById("refresh-devices");
const enablePushEl = document.getElementById("enable-push");
const pushStatusEl = document.getElementById("push-status");

/** The session currently viewed + steered, or null when none is selected. */
let currentSessionId = null;
/** The active EventSource for the selected session, or null when disconnected. */
let source = null;
/** The picker rows currently in the DOM, keyed by session id, so a poll updates them in place. */
const sessionRows = new Map();
/** The session summaries last applied to the picker — the "previous" side of each poll's diff. */
let renderedSessions = [];
/** How often the picker re-polls `/api/sessions` so each row's per-session status stays live (#25 AC3). */
const SESSION_POLL_INTERVAL_MS = 2000;
/** The pending next-poll timer id, or null when no poll is scheduled. */
let pollTimer = null;
/** Whether a session-list poll is already in flight, so a manual refresh can't stack a second poll loop. */
let polling = false;
/** Whether the empty-state placeholder is up, so a poll over an empty list doesn't re-render it. */
let emptyPlaceholderShown = false;
/** The session-list heartbeat (fetch) leg: "pending" until the first poll settles, then "ok" / "failed". */
let pollState = "pending";
/** The selected session's downstream SSE leg: "idle" (none) | "connecting" | "open" | "reconnecting". */
let streamState = "idle";
/** The last connection-health verdict painted to #connection, so an unchanged poll doesn't re-announce it. */
let renderedConnection = null;
/**
 * Whether a launch POST is already in flight, so the "New session" control cannot stack a second one.
 *
 * The client half of the very loop `maxSessions` (#36) defends against server-side: every launch
 * spawns a REAL terminal on the operator's host, and a double-tap on a phone is the cheapest way to
 * ask for two. The server's cap is the authority (it also bounds a replaying proxy this flag cannot
 * see); this simply stops the UI from being the thing that asks.
 */
let launching = false;
/**
 * Whether a stop POST is already in flight, so the control cannot stack a second one.
 *
 * The mirror of `launching` above, and it guards the same shape of mistake from the opposite end of
 * a session's life: a double-tap on a phone is the cheapest way to send two of anything. A second
 * stop is not destructive twice over — the server's guards are the authority, and a refused stop
 * touches no state — but the answers race, so the operator could be shown `unknown-session` (the
 * first stop's own success, seen by the second) as if their stop had failed. That is exactly the
 * wrong thing to tell someone who just killed a runaway.
 *
 * This flag alone does NOT close that window: it only covers the CONCURRENT one (a second tap while
 * the first POST is in flight). The window that outlives it is the one AFTER a successful stop —
 * the picker's refresh is still in flight, so the session is still selected and still looks
 * stoppable. {@link stop} closes that half by not re-enabling the control on a confirmed stop; the
 * two together are what make the sentence above true.
 */
let stopping = false;

/** Build one transcript `<li>`: a bold subtype label plus an optional human summary. */
function transcriptItem(subtype, summary) {
  const li = document.createElement("li");
  const label = document.createElement("strong");
  label.textContent = subtype;
  li.appendChild(label);
  if (summary !== "") {
    li.appendChild(document.createTextNode(` ${summary}`));
  }
  return li;
}

/** Append one control event to the transcript. */
function appendTranscript(subtype, summary) {
  eventsEl.appendChild(transcriptItem(subtype, summary));
}

/** Append a steer we sent, marked outbound so it reads as ours rather than the worker's. */
function appendOutbound(subtype, summary) {
  const li = transcriptItem(subtype, summary);
  li.dataset.outbound = "true";
  eventsEl.appendChild(li);
}

/** Append an undecodable line verbatim, marked so it reads as raw, not content. */
function appendUnparsed(raw) {
  const li = document.createElement("li");
  li.dataset.unparsed = "true";
  li.textContent = raw;
  eventsEl.appendChild(li);
}

/** Update the current-turn indicator in place (latest worker_status wins). */
function renderActivity(status, text) {
  activityEl.hidden = false;
  activityEl.dataset.status = status;
  activityEl.textContent = text;
}

/**
 * Repaint the always-visible connection-health indicator from the two transport legs (#75).
 * The verdict — live / reconnecting / offline — is `./connection.js`'s pure reduction of the
 * poll (fetch) heartbeat and the selected session's SSE stream; `data-connection` drives the
 * colour and the text is the state word. Guarded so an unchanged verdict (e.g. a steady poll
 * every 2s while live) neither rewrites the DOM nor re-announces to the `aria-live` region.
 */
function renderConnection() {
  const verdict = connectionHealth({ poll: pollState, stream: streamState });
  if (verdict === renderedConnection) {
    return;
  }
  renderedConnection = verdict;
  connectionEl.dataset.connection = verdict;
  connectionEl.textContent = verdict;
}

/** Apply one SSE line to the page via the instruction `./transcript.js` returns. */
function handleEvent(data) {
  const instruction = processEventData(data);
  switch (instruction.kind) {
    case "activity":
      renderActivity(instruction.status, instruction.text);
      break;
    case "transcript":
      appendTranscript(instruction.subtype, instruction.summary);
      break;
    case "unparsed":
      appendUnparsed(instruction.raw);
      break;
  }
}

/**
 * A standing "notifications degraded" badge for a non-prompting session (#26/#27). It is a
 * SIBLING of the row button, never a child of it: a poll relabels a row via
 * `button.textContent = label`, which would wipe a badge nested inside the button — as a
 * sibling it survives every relabel. It carries an id so the button can point at it as its
 * accessible description ({@link createSessionRow}).
 */
function createDegradedBadge(sessionId) {
  const badge = document.createElement("span");
  badge.id = `degraded-${sessionId}`;
  badge.dataset.badge = "notifications-degraded";
  badge.textContent = "notifications degraded";
  badge.title =
    "This session runs in a non-prompting mode (acceptEdits / bypassPermissions); it won't raise needs-you notifications.";
  return badge;
}

/**
 * Build one picker row: a full-width button whose click views + steers that session, plus —
 * for a session carrying the degraded-notification marker (#26) — a standing badge (#27).
 *
 * The badge must sit OUTSIDE the button to survive a poll's relabel (see
 * {@link createDegradedBadge}), which also keeps it out of the button's accessible NAME — so a
 * screen-reader user tabbing the picker would hear the row but never the badge, and the
 * `aria-live` list would announce it only once at insertion. That is the one-time-transient
 * reading the marker is meant NOT to have, so the button points at the badge via
 * `aria-describedby`: focusing the row announces name + description, every time, for as long as
 * the session lives. (Session ids are server-minted UUIDs — valid, unique `id` tokens.)
 */
function createSessionRow(sessionId, label, degraded) {
  const li = document.createElement("li");
  li.dataset.sessionId = sessionId;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => selectSession(sessionId));
  li.appendChild(button);
  if (degraded) {
    const badge = createDegradedBadge(sessionId);
    li.appendChild(badge);
    button.setAttribute("aria-describedby", badge.id);
  }
  return li;
}

/**
 * Apply the latest session list to the picker IN PLACE via the diff `./sessions.js`
 * returns: drop vanished rows, add fresh ones, relabel only the rows whose status /
 * activity moved, and reorder to the server's list. Updating in place (rather than
 * rebuilding on every poll) keeps button focus and the current selection, and lets the
 * `aria-live` list announce only real changes instead of re-reading the whole list each
 * interval. An empty list shows a placeholder (not a tracked row).
 */
function applySessionList(sessions) {
  if (sessions.length === 0) {
    // Only (re)render the placeholder on the transition into empty, so a poll over a
    // still-empty list doesn't re-announce "No sessions yet." to the aria-live region.
    if (!emptyPlaceholderShown) {
      sessionRows.clear();
      const li = document.createElement("li");
      li.textContent = "No sessions yet.";
      sessionListEl.replaceChildren(li);
      emptyPlaceholderShown = true;
    }
    renderedSessions = [];
    return;
  }
  // Coming from the empty-state placeholder (which is not a tracked row): clear it first.
  if (emptyPlaceholderShown) {
    sessionListEl.replaceChildren();
    emptyPlaceholderShown = false;
  }
  const diff = diffSessionList(renderedSessions, sessions);
  // The degraded marker is per-session and life-long, so it is read at row birth (below),
  // not carried through the label diff — a status/activity change never toggles the badge.
  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (const id of diff.removed) {
    sessionRows.get(id)?.remove();
    sessionRows.delete(id);
  }
  for (const { id, label } of diff.added) {
    const li = createSessionRow(id, label, notificationsDegraded(byId.get(id)));
    sessionRows.set(id, li);
    sessionListEl.appendChild(li);
  }
  for (const { id, label } of diff.updated) {
    const button = sessionRows.get(id)?.querySelector("button");
    if (button !== null && button !== undefined) {
      button.textContent = label;
    }
  }
  // Reorder to the server's list ONLY when the DOM order actually differs — appendChild
  // MOVES a node, so re-appending every poll would churn the list (and its aria-live
  // announcements) even when nothing moved. New rows append at the end, which already
  // matches the server's insertion order in the common case, so this rarely fires.
  const domOrder = [...sessionListEl.children].map((li) => li.dataset.sessionId);
  const orderMatches = domOrder.length === diff.order.length && domOrder.every((id, index) => id === diff.order[index]);
  if (!orderMatches) {
    for (const id of diff.order) {
      const li = sessionRows.get(id);
      if (li !== undefined) {
        sessionListEl.appendChild(li);
      }
    }
  }
  renderedSessions = sessions;
  markSelected();
}

/** Move the selection highlight to the current session without re-fetching the list. */
function markSelected() {
  for (const li of sessionListEl.children) {
    if (li.dataset.sessionId === currentSessionId) {
      li.dataset.selected = "true";
    } else {
      delete li.dataset.selected;
    }
  }
}

/** Fetch and reconcile the session list; auto-select the first on first load, drop a vanished selection. */
async function loadSessions() {
  let payload;
  try {
    const response = await fetch(SESSIONS_PATH, { headers: authHeader(localStorage) });
    if (!response.ok) {
      throw new Error(`list failed (${response.status})`);
    }
    payload = await response.json();
    // The heartbeat beat: the phone can reach the server (#75).
    pollState = "ok";
    renderConnection();
  } catch (error) {
    statusEl.textContent = `could not list sessions: ${error.message}`;
    // The heartbeat missed: the request path — which steering also rides — is down (#75).
    pollState = "failed";
    renderConnection();
    return;
  }
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  applySessionList(sessions);
  const selection = nextSelection(currentSessionId, sessions);
  if (selection.kind === "select") {
    // Nothing selected yet: view the first session so the UI is useful on first load.
    selectSession(selection.id);
  } else if (selection.kind === "clear") {
    // The selected session is gone: stop viewing it.
    disconnect();
    currentSessionId = null;
    statusEl.textContent = "no session selected";
    // The current-turn indicator is a LIVE claim about a session that no longer exists, so it goes.
    // Leaving it is how an operator who just emergency-stopped a runaway ends up reading "working…"
    // over the session they killed. (#173's eviction timer reached this branch before #77; the stop
    // control makes it this feature's HAPPY path, which is what promotes it from an edge case.)
    //
    // The TRANSCRIPT deliberately stays, and the asymmetry with `selectSession` — which drops both —
    // is the point: `activityEl` asserts what a session is doing NOW and is simply false once it is
    // gone, while `eventsEl` is a historical record that is still true, and is the last evidence of
    // what the runaway actually did. `selectSession` clears it because a DIFFERENT session's stream
    // is about to write there; here nothing is, so there is nothing to confuse it with.
    activityEl.hidden = true;
    // Nothing selected: there is nothing to stop.
    renderStopControl();
    // Drop a REFUSAL — its subject is gone, so it is stale news, and (for `taken-over`) it carries a
    // live "Stop anyway" button that would otherwise outlive the session it points at. A SUCCESS
    // line stays: this is the branch a successful stop itself arrives on, so clearing it would wipe
    // the "stopped … — closed" answer the operator is reading.
    if (stopStatusEl.dataset.stop === "failed") {
      stopStatusEl.hidden = true;
      stopStatusEl.replaceChildren();
      delete stopStatusEl.dataset.stop;
    }
    markSelected();
  }
}

/**
 * Read a response's JSON body, or null when there isn't one to read. Every launch answer — accepted
 * or failed — is JSON from ccctl's own ingress, but the operator's phone reaches it across a tunnel
 * that can interpose an error page of its own, so a body is never assumed to parse. `./launch.js`
 * reads a null payload as honestly as a partial one.
 */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Paint the launch outcome (#37). `data-launch` carries the state for colour; a TYPED failure also
 * renders its `code` as a bold chip ahead of the sentence — mirroring how the transcript renders a
 * frame's subtype — so the operator SEES which failure it is (AC3) rather than having to
 * pattern-match the prose. The region is `aria-live`, so each outcome is announced once.
 */
function renderLaunchStatus(state, text, code) {
  launchStatusEl.hidden = false;
  launchStatusEl.dataset.launch = state;
  if (code === undefined) {
    launchStatusEl.textContent = text;
    return;
  }
  const chip = document.createElement("strong");
  chip.dataset.launchCode = code;
  chip.textContent = code;
  launchStatusEl.replaceChildren(chip, document.createTextNode(` ${text}`));
}

/**
 * POST one launch upstream: the server runs its injected launcher, places the new session in the
 * registry as `registering`, and answers 201 with the minted id + how to attach to the surface.
 *
 * On success the picker is refreshed at once, so the launched session appears in the list (AC2)
 * rather than up to a poll interval later — it needs no row of its own here, because it is in the
 * registry from birth (#33) and the list leg already renders it.
 *
 * This does not itself select the launched session — but note that the picker's existing first-load
 * rule (`nextSelection`) still MAY: launching into an empty list leaves nothing selected, so the
 * refresh below auto-selects the new `registering` row and opens its stream. That is benign, and
 * checked rather than assumed: the server holds an SSE open for a `registering` session (it 404s
 * only an UNKNOWN one), so the stream simply carries nothing until the worker registers and the row
 * advances in place — and if the worker never comes, the eviction (#33) drops the row, which
 * `nextSelection` reads as `clear` and `loadSessions` disconnects. So the operator watching their
 * own launch come up is exactly the intended reading, not a promise the session cannot keep.
 *
 * A failure surfaces the server's TYPED code plus its own actionable sentence (AC3) — never an
 * opaque "launch failed".
 */
async function submitLaunch(request) {
  const response = await fetch(SESSIONS_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(localStorage) },
    body: JSON.stringify(request),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const failure = launchFailure(response.status, payload);
    renderLaunchStatus("failed", failure.message, failure.code);
    return;
  }
  renderLaunchStatus("launched", describeLaunchAccepted(payload));
  // The initial prompt is consumed by the launch it seeded — clearing it stops the next "New
  // session" tap from silently re-seeding the same prompt. Cleared on SUCCESS only, unlike the
  // steer forms above (which clear optimistically on submit): a launch can fail eight typed ways,
  // and making the operator retype their prompt to fix a mistyped directory would be hostile. The
  // cwd / project are their standing context and stay put for the next launch.
  launchPromptEl.value = "";
  refreshSessionsNow();
}

/**
 * Paint the stop outcome (#77). `data-stop` carries the state for colour; a TYPED refusal also
 * renders its `code` as a bold chip ahead of the sentence — the same treatment the launch status
 * gives its own code, so the operator SEES which refusal it is rather than pattern-matching prose.
 * The region is `aria-live`, so each outcome is announced once.
 *
 * `onForce`, when given, appends the escalation button. It is passed ONLY for a refusal `stop.js`
 * marked forceable (`taken-over`), so force is never a standing control — it exists for one refusal,
 * for as long as that refusal is on screen, and the next outcome replaces it. That makes the
 * two-step (stop → refused → stop anyway) a confirm by construction rather than a dialog bolted on.
 */
function renderStopStatus(state, text, code, onForce) {
  stopStatusEl.hidden = false;
  stopStatusEl.dataset.stop = state;
  const nodes = [];
  if (code !== undefined) {
    const chip = document.createElement("strong");
    chip.dataset.stopCode = code;
    chip.textContent = code;
    nodes.push(chip, document.createTextNode(` ${text}`));
  } else {
    nodes.push(document.createTextNode(text));
  }
  if (onForce !== undefined) {
    const force = document.createElement("button");
    force.id = "stop-force-button";
    force.type = "button";
    force.textContent = "Stop anyway";
    force.addEventListener("click", onForce);
    nodes.push(force);
  }
  stopStatusEl.replaceChildren(...nodes);
}

/**
 * POST one stop upstream for the SELECTED session: the server kills its terminal (honouring its own
 * safety envelope) and drives the session to its terminal state.
 *
 * On success the picker is refreshed at once, so the stopped session leaves the list rather than
 * lingering up to a poll interval — the mirror of what an accepted launch does, and the list's own
 * reflection of the terminal state: `session-close.ts` DROPS the row rather than retaining a
 * readable `closed` one (a retained row would hold its `maxSessions` slot forever, so stopping
 * sessions would walk the server into a permanent `at-capacity` — the emergency-stop's own promise,
 * end one and free a slot, would be the first thing it broke). The terminal STATUS is reflected in
 * the status line here, from the server's own answer.
 *
 * The refresh also clears the selection: `nextSelection` reads the vanished session as `clear`, so
 * `loadSessions` disconnects its stream and drops the current-turn indicator, which is a live claim
 * about a session that no longer exists. The TRANSCRIPT deliberately stays (see the `clear` branch).
 *
 * A refusal surfaces the server's TYPED code plus its actionable sentence — and, for the ONE refusal
 * force overrides (`taken-over`: someone is driving it at a terminal), an escalation that re-sends
 * the same stop with the operator's explicit consent. That consent is the whole of what force means:
 * the server refuses because it cannot know whether a human is at that terminal, and the operator
 * pressing this IS that human, saying they want it stopped.
 *
 * Resolves TRUE when the server confirmed the session is over, and FALSE when it refused — which is
 * what {@link stop} re-enables the control from. The distinction is exactly the one that makes a
 * refusal safe to retry: a refused stop touches no state, so the session is still there to stop.
 */
async function submitStop(sessionId, options) {
  const response = await fetch(sessionStopPath(sessionId), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(localStorage) },
    body: JSON.stringify(stopRequest(options)),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const failure = stopFailure(response.status, payload);
    // The escalation re-sends THIS session's stop — never the currently-selected one, which may have
    // moved on by the time the operator reads the refusal. A stop addresses the session it named.
    renderStopStatus(
      "failed",
      failure.message,
      failure.code,
      failure.forceable ? () => stop(sessionId, { force: true }) : undefined,
    );
    return false;
  }
  renderStopStatus("stopped", describeStopAccepted(payload));
  refreshSessionsNow();
  return true;
}

/**
 * Stop one session from a DOM control: guard the double-tap, disable for the in-flight window, and
 * surface a network throw (no answer at all, distinct from a typed refusal) in the same line rather
 * than as an unhandled rejection. The shell half of {@link submitStop}, shared by the button and the
 * force escalation.
 */
async function stop(sessionId, options) {
  if (stopping) {
    return;
  }
  stopping = true;
  stopButtonEl.disabled = true;
  renderStopStatus("stopping", options?.force === true ? "stopping (forced)…" : "stopping…");
  let stopped = false;
  try {
    stopped = await submitStop(sessionId, options);
  } catch (error) {
    renderStopStatus("failed", `ccctl: could not reach the server — ${error.message}`);
  } finally {
    stopping = false;
    // The rule — and the race that makes it necessary — lives with the predicate in `stop.js`, where
    // it is pinned by tests; this is the wiring onto it.
    if (keepStopControlDisabled({ stopped, currentSessionId, sessionId })) {
      stopButtonEl.disabled = true;
    } else {
      renderStopControl();
    }
  }
}

/**
 * Reflect the current selection onto the stop control: it names the session it will kill, and is
 * disabled when there is nothing selected to kill (#20 — never inferred). A selection CHANGE also
 * drops the prior session's stop outcome, which is not news about the newly-viewed one.
 */
function renderStopControl() {
  stopButtonEl.disabled = currentSessionId === null || stopping;
  stopButtonEl.textContent = currentSessionId === null ? "Stop session" : `Stop ${currentSessionId}`;
}

/** Close the active EventSource, if any, and drop the stream leg to idle. */
function disconnect() {
  if (source !== null) {
    source.close();
    source = null;
  }
  // The stream leg is now idle — the connection-health verdict falls back to the poll heartbeat
  // alone (so clearing a vanished selection doesn't leave a stale "reconnecting" downstream state).
  streamState = "idle";
  renderConnection();
}

/** Subscribe to a session's downstream control-event stream. */
function connect(sessionId) {
  statusEl.textContent = "connecting…";
  streamState = "connecting";
  renderConnection();
  // The downstream is an EventSource, which cannot carry an Authorization header; applying the
  // paired token to the SSE stream (a query token would land in the server log, so not that)
  // is deferred to the later credentialed-wave item that also adds server-side enforcement (#74
  // applies the token to the fetch legs above; ingress is unauthenticated at this slice).
  source = new EventSource(sessionEventsPath(sessionId));

  source.addEventListener("open", () => {
    statusEl.textContent = `connected — ${sessionId}`;
    streamState = "open";
    renderConnection();
  });

  source.addEventListener("message", (event) => {
    handleEvent(event.data);
  });

  source.addEventListener("error", () => {
    statusEl.textContent = "disconnected — reconnecting…";
    streamState = "reconnecting";
    renderConnection();
    // EventSource reconnects automatically, replaying past its Last-Event-ID;
    // the server reconciles the gap per session (#13/#20), so nothing else to do here.
  });
}

/** View + steer a session: drop the prior stream + transcript and open this one's. */
function selectSession(sessionId) {
  if (sessionId === currentSessionId) {
    return;
  }
  disconnect();
  currentSessionId = sessionId;
  // A fresh session view starts clean — the prior session's transcript / activity is not ours, and
  // neither is its stop outcome (a refusal about a session we are no longer looking at, still
  // offering to force-kill it, is the worst thing this control could leave on screen).
  eventsEl.replaceChildren();
  activityEl.hidden = true;
  stopStatusEl.hidden = true;
  stopStatusEl.replaceChildren();
  renderStopControl();
  markSelected();
  connect(sessionId);
}

/**
 * POST one steer command upstream to the SELECTED session; the server re-frames it as
 * a control_request onto that session's worker channel and answers 202 with the minted
 * id. On success the accepted steer is echoed into the transcript (marked outbound), so
 * it is reflected in the viewed session even before the worker's own events flow back
 * down the SSE stream. A non-2xx answer surfaces as an error entry.
 */
async function sendSteer(command) {
  if (currentSessionId === null) {
    appendTranscript("error", "select a session to steer");
    return;
  }
  const response = await fetch(sessionCommandPath(currentSessionId), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(localStorage) },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    throw new Error(`ccctl: steer failed (${response.status})`);
  }
  appendOutbound(command.subtype, describeCommand(command));
}

/** Send a steer built from a DOM control; no-op on a blank build, surface failures. */
function steer(command) {
  if (command === null) {
    return;
  }
  sendSteer(command).catch((error) => {
    appendTranscript("error", error.message);
  });
}

/**
 * Poll the session list now, then arm the next poll so the picker's per-session status stays live.
 * A poll already in flight short-circuits (a manual refresh mid-fetch must not start a second poll
 * loop); the in-flight one re-arms the timer on completion. `finally` re-arms even on an unexpected
 * throw, so a transient failure never kills the loop.
 */
async function pollSessions() {
  if (polling) {
    return;
  }
  polling = true;
  try {
    await loadSessions();
  } finally {
    polling = false;
    scheduleNextPoll();
  }
}

/** Arm the next session-list poll — a single-shot timer re-armed after each poll (no overlap). */
function scheduleNextPoll() {
  pollTimer = setTimeout(pollSessions, SESSION_POLL_INTERVAL_MS);
}

/**
 * Re-list NOW and restart the poll clock, so an out-of-band refresh doesn't double-fetch. Shared by
 * the Refresh button and an accepted launch (which wants its new session in the list at once, #37
 * AC2). A poll already in flight short-circuits inside `pollSessions` and re-arms the timer itself,
 * so this is safe to call at any moment.
 */
function refreshSessionsNow() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
  }
  pollSessions();
}

/**
 * Build one device row: a `<li>` keyed by device id — the stable identity a per-device revoke
 * (W6-19, AC3) will hang off — carrying the device's label (name + last-seen, AC1). The current
 * device (AC2) is marked with a `data-current` flag (styled distinctly) plus an appended
 * "· this device" note, so it reads as the current one to sighted and screen-reader users alike.
 */
function createDeviceRow(device) {
  const li = document.createElement("li");
  li.dataset.deviceId = device.id;
  li.textContent = deviceLabel(device);
  if (isCurrentDevice(device)) {
    li.dataset.current = "true";
    const note = document.createElement("span");
    note.dataset.currentNote = "true";
    note.textContent = " · this device";
    li.appendChild(note);
  }
  return li;
}

/**
 * Render the paired-device list (AC1/AC2), or a placeholder when no device is paired. Only
 * renderable devices (an object with a usable string id — the row key + revoke target, AC3) are
 * rows; a malformed wire element is dropped rather than allowed to throw (so one bad element
 * never blanks the whole list) or key a row `data-device-id="undefined"`.
 */
function applyDeviceList(devices) {
  const rows = devices.filter(isRenderableDevice);
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No paired devices.";
    deviceListEl.replaceChildren(li);
    return;
  }
  deviceListEl.replaceChildren(...rows.map(createDeviceRow));
}

/**
 * Fetch the paired-device list and render it. Fetched on load + manual Refresh — devices change
 * rarely (pair / rename / revoke), so this surface is not auto-polled like the live session list.
 * A failure surfaces as an inline error row rather than a thrown rejection; until the server wires
 * `GET /api/devices` (a later credentialed-wave item that also computes the `current` marker), that
 * error row IS the honest walking-skeleton state — exactly as `pairing.js` applies a token ahead of
 * server-side enforcement.
 */
async function loadDevices() {
  let payload;
  try {
    const response = await fetch(DEVICES_PATH, { headers: authHeader(localStorage) });
    if (!response.ok) {
      throw new Error(`list failed (${response.status})`);
    }
    payload = await response.json();
  } catch (error) {
    const li = document.createElement("li");
    li.dataset.error = "true";
    li.textContent = `could not list devices: ${error.message}`;
    deviceListEl.replaceChildren(li);
    return;
  }
  const devices = Array.isArray(payload?.devices) ? payload.devices : [];
  applyDeviceList(devices);
}

/**
 * Paint the push-enablement outcome (#51). `data-push` carries the state for colour; the region is
 * `aria-live`, so each outcome is announced once. States: `working` (requesting / subscribing),
 * `enabled` (this device is subscribed), `blocked` (the browser / OS can't or withheld permission —
 * an amber "not available / you said no", not a red error to retry blindly), `failed` (an outright
 * error). Every decision that shapes the wake itself lives in `./push.js`; this only paints the line.
 */
function renderPushStatus(state, text) {
  pushStatusEl.hidden = false;
  pushStatusEl.dataset.push = state;
  pushStatusEl.textContent = text;
}

/**
 * Register the service worker (#51) — the background half that makes the UI installable and renders
 * every push wake as a visible notification. Best-effort and SILENT on failure (a browser without
 * service workers, or a non-secure context, simply isn't a PWA); it returns the registration so the
 * enable-push flow can subscribe against it, or `null` when there is none. Served from `/sw.js`, so
 * its scope is the whole app.
 */
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return null;
  }
  try {
    return await navigator.serviceWorker.register("./sw.js");
  } catch {
    return null;
  }
}

/**
 * Enable Web-Push on THIS device (#51): request notification permission, fetch the server's VAPID
 * public key, subscribe via the PushManager (always `userVisibleOnly` — no silent push, AC2), and
 * upload the subscription in the shape the server's wake dispatch consumes (#50, AC3).
 *
 * Each failure mode surfaces its own honest line rather than a generic "failed":
 *   - no service worker / PushManager → this browser can't (an old browser, or iOS Safari before the
 *     app is installed to the home screen — Web-Push on iOS is installed-PWA only);
 *   - permission not granted → BLOCKED (amber: the operator said no, or the OS withheld it);
 *   - the VAPID-key route not wired yet → unavailable, said plainly rather than thrown — this surface
 *     runs AHEAD of the server, exactly as `pairing.js` (#74) and `devices.js` (#85) do;
 *   - the subscribe / upload rejected → failed.
 * An existing subscription is reused rather than re-created, so a second tap is idempotent.
 */
async function enablePush() {
  const registration = await registerServiceWorker();
  if (registration === null || !("pushManager" in registration)) {
    renderPushStatus(
      "blocked",
      "ccctl: this browser can't receive push notifications (on iOS, install the app first).",
    );
    return;
  }
  renderPushStatus("working", "enabling notifications…");
  // Permission first: a subscribe without it throws, and a denied permission is a "you said no", not
  // an error to retry blindly.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    renderPushStatus("blocked", `ccctl: notifications are ${permission} — allow them in your browser to be woken.`);
    return;
  }
  // The server's VAPID public key binds the subscription to this application server (#50). Until the
  // server wires GET /api/push/vapid-public-key this yields no key, and the surface says so.
  let vapidKey;
  try {
    const response = await fetch(PUSH_VAPID_PUBLIC_KEY_PATH, { headers: authHeader(localStorage) });
    vapidKey = response.ok ? vapidPublicKeyFromResponse(await readJson(response)) : null;
  } catch {
    vapidKey = null;
  }
  if (vapidKey === null) {
    renderPushStatus("blocked", "ccctl: push isn't available yet — the server hasn't published its VAPID key.");
    return;
  }
  // Reuse an existing subscription (idempotent re-tap), else create one — always userVisibleOnly.
  let subscription;
  try {
    subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe(pushSubscribeOptions(urlBase64ToUint8Array(vapidKey))));
  } catch (error) {
    renderPushStatus("failed", `ccctl: could not subscribe to push — ${error.message}`);
    return;
  }
  const serverSubscription = toServerSubscription(subscription.toJSON());
  if (serverSubscription === null) {
    renderPushStatus("failed", "ccctl: the browser returned an unusable subscription.");
    return;
  }
  // Upload the subscription the server's wake dispatch (#50) sends to (AC3). This route is wired with
  // the same later server slice as the VAPID key; a non-2xx is surfaced, not thrown.
  try {
    const response = await fetch(PUSH_SUBSCRIPTION_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader(localStorage) },
      body: JSON.stringify(serverSubscription),
    });
    if (!response.ok) {
      renderPushStatus("failed", `ccctl: the server refused the subscription (${response.status}).`);
      return;
    }
  } catch (error) {
    renderPushStatus("failed", `ccctl: could not reach the server — ${error.message}`);
    return;
  }
  renderPushStatus("enabled", "Notifications enabled — you'll be woken when a session needs you.");
}

// refresh: re-list the sessions on demand.
refreshSessionsEl.addEventListener("click", refreshSessionsNow);

// new session: launch one (#37). The cwd is `required` in the markup, so the browser blocks a blank
// submit before this runs; `launchRequest` returning null is the defensive second half of that pair.
// The control is disabled for the whole in-flight window — a launch spawns a real terminal, so a
// double-tap must not ask for two — and a network throw (no answer at all, distinct from a typed
// refusal) surfaces in the same line rather than as an unhandled rejection.
launchFormEl.addEventListener("submit", (event) => {
  event.preventDefault();
  if (launching) {
    return;
  }
  const request = launchRequest({
    cwd: launchCwdEl.value,
    project: launchProjectEl.value,
    initialPrompt: launchPromptEl.value,
  });
  if (request === null) {
    return;
  }
  launching = true;
  launchButtonEl.disabled = true;
  renderLaunchStatus("launching", "launching…");
  submitLaunch(request)
    .catch((error) => {
      renderLaunchStatus("failed", `ccctl: could not reach the server — ${error.message}`);
    })
    .finally(() => {
      launching = false;
      launchButtonEl.disabled = false;
    });
});

// input: send the prompt text to the current turn.
promptFormEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const command = inputCommand(promptInputEl.value);
  if (command === null) {
    return;
  }
  promptInputEl.value = "";
  steer(command);
});

// redirect: interrupt the current turn with a new direction.
redirectFormEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const command = redirectCommand(redirectInputEl.value);
  if (command === null) {
    return;
  }
  redirectInputEl.value = "";
  steer(command);
});

// approve: let the pending action proceed.
approveButtonEl.addEventListener("click", () => {
  steer(approveCommand());
});

// stop: kill the SELECTED session's terminal outright (#77). Never forced from here — the plain stop
// is the non-destructive-by-default one, and the server's `taken-over` refusal is what offers the
// escalation. The button is disabled with no selection, so the guard below is the defensive second
// half of that pair (for a click that raced a selection being cleared).
stopButtonEl.addEventListener("click", () => {
  if (currentSessionId === null) {
    return;
  }
  stop(currentSessionId);
});

// devices: re-list the operator's paired devices on demand (#85).
refreshDevicesEl.addEventListener("click", () => {
  loadDevices();
});

// enable notifications: subscribe THIS device to Web-Push so a blocked session can wake the operator
// while the app is backgrounded / closed (#51). Disabled for the in-flight window so a double-tap
// can't stack two permission/subscribe flows; re-enabled whatever the outcome so a blocked/failed
// attempt can be retried after the operator fixes it (grants permission, installs the app).
enablePushEl.addEventListener("click", () => {
  enablePushEl.disabled = true;
  enablePush().finally(() => {
    enablePushEl.disabled = false;
  });
});

// Apply a scanned QR-pair token (#74) BEFORE the first request: read it from the URL fragment,
// persist it, and scrub it from the URL so the secret does not linger in the address bar / history.
// A returning paired device reuses its stored token; every fetch above then carries it as an
// Authorization: Bearer header.
applyPairingToken({ location, history, storage: localStorage });

// Seed the connection-health indicator (#75): "reconnecting" until the first heartbeat settles it.
renderConnection();

// List now and keep polling so the picker's per-session status stays live (#25 AC3).
pollSessions();

// List the operator's paired devices (#85); re-listed on demand via the Devices Refresh button.
loadDevices();

// Register the service worker on load so the UI is installable as a PWA and ready to render push
// wakes (#51); a browser without service workers simply isn't a PWA (best-effort, silent). Enabling
// push — subscribing this device — is an explicit operator action via the "Enable notifications"
// button above.
registerServiceWorker();
