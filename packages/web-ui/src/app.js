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
  answerCommand,
  describeCommand,
} from "./command.js";
import {
  SHORTCUT_CHIPS,
  decodeEnrichment,
  enrichmentMatchesBlock,
  submitsOnTap,
  answerFromSelections,
} from "./enrichment.js";
import { diffSessionList, nextSelection, notificationsDegraded, sessionCursor, laterCursor } from "./sessions.js";
import { connectionHealth } from "./connection.js";
import { applyPairingToken, authHeader } from "./pairing.js";
import { DEVICES_PATH, deviceLabel, deviceRevokePath, isCurrentDevice, isRenderableDevice } from "./devices.js";
import { launchRequest, launchFailure, describeLaunchAccepted } from "./launch.js";
import { sessionStopPath, stopRequest, stopFailure, describeStopAccepted, keepStopControlDisabled } from "./stop.js";
import {
  PUSH_VAPID_PUBLIC_KEY_PATH,
  PUSH_SUBSCRIPTION_PATH,
  urlBase64ToUint8Array,
  pushSubscribeOptions,
  vapidPublicKeyFromResponse,
  toServerSubscription,
  consumeDeepLinkSessionId,
  navigateMessageSessionId,
} from "./push.js";
import {
  NEEDS_YOU_RECONCILE_PATH,
  NEEDS_YOU_ACK_PATH,
  reconcileNeedsYou,
  needsYouAckBody,
  needsYouKey,
  needsYouDetail,
} from "./needs-you.js";
import {
  QUEUED_STALE,
  shouldQueueSteer,
  queuedSteer,
  cancelQueued,
  partitionQueueForFire,
  sessionMovedOn,
} from "./steer-queue.js";

const connectionEl = document.getElementById("connection");
const statusEl = document.getElementById("status");
const activityEl = document.getElementById("activity");
const needsYouQuestionEl = document.getElementById("needs-you-question");
const shortcutChipsEl = document.getElementById("shortcut-chips");
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
const steerQueueSectionEl = document.getElementById("steer-queue-section");
const steerQueueEl = document.getElementById("steer-queue");
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
/**
 * The un-acked "needs-you" entries reconciled from the queue on reconnect (#53), keyed by session id →
 * that session's un-acked {@link reconcileNeedsYou} entries. Populated by {@link reconcileNeedsYouQueue}
 * (the server's un-acked set is authoritative), drained per session by {@link ackNeedsYou} when the
 * operator views it, and painted onto the picker as a per-row "needs you" badge.
 */
const needsYou = new Map();
/**
 * The `${sessionId}:${eventId}` keys ({@link needsYouKey}) this client has already acked-by-viewing, so a
 * reconcile that fires again before the server has processed the ack does not re-badge a session the
 * operator already attended to. Grows for the page's life (bounded by a session's needs-you count) and
 * clears on reload — where a still-server-queued entry honestly re-surfaces (the backstop guarantee).
 */
const ackedNeedsYou = new Set();
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
/**
 * The optimistic offline-steer queue (#79): steers the operator submitted while the connection was
 * offline, held here and fired IN ORDER on the next reconnect so a brief tunnel drop does not lose a
 * decision. A plain array the shell owns (as it owns `renderedSessions`); `steer-queue.js` provides its
 * pure transforms. REASSIGNED, never mutated, by {@link enqueueSteer}, {@link cancelSteerQueued}, and
 * {@link fireSteerQueue} so a re-render always reads a fresh list.
 */
let steerQueue = [];
/**
 * Monotonic source of the cancel handle each queued steer carries ({@link enqueueSteer}). A plain
 * counter, deliberately not a timestamp: it needs only to be unique + stable for the page's life so a
 * Cancel targets exactly its row (position would shift as earlier items fire or cancel).
 */
let steerSeq = 0;
/**
 * Whether a queue drain is already in flight, so two reconnects in quick succession (or a manual
 * refresh racing the reconnect) do not both start firing the same queue — the mirror of `polling`.
 */
let firingQueue = false;
/**
 * The CURRENT message cursor of each session (#80), keyed by session id — the last event id the server
 * has emitted on that session's stream, the "has it moved on?" authority the stale-guard compares
 * against. Fed monotonically ({@link bumpCursor}) from BOTH legs: the 2s `/api/sessions` poll
 * ({@link applySessionList} → `sessionCursor`) covers EVERY session (including one not being viewed,
 * whose offline-queued steer must still be guarded), and the selected session's SSE stream
 * ({@link recordViewedEvent} → `event.lastEventId`) refines it live between polls.
 */
const sessionCursors = new Map();
/**
 * The cursor each session had when the operator LAST LOOKED at it (#80 AC2), keyed by session id.
 * Captured at {@link selectSession} (opening a session is looking) and advanced by each SSE event that
 * renders while it is the viewed session ({@link recordViewedEvent} — the operator sees it live), so a
 * live viewer stays caught up. It falls behind the head cursor exactly when the session moved on
 * UNSEEN — the stream was down / the poll ran ahead — which is what {@link sessionMovedOn} guards a
 * steer against. A queued steer captures THIS value; an online steer compares against it before sending.
 */
const viewedCursors = new Map();

/**
 * The VIEWED session's current `requires_action` block sequence (#201), or null when it is not blocking
 * (running / idle / closed) or the block carries no stamp. Learned LIVE from the session's SSE
 * `worker_status` frames ({@link updateBlockFromActivity} ← `transcript.js` `sequenceNum`), reset on
 * {@link selectSession}. It is the JOIN key #87 correlates {@link viewedEnrichment} against
 * ({@link enrichmentMatchesBlock}): the tappable options render ONLY when the enrichment's `sequenceNum`
 * equals this — so turn-N's options never decorate turn-N+1's block (AC5).
 */
let currentBlockSequenceNum = null;
/**
 * The decoded `AskUserQuestion` enrichment for the VIEWED session, or null when it carries none. Read
 * from that session's `SessionSummaryWire.enrichment` on each poll (#264 serves it while the session
 * blocks) and on {@link selectSession}; joined against {@link currentBlockSequenceNum} by
 * {@link renderEnrichment}. DISPLAY data authored by a possibly-ungated worker (ADR-005) — rendered as
 * text, never trusted as the #40 signal (that is `activity.kind`, off `sessions.js`).
 */
let viewedEnrichment = null;
/**
 * The operator's in-progress selection per question — `questionId → Set<label>` — for a multi-select or
 * multi-question enrichment the operator assembles before submitting (AC2). A single-question
 * single-select enrichment never populates this: it answers on the option tap ({@link submitsOnTap}).
 * Reset whenever {@link renderEnrichment} paints a DIFFERENT enrichment (a new {@link renderedEnrichmentSeq}).
 */
