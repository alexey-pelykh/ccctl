// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Skeleton traffic harness for the inference-untouched guarantee.
 *
 * It produces {@link ObservedConnection}s that are RECEIVER-grounded: each "the
 * connection reached X" verdict is read from the endpoint that actually took the
 * connection, never from the sender. That is the whole point of the "real
 * outbound connection, not a mock's self-reported destination" criterion —
 * attribution comes from the receiver's own record.
 *
 * Two endpoints stand in the one-session flow:
 *
 *   - the LOCAL server — the real {@link CcctlServer} from `@ccctl/server`; its
 *     own {@link CcctlServer.sessions} map is first-party proof it took the
 *     register (control) traffic, and its register RESPONSE is asserted against
 *     the snake_case `{session_id, ws_url}` wire contract PINNED by #108 / ADR-001
 *     (never a shape re-guessed here) — see {@link assertRegisterResponseWire};
 *   - api.anthropic.com — a loopback {@link InferenceStandIn} that logs every
 *     request it receives; its log is first-party proof it took the inference
 *     traffic.
 *
 * SKELETON boundary: there is no patched Claude Code worker and no real egress
 * to api.anthropic.com here. The inference leg is a real outbound HTTP
 * connection carrying `Host: api.anthropic.com`, physically directed at the
 * loopback stand-in (hermetic, no credentials). The later credentialed suite
 * swaps the stand-in for the real host and the synthetic leg for a real
 * inference turn; the assertion it feeds ({@link assertInferenceUntouched}) does
 * not change.
 */

import { createServer, request, type Server } from "node:http";
import { formatAuthority, SESSIONS_CREATE_PATH, type HostEndpoint } from "@ccctl/core";
import { toRegisterResponseWire, type CcctlServer, type RegisterResponseWire } from "@ccctl/server";
import type { ObservedConnection, TrafficReceiver } from "./inference-guarantee.js";

/** Default loopback host — the harness never binds off-box. */
const LOOPBACK_HOST = "127.0.0.1";

/** How long a harness HTTP request waits before it is treated as hung. */
const REQUEST_TIMEOUT_MS = 10_000;

/** One request the {@link InferenceStandIn} received, as it saw it. */
export interface RecordedRequest {
  /** The `Host` the request carried (hostname only; any port stripped). */
  readonly host: string;
  /** The HTTP method. */
  readonly method: string;
  /** The request path. */
  readonly path: string;
}

/** A loopback stand-in for `api.anthropic.com` that records what reaches it. */
export interface InferenceStandIn {
  /** The bound loopback address (ephemeral port). */
  readonly address: HostEndpoint;
  /** Every request the stand-in received, in arrival order. */
  readonly received: readonly RecordedRequest[];
  /** Stop accepting connections and release the port. */
  close(): Promise<void>;
}

/**
 * Start the loopback `api.anthropic.com` stand-in. It records every inbound
 * request and answers `200` — the minimum needed to observe that a real
 * connection reached it.
 */
export function startInferenceStandIn(host: string = LOOPBACK_HOST): Promise<InferenceStandIn> {
  const received: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    received.push({ host: hostnameOf(req.headers.host), method: req.method ?? "", path: req.url ?? "" });
    req.resume(); // drain the (ignored) request body so the socket does not stall
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ standIn: "api.anthropic.com" }));
  });

  return new Promise<InferenceStandIn>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, host, () => {
      server.removeListener("error", onError);
      const bound = server.address();
      const port = typeof bound === "object" && bound !== null ? bound.port : 0;
      resolve({
        address: { host, port },
        received,
        close: () => closeServer(server),
      });
    });
  });
}

/**
 * The exact snake_case wire keys the register response must carry, in order —
 * derived from the PINNED mapper {@link toRegisterResponseWire} itself, never
 * hand-typed here, so this expectation tracks #108's contract instead of silently
 * disagreeing with it. Key order is part of the golden (#108 / ADR-001).
 */
const PINNED_REGISTER_WIRE_KEYS = Object.keys(toRegisterResponseWire({ sessionId: "", wsUrl: "" }));

