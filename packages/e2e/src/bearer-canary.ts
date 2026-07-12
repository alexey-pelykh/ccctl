// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The account-Bearer NON-PERSISTING pass-through guarantee (issue #60), as a pure
 * observational assertion — the RUNTIME complement to the compile-time proof.
 *
 * `@ccctl/core` proves at the type level that the account OAuth Bearer cannot reach a
 * loggable/persistable (JSON) shape: `AccountBearer` is a class instance, not a
 * `JsonValue`, so a leak into a log line or a snapshot is a compile error
 * (`BridgeCredentialJsonProofs`). This module is the OTHER half of that contract:
 * given what a full session lifecycle actually PRODUCED — every log line it emitted
 * plus the persisted state snapshot it wrote — it asserts the literal Bearer appears
 * in NEITHER. A canary: the type system forbids the leak by construction; this trips
 * the day a future edit (a stray `console.log(req.headers)`, a Bearer captured into a
 * persisted field) reintroduces one at runtime, behind the type guarantee.
 *
 * Like `inference-guarantee.ts`, the verdict is intentionally transport-free — it
 * consumes collected text and renders a pass/throw. WHERE the logs and snapshot come
 * from is the caller's job: the e2e canary drives the REAL server through a full
 * lifecycle presenting a distinctive Bearer, collects the produced logs and the
 * server's OWN persisted-state snapshot (receiver-grounded per
 * `docs/security-posture.md`), and feeds them here; the unit test drives the clauses
 * directly. Keeping the verdict pure lets both share exactly one definition of "the
 * Bearer never leaked".
 */

/** What a runtime canary collected from one full session lifecycle, to check for a Bearer leak. */
export interface BearerCanaryObservation {
  /**
   * The literal account Bearer value presented on the §1/§2 legs during the lifecycle
   * — the needle. MUST be non-empty: an empty needle "never appears" vacuously, which
   * {@link assertBearerNeverObserved} rejects as a degenerate pass.
   */
  readonly bearer: string;
  /** Every log line the lifecycle produced, concatenated (empty when nothing was logged). */
  readonly logs: string;
  /** The persisted state snapshot the lifecycle wrote (e.g. `JSON.stringify` of the server's own session/environment state). */
  readonly snapshot: string;
}

/**
 * Thrown by {@link assertBearerNeverObserved} when the account Bearer is observed in a
 * produced log line or the persisted snapshot — or when the observation is degenerate
 * (an empty Bearer needle). A typed error (not a bare `Error`) so a caller — a test, a
 * future gate — can distinguish this boundary breach from any other failure and
 * surface the specific `message`. Mirrors {@link InferenceGuaranteeViolation}.
 */
export class BearerLeakViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BearerLeakViolation";
  }
}

/**
 * Assert the non-persisting pass-through boundary observationally: the account Bearer
 * appears in NEITHER the produced logs NOR the persisted snapshot. Throws
 * {@link BearerLeakViolation} on any occurrence; returns normally only when both are
 * Bearer-free.
 *
 * Fails closed on a degenerate observation: an empty `bearer` is a violation, never a
 * vacuous pass — "the empty string never appears" is not evidence the boundary holds.
 * (Non-emptiness of `logs` / `snapshot` is the caller's ground to establish: the e2e
 * canary asserts the snapshot is populated real state and the log capture is live, so
 * a genuine lifecycle — not an empty subject — is what was grepped.)
 */
export function assertBearerNeverObserved(observation: BearerCanaryObservation): void {
  const { bearer, logs, snapshot } = observation;
  if (bearer === "") {
    throw new BearerLeakViolation(
      "degenerate canary: the account Bearer needle is empty — an empty needle never appears, which is not evidence the boundary holds",
    );
  }
  if (logs.includes(bearer)) {
    throw new BearerLeakViolation(
      "the account Bearer appeared in a produced log line — it must be validated for receipt and dropped, never logged",
    );
  }
  if (snapshot.includes(bearer)) {
    throw new BearerLeakViolation(
      "the account Bearer appeared in the persisted snapshot — it must never enter session state or the persisted snapshot",
    );
  }
}