const enrichmentSelections = new Map();
/**
 * The `sequenceNum` of the enrichment currently PAINTED into the decision panel, or null when the panel
 * is hidden/empty. The paint guard: {@link renderEnrichment} rebuilds only when this changes, so the 2s
 * poll re-rendering the SAME outstanding question neither churns the DOM nor re-announces it to the
 * `aria-live` region (the discipline `applySessionList` takes for the picker).
 */
let renderedEnrichmentSeq = null;
/**
 * A `sequenceNum` the operator has already ANSWERED, so the panel stays hidden for the window between the
 * submit and the worker's own `requires_action`→next transition (which the join would otherwise still
 * match, re-showing an answered question and inviting a double-submit the server would 409). Reset when
 * the block clears ({@link updateBlockFromActivity}) or the session changes ({@link selectSession}).
 */
let answeredSequenceNum = null;

/**
 * Advance a per-session cursor map MONOTONICALLY — set `sessionId`'s entry to `cursor` only when it is
 * a higher non-negative integer than what is stored, so a lagging source (a 2s poll behind the live SSE,
 * or an out-of-order delivery) can never REGRESS a cursor. Shared by {@link sessionCursors} and
 * {@link viewedCursors}. A non-integer / negative `cursor` is ignored (defensive; never throws).
 */
function bumpCursor(map, sessionId, cursor) {
  if (typeof sessionId !== "string") {
    return;
  }
  const current = map.get(sessionId) ?? 0;
  const next = laterCursor(current, cursor);
  // Set only on a genuine advance — so a garbled / non-advancing sighting never MATERIALIZES an entry,
  // keeping `has(sessionId)` an honest "a real cursor has been recorded" signal (the deep-link one-shot
  // in `loadSessions` reads it to know a viewed cursor still needs initializing).
  if (next > current) {
    map.set(sessionId, next);
  }
}

/**
 * Record that the operator saw one live SSE event for the VIEWED session (#80): advance BOTH its head
 * cursor (this is the freshest signal the session moved) AND its viewed cursor (the operator is looking
 * at it right now, so they are caught up). The `lastEventId` is the SSE `id:` the server stamped;
 * `Number(lastEventId)` parses it (a blank / non-numeric id → NaN → ignored by {@link bumpCursor}).
 * No-op when nothing is selected — an event with no viewed session is not the operator looking at
 * anything.
 */
function recordViewedEvent(sessionId, lastEventId) {
  if (sessionId === null) {
    return;
  }
  const cursor = Number(lastEventId);
  bumpCursor(sessionCursors, sessionId, cursor);
  bumpCursor(viewedCursors, sessionId, cursor);
}

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

/** Append the session's terminal line, marked so it reads as ccctl's word, not the worker's. */
function appendClosed(text) {
  const li = document.createElement("li");
  li.dataset.closed = "true";
  li.textContent = text;
  eventsEl.appendChild(li);
}

/**
 * The session reached its terminal state and the server said so on its stream (#196) — the last frame
 * before it reaps the relay.
 *
 * `disconnect()` FIRST, and it is the half that fixes the actual complaint. The server's `res.end()` is
 * already on its way; an EventSource still open when it lands reads it as a fault — fires `error`, paints
 * "disconnected — reconnecting…", drives the health indicator to `reconnecting` over a link that is
 * perfectly fine, and retries into a 404 for a session that no longer exists. The frame's entire purpose
 * is that this end was EXPECTED, so the page must stop expecting more of it rather than mourn a
 * connection that never broke.
 *
 * The line goes in the TRANSCRIPT, not only on the status line, for the reason the poll's vanished-session
 * branch already spells out: `statusEl` is transport state and is overwritten with "no session selected"
 * within a poll, while `eventsEl` is the historical record and survives. "Session ended." is the last true
 * thing about the runaway the operator just killed, so it belongs at the foot of the evidence of what it
 * did — not in the one place that is about to be reused. The status line is set too, for the seconds
 * before the poll catches up: it is the honest answer to "why did the stream stop".
 *
 * `activityEl` goes for the reason it goes there too: it is a LIVE claim about a session that has ended,
 * and leaving it is how an operator reads "Running…" over the session they just stopped.
 */
function renderSessionClosed(text) {
  disconnect();
  appendClosed(text);
  statusEl.textContent = text;
  activityEl.hidden = true;
  // The session ended — any outstanding AskUserQuestion is moot; hide the decision panel (#87) so a
  // tappable question does not outlive the session it belonged to.
  currentBlockSequenceNum = null;
  viewedEnrichment = null;
  renderEnrichment();
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
      updateBlockFromActivity(instruction);
      break;
    case "transcript":
      appendTranscript(instruction.subtype, instruction.summary);
      break;
    case "closed":
      renderSessionClosed(instruction.text);
      break;
    case "unparsed":
      appendUnparsed(instruction.raw);
      break;
  }
}

/**
 * Fold a live `worker_status` activity frame into the AskUserQuestion decision surface (#87). A
 * `requires_action` frame carries the block's #201 stamp ({@link currentBlockSequenceNum}) — the join key
 * — so record it; any other status (running / idle) means the block is GONE, so drop the sequence and the
 * "already answered" guard (a fresh block later gets a new, higher stamp). Then re-render, which shows the
 * tappable options only when the enrichment joins the CURRENT block (AC5). A `requires_action` frame with
 * no stamp records `null`, which the join reads as unknown and fails safe on (no options).
 */
function updateBlockFromActivity(instruction) {
  if (instruction.status === "requires_action") {
    currentBlockSequenceNum = instruction.sequenceNum;
  } else {
    currentBlockSequenceNum = null;
    answeredSequenceNum = null;
  }
  renderEnrichment();
}

/**
 * Render (or hide) the AskUserQuestion decision panel for the viewed session (#87). Shows the tappable
 * options ONLY when the viewed enrichment joins the CURRENT block ({@link enrichmentMatchesBlock}, AC5)
 * AND has not already been answered ({@link answeredSequenceNum}); otherwise the panel is hidden and the
 * operator falls back to free-text steering (AC4) over the still-visible transcript (AC6). Paint-guarded
 * on {@link renderedEnrichmentSeq}: a re-render for the SAME outstanding enrichment (every 2s poll) is a
 * no-op, so the DOM and its `aria-live` announcement do not churn; a DIFFERENT (or newly-absent)
 * enrichment rebuilds and resets the in-progress selections.
 */