/**
 * Assert a register-response body IS the pinned register→worker wire contract and
 * return it typed. This is the fidelity gate #109 adds: it exercises the register
 * response FACE — the bytes a worker parses — against the snake_case
 * `{session_id, ws_url}` shape PINNED by #108's golden (casing, exact key set, and
 * key order), so a camelCase or otherwise re-guessed shape fails closed rather than
 * passing green (the Self-Confirming Mock gap). Pure and transport-free (a string
 * in, a verdict out), so it is unit-testable in isolation against a wrong shape;
 * the real-server round-trip in {@link observeControlLeg} feeds it the live bytes,
 * which is what keeps the assertion grounded in the real contract, not a mock of it.
 */
export function assertRegisterResponseWire(body: string): RegisterResponseWire {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new Error("ccctl e2e: register response body is not valid JSON", { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ccctl e2e: register response body is not a JSON object");
  }
  // Exact snake_case key set AND order, sourced from the pinned mapper — a renamed,
  // reordered, missing, or extra key (a camelCase `sessionId`/`wsUrl` leak included)
  // fails closed, because its key list cannot equal the pinned one.
  const keys = Object.keys(parsed);
  if (
    keys.length !== PINNED_REGISTER_WIRE_KEYS.length ||
    keys.some((key, index) => key !== PINNED_REGISTER_WIRE_KEYS[index])
  ) {
    throw new Error(
      `ccctl e2e: register response wire shape ${JSON.stringify(keys)} does not match the pinned contract ` +
        `${JSON.stringify(PINNED_REGISTER_WIRE_KEYS)} (#108 / ADR-001)`,
    );
  }
  const record = parsed as Record<string, unknown>;
  for (const key of PINNED_REGISTER_WIRE_KEYS) {
    if (typeof record[key] !== "string" || record[key] === "") {
      throw new Error(`ccctl e2e: register response wire field \`${key}\` must be a non-empty string`);
    }
  }
  return parsed as RegisterResponseWire;
}

/** Inputs to observe the control (session-registration) leg. */
export interface ControlLegOptions {
  /** The real local ccctl server the worker's control channel points at. */
  readonly server: CcctlServer;
  /** The account Bearer the register carries (received, never persisted). */
  readonly bearer: string;
  /** The Anthropic stand-in, used to prove control did NOT leak to it. */
  readonly standIn: InferenceStandIn;
}

/**
 * Drive the control leg — register a session with the local server — and return
 * a receiver-grounded {@link ObservedConnection}. Grounds "reached the local
 * server" in the server's own {@link CcctlServer.sessions} record and "did not
 * reach api.anthropic.com" in the stand-in's own (unchanged) log; throws if
 * either ground is not met, so a broken flow cannot masquerade as a pass.
 *
 * It also asserts the register RESPONSE against the pinned wire contract via
 * {@link assertRegisterResponseWire} (#108 / ADR-001), so the leg exercises the
 * register→worker contract FACE — the bytes a worker parses — not merely the 201
 * status and the server-side session side-effect.
 */
export async function observeControlLeg(options: ControlLegOptions): Promise<ObservedConnection> {
  const { server, bearer, standIn } = options;
  const anthropicBefore = standIn.received.length;
  const sessionsBefore = server.sessions.size;
  const authority = formatAuthority(server.address.host, server.address.port);

  const result = await httpPostJson(
    server.address,
    SESSIONS_CREATE_PATH,
    { authorization: `Bearer ${bearer}` },
    {
      sessionIngressToken: "e2e-ingress-token",
    },
  );

  if (result.status !== 201) {
    throw new Error(`ccctl e2e: control register expected 201 from the local server, got ${result.status}`);
  }
  if (server.sessions.size !== sessionsBefore + 1) {
    throw new Error("ccctl e2e: local server did not record the registered session");
  }
  if (standIn.received.length !== anthropicBefore) {
    throw new Error("ccctl e2e: session-control traffic leaked to the api.anthropic.com stand-in");
  }
  // Exercise the register→worker contract FACE: the response body is the bytes a
  // worker parses. Assert it is the pinned snake_case `{session_id, ws_url}` wire
  // shape (#108 / ADR-001), then ground its VALUES in the receiver's own record —
  // the wire session_id is a session the server actually created, and ws_url points
  // at THIS server's worker channel for it. Grounding against the real server's own
  // response (never a mock of it) is what keeps this from self-confirming.
  const wire = assertRegisterResponseWire(result.body);
  if (!server.sessions.has(wire.session_id)) {
    throw new Error("ccctl e2e: register wire session_id matches no session the local server recorded");
  }
  if (!wire.ws_url.startsWith(`ws://${authority}`) || !wire.ws_url.includes(wire.session_id)) {
    throw new Error(
      `ccctl e2e: register wire ws_url ${wire.ws_url} does not point at the local server (${authority}) for session ${wire.session_id}`,
    );
  }
  return { leg: "control", receivedBy: "local-server", intendedHost: authority };
}

/** Inputs to observe the inference (model-turn) leg. */
export interface InferenceLegOptions {
  /** Where the connection is physically directed (loopback, in the skeleton). */
  readonly target: HostEndpoint;
  /** The `Host` the connection carries — the destination it is "reaching". */
  readonly inferenceHost: string;
  /** The Anthropic stand-in, whose log grounds "reached api.anthropic.com". */
  readonly standIn: InferenceStandIn;
}

/**
 * Drive the inference leg — a real outbound request representing a model turn —
 * and return a receiver-grounded {@link ObservedConnection}. The connection
 * carries `Host: inferenceHost` and is directed at `target`; whether it reached
 * api.anthropic.com is decided by whether the stand-in logged it, so pointing
 * `target` at the local server (the regression) yields `receivedBy:
 * "local-server"` and trips {@link assertInferenceUntouched}.
 */
export async function observeInferenceLeg(options: InferenceLegOptions): Promise<ObservedConnection> {
  const { target, inferenceHost, standIn } = options;
  const anthropicBefore = standIn.received.length;

  // A real outbound connection carrying Host: inferenceHost. Awaiting the full
  // response guarantees the receiver has already logged it before we attribute.
  await httpPostJson(
    target,
    "/v1/messages",
    { host: inferenceHost },
    {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "e2e inference probe" }],
    },
  );

  const reachedAnthropic = standIn.received.length > anthropicBefore;
  const receivedBy: TrafficReceiver = reachedAnthropic ? "anthropic" : "local-server";
  const lastRecord = standIn.received.at(-1);
  const intendedHost = reachedAnthropic && lastRecord ? lastRecord.host : inferenceHost;
  return { leg: "inference", receivedBy, intendedHost };
}

/** The status + body of a harness HTTP round-trip. */
interface HttpResult {
  readonly status: number;
  readonly body: string;
}

/**
 * POST a JSON body over a real `node:http` connection. `node:http` (not `fetch`)
 * so the `Host` header is ours to set precisely — the inference leg must carry
 * `api.anthropic.com` while the socket lands on loopback.
 */
function httpPostJson(
  target: HostEndpoint,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<HttpResult> {
  const payload = JSON.stringify(body);
  return new Promise<HttpResult>((resolve, reject) => {
    const req = request(
      {
        host: target.host,
        port: target.port,
        method: "POST",
        path,
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        res.setEncoding("utf8");
        let responseBody = "";
        res.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: responseBody });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`ccctl e2e: request to ${formatAuthority(target.host, target.port)}${path} timed out`));
    });
    req.end(payload);
  });
}

/** Read the hostname out of a `Host` header, stripping any port or brackets. */
function hostnameOf(hostHeader: string | undefined): string {
  if (hostHeader === undefined || hostHeader === "") {
    return "";
  }
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return hostHeader;
  }
}

/** Close a server, releasing idle keep-alive sockets so it shuts down promptly. */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    server.closeIdleConnections();
  });
}