function renderEnrichment() {
  const enrichment = viewedEnrichment;
  const show =
    enrichmentMatchesBlock(enrichment, currentBlockSequenceNum) && enrichment.sequenceNum !== answeredSequenceNum;
  if (!show) {
    if (renderedEnrichmentSeq !== null) {
      needsYouQuestionEl.hidden = true;
      needsYouQuestionEl.replaceChildren();
      enrichmentSelections.clear();
      renderedEnrichmentSeq = null;
    }
    return;
  }
  if (renderedEnrichmentSeq === enrichment.sequenceNum) {
    return;
  }
  enrichmentSelections.clear();
  renderedEnrichmentSeq = enrichment.sequenceNum;
  paintEnrichment(enrichment);
}

/**
 * Build the decision panel for one outstanding enrichment: each question's heading / prompt and its
 * options as tappable buttons (AC1), plus — for a multi-select or multi-question envelope — a "Send
 * answer" that submits the assembled selection (AC2). A "view the transcript" note (AC6) leads, because
 * the option labels were authored by a possibly-ungated worker (ADR-005), so the operator is pointed at
 * the actual session below before acting. All text is rendered via `textContent` — the labels are
 * untrusted display data (core normalized them; this never interprets them as markup).
 */
function paintEnrichment(enrichment) {
  const nodes = [];
  const note = document.createElement("p");
  note.dataset.viewSessionNote = "true";
  note.textContent = "The agent is asking — review the transcript below before you answer.";
  nodes.push(note);
  for (const question of enrichment.questions) {
    nodes.push(buildQuestion(enrichment, question));
  }
  // A single-question single-select enrichment answers on the option tap ({@link submitsOnTap}); every
  // other shape assembles a selection across taps and submits with this button, gated on a complete answer.
  if (!submitsOnTap(enrichment)) {
    const submit = document.createElement("button");
    submit.type = "button";
    submit.dataset.answerSubmit = "true";
    submit.textContent = "Send answer";
    submit.disabled = true;
    submit.addEventListener("click", () => submitAnswer(enrichment));
    nodes.push(submit);
  }
  needsYouQuestionEl.replaceChildren(...nodes);
  needsYouQuestionEl.hidden = false;
}

/** Build one question block: its optional heading, its prompt, and its options as a tappable group. */
function buildQuestion(enrichment, question) {
  const wrap = document.createElement("div");
  wrap.dataset.question = question.questionId;
  if (question.header !== undefined) {
    const heading = document.createElement("h3");
    heading.textContent = question.header;
    wrap.appendChild(heading);
  }
  const prompt = document.createElement("p");
  prompt.dataset.questionPrompt = "true";
  prompt.textContent = question.prompt;
  wrap.appendChild(prompt);
  const group = document.createElement("div");
  group.dataset.options = "true";
  // A multi-select question is a checkbox group; a single-select a radio group — named so a screen reader
  // reads the selection semantics, not just "N buttons".
  group.setAttribute("role", question.multiSelect ? "group" : "radiogroup");
  for (const option of question.options) {
    group.appendChild(buildOption(enrichment, question, option));
  }
  wrap.appendChild(group);
  return wrap;
}

/** Build one tappable option button, carrying its label + optional description; `aria-pressed` its selection. */
function buildOption(enrichment, question, option) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.option = "true";
  button.dataset.questionId = question.questionId;
  button.dataset.label = option.label;
  button.setAttribute("aria-pressed", "false");
  const label = document.createElement("span");
  label.dataset.optionLabel = "true";
  label.textContent = option.label;
  button.appendChild(label);
  if (option.description !== undefined) {
    const description = document.createElement("span");
    description.dataset.optionDescription = "true";
    description.textContent = option.description;
    button.appendChild(description);
  }
  button.addEventListener("click", () => onOptionTap(enrichment, question, option.label));
  return button;
}

/**
 * Handle an option tap. A single-question single-select enrichment answers IMMEDIATELY (AC1's "tapping one
 * sends that selection"); every other shape toggles the label into the in-progress selection and repaints
 * the pressed states + the submit's enabled gate, leaving the operator to assemble and Send (AC2).
 */
function onOptionTap(enrichment, question, label) {
  if (submitsOnTap(enrichment)) {
    submitAnswer(enrichment, { [question.questionId]: [label] });
    return;
  }
  toggleSelection(question, label);
  reflectOptionStates(question);
  reflectAnswerSubmitState(enrichment);
}

/** Toggle a label into a question's selection: multi-select adds/removes; single-select replaces (radio). */
function toggleSelection(question, label) {
  let selected = enrichmentSelections.get(question.questionId);
  if (selected === undefined) {
    selected = new Set();
    enrichmentSelections.set(question.questionId, selected);
  }
  if (question.multiSelect) {
    if (selected.has(label)) {
      selected.delete(label);
    } else {
      selected.add(label);
    }
  } else {
    selected.clear();
    selected.add(label);
  }
}

/** The operator's selection per question as the `{ [questionId]: string[] }` shape `answerFromSelections` reads. */
function selectionsObject() {
  const object = {};
  for (const [questionId, selected] of enrichmentSelections) {
    object[questionId] = [...selected];
  }
  return object;
}

/** Repaint the `aria-pressed` state of one question's option buttons from the current selection. */
function reflectOptionStates(question) {
  const selected = enrichmentSelections.get(question.questionId) ?? new Set();
  for (const button of needsYouQuestionEl.querySelectorAll('[data-option="true"]')) {
    if (button.dataset.questionId === question.questionId) {
      button.setAttribute("aria-pressed", selected.has(button.dataset.label) ? "true" : "false");
    }
  }
}

/** Enable the "Send answer" button only when the assembled selection is a complete, valid answer. */
function reflectAnswerSubmitState(enrichment) {
  const submit = needsYouQuestionEl.querySelector('[data-answer-submit="true"]');
  if (submit !== null) {
    submit.disabled = answerFromSelections(enrichment, selectionsObject()) === null;
  }
}

/**
 * Submit the operator's answer to the outstanding enrichment (#87, AC1/AC2): build the {@link AnswerEnvelope}
 * from the selection (or the one-tap override), and — when it is a complete, valid answer — send it as the
 * `answer` steer (#86), riding the SAME {@link steer} path every verb uses (so an offline answer is queued
 * and a moved-on one is stale-guarded, #79/#80). Marks the sequence answered so the panel hides at once
 * (optimistic, like the prompt input clearing on submit) rather than inviting a double-tap the server would
 * 409. A no-op on an incomplete/invalid selection — the submit button is already gated on the same check.
 */
function submitAnswer(enrichment, override) {
  const answers = answerFromSelections(enrichment, override ?? selectionsObject());
  if (answers === null) {
    return;
  }
  const command = answerCommand(enrichment.sequenceNum, answers);
  if (command === null) {
    return;
  }
  answeredSequenceNum = enrichment.sequenceNum;
  renderEnrichment();
  steer(command);
}

/**
 * Paint the shortcut-phrase chips (#87 AC3): a static row of common steering replies, each of which
 * INSERTS its phrase into the free-text steer input on tap (appending to any typed text, never replacing
 * it) and focuses the input, so a routine "carry on" / "hold up" is a tap rather than a typed sentence —
 * while free-text steering stays fully available beside them (AC4). The set is {@link SHORTCUT_CHIPS},
 * the single editable list the zero-build UI treats as "configurable".
 */
function renderShortcutChips() {
  const chips = SHORTCUT_CHIPS.map((phrase) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.dataset.chip = "true";
    chip.textContent = phrase;
    chip.addEventListener("click", () => insertShortcut(phrase));
    return chip;
  });
  shortcutChipsEl.replaceChildren(...chips);
}

/** Insert a shortcut phrase into the steer input — append to any typed text (non-destructive) — and focus it. */
function insertShortcut(phrase) {
  const current = promptInputEl.value;
  promptInputEl.value = current.trim() === "" ? phrase : `${current} ${phrase}`;
  promptInputEl.focus();
}

/**
 * A standing "auto-approves permissions" badge for a non-prompting session (#26/#27). It is a
 * SIBLING of the row button, never a child of it: a poll relabels a row via
 * `button.textContent = label`, which would wipe a badge nested inside the button — as a
 * sibling it survives every relabel. It carries an id so the button can point at it as its
 * accessible description ({@link createSessionRow}).
 *
 * The copy states what the mode actually does, not what it was once assumed to prevent (#265).
 * It previously read "notifications degraded" / "it won't raise needs-you notifications" — which
 * ADR-005 (#263) falsified: `AskUserQuestion` blocks natively even under `bypassPermissions`, so a
 * marked session DOES still raise needs-you. Telling the operator otherwise is the worst reading of
 * this badge — it invites them to distrust a channel that works, or to over-monitor a session the
 * phone would have caught. What stays true, and is worth a standing amber flag, is the permissive
 * mode itself: this session approves permission decisions the operator would otherwise be asked.
 *
 * The title names BOTH modes rather than making one claim about them, because the wire carries a
 * single boolean — the browser cannot tell which mode a marked session runs, and the two are NOT
 * equivalent: `bypassPermissions` approves every tool call, while `acceptEdits` auto-accepts file
 * edits and still prompts for tools it has no mode-specific handling for. A blanket "it will never
 * prompt you" would be a fresh falsehood for `acceptEdits` — the very kind #265 exists to remove.
 *
 * The `data-badge` value and the element id are internal hooks (the CSS selector in `index.html`,
 * and `aria-describedby`) — no operator reads them, so they stay put; only the strings a human
 * actually reads are restated.
 */
function createDegradedBadge(sessionId) {
  const badge = document.createElement("span");
  badge.id = `degraded-${sessionId}`;
  badge.dataset.badge = "notifications-degraded";
  badge.textContent = "auto-approves permissions";
  badge.title =
    "This session runs in a non-prompting mode: bypassPermissions approves every tool call without asking; acceptEdits auto-accepts file edits and still prompts for other tools. It can still raise a needs-you notification when the agent asks you a question.";
  return badge;
}

/**
 * Build one "needs you" badge for a session with an un-acked reconciled blocking event (#53). A sibling
 * of {@link createDegradedBadge}, and OUTSIDE the row button for the same reason (a poll relabels the
 * button, which would wipe a nested child) — but unlike the life-long degraded marker this one is
 * TRANSIENT: it is added on reconnect-reconcile and removed when the operator views the session (which
 * acks it). It carries NO `aria-describedby`, deliberately: sitting in the `aria-live` picker list, its
 * INSERTION is announced once — which is the right reading for news ("this session needs you"), unlike
 * the degraded marker's standing property. The `title` carries the block's human detail.
 */
function createNeedsYouBadge(detail) {
  const badge = document.createElement("span");
  badge.dataset.badge = "needs-you";
  badge.textContent = "needs you";
  badge.title = detail;
  return badge;
}

/**
 * Paint the per-session "needs you" badges from {@link needsYou} onto the picker rows: a row whose
 * session has un-acked reconciled entries gains a badge (its `title` the newest block's detail — entries
 * are eventId-ascending, so the last is newest); a row without loses any stale badge. Idempotent, so it
 * is safe to call after every reconcile AND after every poll's {@link applySessionList} (a row removed
 * and re-added keeps its badge state consistent). Touches only the badge, never the button label.
 */
function renderNeedsYouBadges() {
  for (const [sessionId, li] of sessionRows) {
    const existing = li.querySelector('[data-badge="needs-you"]');
    const entries = needsYou.get(sessionId);
    if (entries === undefined || entries.length === 0) {
      existing?.remove();
      continue;
    }
    const detail = needsYouDetail(entries[entries.length - 1]);
    if (existing === null) {
      li.appendChild(createNeedsYouBadge(detail));
    } else {
      existing.title = detail;
    }
  }
}

/**
 * Build one picker row: a full-width button whose click views + steers that session, plus —
 * for a session carrying the non-prompting marker (#26) — a standing badge (#27).
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
    // No sessions → no needs-you to attend; drop any reconciled entries so a later reconcile rebuilds
    // from the server's set rather than badging a session that has since gone.
    needsYou.clear();
    // No sessions → no cursors to guard against (#80); drop them so a session id later reused starts fresh.
    sessionCursors.clear();
    viewedCursors.clear();
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
  // Advance each session's head cursor from the poll (#80). Monotonic, so it never regresses the
  // fresher live-SSE cursor of the viewed session; it is the ONLY cursor source for sessions not being
  // viewed (an offline-queued steer's target), so it must run every poll, not just on the row diff.
  for (const session of sessions) {
    bumpCursor(sessionCursors, session.id, sessionCursor(session));
  }
  for (const id of diff.removed) {
    sessionRows.get(id)?.remove();
    sessionRows.delete(id);
    // A vanished (closed) session's needs-you is moot — there is nothing left to view or ack.
    needsYou.delete(id);
    // …and its cursors (#80): a closed session cannot be steered, and dropping them keeps a later
    // reused id from inheriting a stale "current" that would falsely read as moved-on.
    sessionCursors.delete(id);
    viewedCursors.delete(id);
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
  // Re-paint needs-you badges after the row diff so a newly-added row is badged (and a removed one's
  // badge is gone) — the badge is a sibling of the button, so a relabel never wipes it, but a row
  // add/remove must reconcile the badge with the map.
  renderNeedsYouBadges();
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
  // Whether THIS poll is a (re)connect — the heartbeat settling to reachable from a non-ok state (the
  // first settle, or a recovery from a failure). Gates the needs-you reconcile below so it fires "on
  // every reconnect over the tunnel" (#53), not on every 2s poll. Assigned in the try before its only
  // read; a failed poll returns from the catch without reaching it, so no initializer is needed.
  let reconnected;
  try {
    const response = await fetch(SESSIONS_PATH, { headers: authHeader(localStorage) });
    if (!response.ok) {
      throw new Error(`list failed (${response.status})`);
    }
    payload = await response.json();
    // The heartbeat beat: the phone can reach the server (#75).
    reconnected = pollState !== "ok";
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
    // The selected session is gone: its AskUserQuestion decision surface is moot — drop the enrichment and
    // block sequence so renderEnrichment hides the panel (a tappable question over a vanished session would
    // answer nothing).
    currentBlockSequenceNum = null;
    viewedEnrichment = null;
    renderEnrichment();
    // Nothing selected: there is nothing to stop.
    renderStopControl();
    // Drop a REFUSAL — its subject is gone, so it is stale news, and (for a forceable one) it carries a
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
  // Deep-link cold-open (#52) viewed-cursor init (#80): the deep-link selected its session at module
  // init, before any poll knew a cursor, so `selectSession` deferred the "seen up to head" capture. Now
  // that this poll has learned the head (applySessionList above), initialize it — ONCE, guarded on
  // `has` so a later poll never re-runs it to keep dragging viewed up to head (which would defeat the
  // guard). Mirrors what the auto-select path gets for free (its applySessionList precedes its
  // selectSession). If a live SSE event already advanced viewed, `has` is true and this no-ops.
  if (currentSessionId !== null && !viewedCursors.has(currentSessionId)) {
    viewedCursors.set(currentSessionId, sessionCursors.get(currentSessionId) ?? 0);
  }
  // On a (re)connect, reconcile the un-acked needs-you queue over the tunnel so a blocking event whose
  // push was lost/coalesced re-surfaces (#53). Fire-and-forget: it paints badges when it resolves and
  // never blocks the poll loop; it runs AFTER applySessionList so the rows it badges already exist.
  if (reconnected) {
    reconcileNeedsYouQueue();
    // And drain any steers the operator queued while offline (#79), firing them in order now that the
    // link is back. Fire-and-forget like the reconcile; its own sends are awaited internally to keep order.
    fireSteerQueue();
  }
  // Refresh the viewed session's AskUserQuestion enrichment from this poll's summary (#87): the server
  // serves the outstanding question + options on the list while the session blocks (#264). This runs every
  // poll (not only on selection) so a block that appears WHILE the operator is viewing an idle session gets
  // its options; renderEnrichment joins it against the block sequence learned from the SSE (AC5).
  if (currentSessionId !== null) {
    viewedEnrichment = decodeEnrichment(sessions.find((session) => session.id === currentSessionId)?.enrichment);
    renderEnrichment();
  }
}

/**
 * Reconcile the unread "needs-you" queue over the tunnel (#53): GET the hub-global un-acked set, and
 * re-badge each session that still needs the operator. The server's un-acked set is authoritative
 * membership (`reconcileNeedsYou` returns it verbatim, ordered by `Last-Event-ID`); this only skips a
 * key the operator already acked-by-viewing this page-life (so a reconcile racing an in-flight ack does
 * not re-badge an attended session). REPLACES the local map from the server's set each round, so an
 * entry the server has acked (removed) loses its badge — "acknowledged events are not re-shown".
 *
 * Degrades honestly like `push.js` / `devices.js`: the reconcile route is mirror-ahead of #47's
 * still-unwired server route, so a non-2xx (404 until wired) reads as "no queue" and an unreachable
 * server leaves the prior badges standing for the next reconnect to retry — never a throw.
 */
async function reconcileNeedsYouQueue() {
  let entries;
  try {
    const response = await fetch(NEEDS_YOU_RECONCILE_PATH, { headers: authHeader(localStorage) });
    if (!response.ok) {
      // A non-2xx is NOT an authoritative empty queue — a 404 while the route is mirror-ahead unwired,
      // or a transient 5xx once it is live. Leave any prior badges standing for the next reconnect (the
      // same safe direction as the network throw below); only a 2xx mutates the set. For a reliability
      // backstop the safe failure is "keep showing the un-acked cue", never "clear it".
      return;
    }
    entries = reconcileNeedsYou(await readJson(response));
  } catch {
    // Unreachable server / tunnel error page: nothing to reconcile now; the next reconnect retries.
    return;
  }
  needsYou.clear();
  for (const entry of entries) {
    const key = needsYouKey(entry);
    // Skip entries already acked-by-viewing (their server removal may still be in flight) — otherwise
    // sort the entry under its session, preserving the eventId-ascending order the reconcile returns.
    if (key === null || ackedNeedsYou.has(key)) {
      continue;
    }
    const list = needsYou.get(entry.sessionId);
    if (list === undefined) {
      needsYou.set(entry.sessionId, [entry]);
    } else {
      list.push(entry);
    }
  }
  renderNeedsYouBadges();
  // The session the operator is ALREADY viewing counts as attended: ack its reconciled entries now (a
  // no-op if it has none) rather than badge a session they are looking at. Closes the case where the
  // view PRECEDED this reconcile — a deep-linked / auto-selected-first / navigated-to session whose own
  // selectSession → ackNeedsYou no-op'd on the not-yet-populated queue, then could not clear the badge
  // without navigating away and back (they are already on it, so re-selecting is a no-op).
  if (currentSessionId !== null) {
    ackNeedsYou(currentSessionId);
  }
}

/**
 * Acknowledge a session's un-acked needs-you when the operator VIEWS it (#53) — viewing IS attending to
 * what the session needed. Drops the badge and records each key as acked at once (so a reconcile racing
 * this does not re-badge), then POSTs an ack per `(sessionId, eventId)` so the server removes it and a
 * later reconnect no longer returns it ("acknowledged events are not re-shown"). No-op when the session
 * has no un-acked entry. Ack is best-effort over the tunnel: an ack that never lands leaves the entry in
 * the server's queue to re-surface on a later reconnect (the backstop holds) — and until the server
 * wires the ack route (mirror-ahead), the POST 404s harmlessly, exactly as `push.js`'s upload does.
 */
async function ackNeedsYou(sessionId) {
  const entries = needsYou.get(sessionId);
  if (entries === undefined || entries.length === 0) {
    return;
  }
  needsYou.delete(sessionId);
  renderNeedsYouBadges();
  // Record EVERY key as acked BEFORE any POST, so a reconcile that races this loop cannot re-badge the
  // session for an entry whose ack has not been POSTed yet (all its keys are already suppressed). Then
  // POST each ack; the two passes keep the suppression atomic with respect to a concurrent reconcile.
  const bodies = [];
  for (const entry of entries) {
    const key = needsYouKey(entry);
    const body = needsYouAckBody(entry);
    if (key === null || body === null) {
      continue;
    }
    ackedNeedsYou.add(key);
    bodies.push(body);
  }
  for (const body of bodies) {
    try {
      await fetch(NEEDS_YOU_ACK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader(localStorage) },
        body: JSON.stringify(body),
      });
    } catch {
      // The ack didn't reach the server: the entry stays in its queue and re-surfaces on a later
      // reconnect. `ackedNeedsYou` keeps it from re-badging THIS page-life; a reload honestly re-shows it.
    }
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
 * marked forceable (`taken-over`, `liveness-indeterminate`), so force is never a standing control — it
 * exists for as long as such a refusal is on screen, and the next outcome replaces it. That makes the
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
 * A refusal surfaces the server's TYPED code plus its actionable sentence — and, for the refusals force
 * overrides (`taken-over`: someone is driving it at a terminal; `liveness-indeterminate`: the backend
 * reached its host and the host would not describe the surface), an escalation that re-sends the same
 * stop with the operator's explicit consent. Which refusals those are is `stop.js`'s call, read off
 * `failure.forceable` rather than re-decided here. That consent is the whole of what force means: the
 * server refuses for want of a fact only the operator has — that they want it stopped — and the
 * operator pressing this is the one supplying it.
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
    // The operator is viewing this session live, so this delivered event advances both its head
    // cursor and the cursor they have "seen" (#80) — keeping a live viewer caught up so the guard
    // fires only on messages they DIDN'T see (the stream down / poll running ahead).
    recordViewedEvent(sessionId, event.lastEventId);
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
  // A fresh session view: reset the AskUserQuestion decision surface (#87). The block sequence is
  // re-learned from THIS session's SSE stream (null until it arrives); the enrichment is seeded from the
  // last poll's summary for this session and refreshed each poll. renderEnrichment keeps the panel hidden
  // until the two join, so a prior session's question never lingers over this one.
  currentBlockSequenceNum = null;
  answeredSequenceNum = null;
  viewedEnrichment = decodeEnrichment(renderedSessions.find((session) => session.id === sessionId)?.enrichment);
  renderEnrichment();
  renderStopControl();
  markSelected();
  // Viewing the session acknowledges its reconciled needs-you (#53): drop the badge and ack the
  // entries so a later reconnect no longer re-surfaces them. No-op when the session had none.
  ackNeedsYou(sessionId);
  // Opening a session IS looking at it (#80): the operator has now "seen" it up to its current head,
  // so a steer made from here is guarded only against messages that arrive AFTER this moment. Capture
  // ONLY when the head is already known: a deep-link cold-open (#52) runs selectSession at module init
  // BEFORE the first poll, when no cursor is known yet — capturing 0 there would falsely read as "moved
  // on" on the first steer (a fresh SSE gets no replay to catch it up). Deferred to `loadSessions`'
  // one-shot, which initializes viewed→head the first poll that learns it (what auto-select gets free).
  if (sessionCursors.has(sessionId)) {
    bumpCursor(viewedCursors, sessionId, sessionCursors.get(sessionId));
  }
  connect(sessionId);
}

/**
 * POST one steer command upstream to a NAMED session; the server re-frames it as a control_request onto
 * that session's worker channel and answers 202 with the minted id. On success the accepted steer is
 * echoed into the transcript (marked outbound), so it is reflected in the viewed session even before the
 * worker's own events flow back down the SSE stream — but ONLY when the target is the session currently
 * on screen. A queued steer (#79) fires against the session it was composed for ({@link fireSteerQueue}),
 * which the operator may have navigated away from by fire time; echoing it into a DIFFERENT session's
 * transcript would misattribute it. A non-2xx answer throws, surfaced by the caller.
 */
async function sendSteerTo(sessionId, command) {
  const response = await fetch(sessionCommandPath(sessionId), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(localStorage) },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    throw new Error(`ccctl: steer failed (${response.status})`);
  }
  if (sessionId === currentSessionId) {
    appendOutbound(command.subtype, describeCommand(command));
    // The operator just steered the viewed session, so they have acted on its current state (#80):
    // advance the viewed cursor to the head so an immediate follow-up steer is not re-flagged as
    // moved-on for messages that were already there — and, after a "Send anyway", not re-held at once.
    bumpCursor(viewedCursors, sessionId, sessionCursors.get(sessionId) ?? 0);
  }
}

/**
 * Send a steer built from a DOM control — or, when the link is offline (#79), QUEUE it to fire on the
 * next reconnect rather than lose the operator's decision to a brief tunnel drop. No-op on a blank
 * build. With no session selected there is nothing to steer or queue (a queued steer fires against a
 * named session), so that surfaces as it always has. A live/reconnecting link sends now; only a
 * confirmed-offline heartbeat queues.
 */
function steer(command) {
  if (command === null) {
    return;
  }
  if (currentSessionId === null) {
    appendTranscript("error", "select a session to steer");
    return;
  }
  if (shouldQueueSteer(connectionHealth({ poll: pollState, stream: streamState }))) {
    enqueueSteer(currentSessionId, command);
    return;
  }
  // Online, but the session may have moved on since the operator last looked (#80 AC3): if its head
  // cursor has advanced past the cursor they viewed, HOLD the steer as a stale row ("moved on — still
  // send?") rather than firing it blind. "Send anyway" (confirm) fires it; Cancel (discard) drops it.
  const viewed = viewedCursors.get(currentSessionId) ?? 0;
  const head = sessionCursors.get(currentSessionId) ?? 0;
  if (sessionMovedOn(viewed, head)) {
    holdStaleSteer(currentSessionId, command, viewed);
    return;
  }
  sendSteerTo(currentSessionId, command).catch((error) => {
    appendTranscript("error", error.message);
  });
}

/**
 * Queue a steer the operator submitted while offline (#79 AC1): append a pending item — a fresh cancel
 * handle plus the session it was composed against — and paint the pending list. The form handler already
 * cleared the input optimistically, so the operator sees their decision captured as a pending row rather
 * than silently dropped. A malformed build is skipped by `queuedSteer` (defensive; the handlers only
 * reach here with a valid command and a selected session).
 */
function enqueueSteer(sessionId, command) {
  steerSeq += 1;
  // Capture the cursor the operator last viewed for this session (#80 AC2): the fire-time guard
  // compares it against the session's cursor THEN, holding the item stale if the session moved on
  // during the outage. `?? 0` (viewed nothing) fails safe toward the guard firing.
  const cursor = viewedCursors.get(sessionId) ?? 0;
  const item = queuedSteer({ id: steerSeq, sessionId, command, cursor });
  if (item === null) {
    return;
  }
  steerQueue = [...steerQueue, item];
  renderSteerQueue();
}

/**
 * Hold an ONLINE steer the operator submitted against a session that has moved on since they last
 * looked (#80 AC3), as a `stale` queue row — the same red, "Send anyway"/Cancel affordance a
 * fire-time-held queued item gets, so both paths share one confirm surface. Unlike {@link enqueueSteer}
 * it is NOT waiting on the link (it is online); it is waiting on the operator's "still send?" decision.
 * `cursor` is the viewed cursor the steer was judged stale against — carried so a reconnect drain
 * re-evaluates it consistently (it stays stale while the head keeps advancing).
 */
function holdStaleSteer(sessionId, command, cursor) {
  steerSeq += 1;
  const item = queuedSteer({ id: steerSeq, sessionId, command, cursor });
  if (item === null) {
    return;
  }
  steerQueue = [...steerQueue, { ...item, status: QUEUED_STALE }];
  renderSteerQueue();
}

/**
 * Confirm a held (stale) steer — the "still send?" YES (#80 AC4): drop it from the queue and fire it
 * NOW against the session it was composed for, bypassing the guard (the operator has acknowledged the
 * session moved on). A handle no longer present (a Send-anyway that raced a Cancel) is a harmless no-op.
 * Errors surface like any failed steer, and only into the viewed session's transcript (never
 * misattributed to a different session on screen — the `sendSteerTo` contract).
 */
function sendSteerAnyway(id) {
  const item = steerQueue.find((queued) => queued.id === id);
  if (item === undefined) {
    return;
  }
  steerQueue = cancelQueued(steerQueue, id);
  renderSteerQueue();
  sendSteerTo(item.sessionId, item.command).catch((error) => {
    if (item.sessionId === currentSessionId) {
      appendTranscript("error", error.message);
    }
  });
}

/**
 * Build one queued-steer row: the verb label + its human summary (as the transcript renders a frame),
 * the target session it will fire against, and a Cancel that drops it before it fires (#79 AC3). The row
 * carries `data-queued` (pending / stale) for its colour and the cancel handle in `data-queue-id`. A
 * `stale` row (the session moved on, #80) also carries a "moved on" note and a "Send anyway" button —
 * the "still send?" confirm (#80 AC4): Send anyway fires it, Cancel discards it.
 */
function steerQueueItem(item) {
  // Reuse the transcript-frame builder (as appendOutbound does) for the verb + summary, then augment.
  const li = transcriptItem(item.command.subtype, describeCommand(item.command));
  li.dataset.queued = item.status;
  li.dataset.queueId = String(item.id);
  // Name the target session: a queued steer fires against the session it was composed for, which may
  // not be the one on screen when it fires, so the operator can tell which decision is waiting.
  const target = document.createElement("span");
  target.dataset.queueTarget = "true";
  target.textContent = ` — for ${item.sessionId}`;
  li.appendChild(target);
  // A held (stale) item: say WHY it is held (the session moved on) and offer the "still send?" confirm
  // beside Cancel. A pending item is unchanged — it fires itself on reconnect and is cancel-only.
  if (item.status === QUEUED_STALE) {
    const note = document.createElement("span");
    note.dataset.queueStaleNote = "true";
    note.textContent = " — moved on since you looked";
    li.appendChild(note);
    const sendAnyway = document.createElement("button");
    sendAnyway.type = "button";
    sendAnyway.dataset.queueSend = "true";
    sendAnyway.textContent = "Send anyway";
    sendAnyway.addEventListener("click", () => sendSteerAnyway(item.id));
    li.appendChild(sendAnyway);
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.dataset.queueCancel = "true";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => cancelSteerQueued(item.id));
  li.appendChild(cancel);
  return li;
}

/**
 * Paint the offline-steer queue (#79 AC1): a pending row per queued steer, or nothing when the queue is
 * empty (the section hides so it never shows a bare heading). `aria-live`, so a newly-queued steer is
 * announced once. Rebuilt wholesale on each change — the queue is small and moves only on operator
 * action (submit while offline, cancel) or a reconnect drain, never on the 2s poll — so an in-place diff
 * would be complexity the churn does not justify.
 */
function renderSteerQueue() {
  if (steerQueue.length === 0) {
    steerQueueSectionEl.hidden = true;
    steerQueueEl.replaceChildren();
    return;
  }
  steerQueueSectionEl.hidden = false;
  steerQueueEl.replaceChildren(...steerQueue.map(steerQueueItem));
}

/**
 * Cancel a still-pending queued steer before it fires (#79 AC3): drop it from the queue and repaint. A
 * handle no longer present — a Cancel that raced the reconnect drain firing it — is a harmless no-op
 * (`cancelQueued` is idempotent).
 */
function cancelSteerQueued(id) {
  steerQueue = cancelQueued(steerQueue, id);
  renderSteerQueue();
}

/**
 * Drain the offline-steer queue on reconnect (#79 AC2): partition it through the stale-guard seam, POST
 * each survivor to the session it was composed for IN ORDER, and leave any held item in the queue for
 * the operator to cancel. Fire-and-forget from `loadSessions` (like the needs-you reconcile), but each
 * POST is AWAITED in turn so the sends land in the order the operator made them — an out-of-order
 * redirect could countermand a later input. Guarded against overlapping reconnects (the `polling` mirror).
 *
 * The stale-guard (#79 AC4) is ARMED here (#80): each item is routed through {@link sessionMovedOn},
 * comparing the cursor it captured when the operator last viewed its session against that session's
 * CURRENT cursor (from the poll / SSE). An item whose session moved on during the outage is HELD
 * (`stale`, red) with a "Send anyway"/Cancel confirm rather than fired blind; the rest fire in order.
 * `partitionQueueForFire`'s routing is exactly #79's — #80 only supplies the predicate. A held item
 * stays held on later drains (the head only advances, so `sessionMovedOn` stays true) until the
 * operator confirms ({@link sendSteerAnyway}) or cancels it.
 */
async function fireSteerQueue() {
  if (firingQueue || steerQueue.length === 0) {
    return;
  }
  const { send, hold } = partitionQueueForFire(steerQueue, (item) =>
    sessionMovedOn(item.cursor, sessionCursors.get(item.sessionId) ?? 0),
  );
  // Drop the about-to-send items from the queue NOW, before any await, so a cancel or a second reconnect
  // racing the in-flight sends cannot double-fire them; a held (stale) item stays visible + cancellable.
  steerQueue = hold;
  renderSteerQueue();
  if (send.length === 0) {
    return;
  }
  firingQueue = true;
  try {
    for (const item of send) {
      try {
        await sendSteerTo(item.sessionId, item.command);
      } catch (error) {
        // A send that fails on reconnect (a flap, or the session closed while offline) surfaces like any
        // failed steer rather than throwing out of the drain and stranding the rest — and only into the
        // transcript of the session it targeted, when that is the one on screen. The decision was
        // attempted, not silently lost; the operator can re-issue it.
        if (item.sessionId === currentSessionId) {
          appendTranscript("error", error.message);
        }
      }
    }
  } finally {
    firingQueue = false;
    // Self-re-arm (the `scheduleNextPoll` idiom applied to the drain): a steer the operator queued
    // DURING this drain — the link flapped offline mid-drain, so a new steer was queued — never fired,
    // because the reconnect that would have drained it found `firingQueue` still set and skipped. If any
    // such item remains AND the link is back, drain it NOW rather than strand it until the next
    // offline→online edge, which may never come on a link that then stays healthy — the flaky-mobile
    // case this feature exists for. Gated on online (a steer only queues while offline, so a leftover
    // item means the link flapped): while still offline they wait for the next real reconnect. Bounded —
    // a send removes its item and an all-held (stale) queue returns before re-entering, so a persistent
    // failure cannot loop; the depth is one re-drain per mid-drain flap, each needing fresh operator input.
    if (steerQueue.length > 0 && !shouldQueueSteer(connectionHealth({ poll: pollState, stream: streamState }))) {
      fireSteerQueue();
    }
  }
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
 * (W6-19, AC3) hangs off — carrying the device's label (name + last-seen, AC1) and a Revoke
 * button. The current device (AC2) is marked with a `data-current` flag (styled distinctly) plus
 * an appended "· this device" note, so it reads as the current one to sighted and screen-reader
 * users alike.
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
  // The per-device revoke affordance (W6-19, AC3): revoke THIS row's device by its stable id, then
  // re-list. Rendered on every row so an operator can de-authorise any paired device (including the
  // current one — e.g. a shared browser).
  const revoke = document.createElement("button");
  revoke.type = "button";
  revoke.dataset.revoke = "true";
  revoke.textContent = "Revoke";
  revoke.addEventListener("click", () => submitRevoke(device.id));
  li.appendChild(revoke);
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
 * Revoke one paired device (#81 / W6-19, AC3): DELETE its `/api/devices/{id}`, then re-list so the
 * revoked device drops out and the operator sees the current registry. Like {@link loadDevices},
 * this rides ahead of the server route — until the credentialed wave wires
 * `DELETE /api/devices/{id}` and the token verification a revoke enforces, the request surfaces the
 * server's refusal as the same inline error row (the accepted walking-skeleton state, exactly as
 * `pairing.js` applies a token ahead of enforcement). A failure never throws out of the click
 * handler. The at-rest token invalidation this drives server-side — the revoked device's token
 * refused on next use (AC1), every other device still working (AC2) — is the `revokeDevice`
 * primitive's job in `@ccctl/core`.
 */
async function submitRevoke(id) {
  try {
    const response = await fetch(deviceRevokePath(id), { method: "DELETE", headers: authHeader(localStorage) });
    if (!response.ok) {
      throw new Error(`revoke failed (${response.status})`);
    }
  } catch (error) {
    const li = document.createElement("li");
    li.dataset.error = "true";
    li.textContent = `could not revoke device: ${error.message}`;
    deviceListEl.replaceChildren(li);
    return;
  }
  await loadDevices();
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
// is the non-destructive-by-default one, and a forceable refusal from the server is what offers the
// escalation (`stop.js` § isForceable owns which those are). The button is disabled with no selection,
// so the guard below is the defensive second half of that pair (for a click that raced a selection
// being cleared).
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

// Paint the static shortcut-phrase chips (#87 AC3) once — each inserts a common steering reply into the
// free-text steer input on tap; the set is the editable SHORTCUT_CHIPS list in `enrichment.js`.
renderShortcutChips();

// Follow a tapped push (#52) to its session: the service worker cold-opened the app at `?session=<id>`,
// so read that deep-link, scrub the param (so a reload doesn't re-pin a since-closed session), and view
// the session — `selectSession` opens its event stream, which IS the session's content fetched over the
// tunnel (AC3). Done BEFORE the first poll below so the deep-link wins over the picker's
// auto-select-first rule: `nextSelection` sees a selection already set and keeps it (a deep-linked
// session that has since closed reads as `clear` on that poll — the honest outcome for a stale tap).
const deepLinkedSessionId = consumeDeepLinkSessionId({ location, history });
if (deepLinkedSessionId !== null) {
  selectSession(deepLinkedSessionId);
}

// A tap that lands while the app is ALREADY open can't cold-open a URL — the service worker instead
// posts the target session to this live client (#52); switch the viewed session in place. Guarded by
// the tested `navigateMessageSessionId`, so only a well-formed navigate message steers the UI (never
// some other page `message`). Registered whatever the SW-registration outcome below.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    const sessionId = navigateMessageSessionId(event.data);
    if (sessionId !== null) {
      selectSession(sessionId);
    }
  });
}

// List now and keep polling so the picker's per-session status stays live (#25 AC3).
pollSessions();

// List the operator's paired devices (#85); re-listed on demand via the Devices Refresh button.
loadDevices();

// Register the service worker on load so the UI is installable as a PWA and ready to render push
// wakes (#51); a browser without service workers simply isn't a PWA (best-effort, silent). Enabling
// push — subscribing this device — is an explicit operator action via the "Enable notifications"
// button above.
registerServiceWorker();
