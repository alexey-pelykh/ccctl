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
 *   - the LOCAL server — the real {@link CcctlServer} from `@ccctl/server`. The
 *     control leg drives the CURRENT environments-bridge flow against it —
 *     environment register (§1, `POST /v1/environments/bridge`) then session create
 *     (§2, `POST /v1/sessions`) — via the mock bridge's driving helpers in
 *     `bridge-wire-conformance.ts`, which assert each response against the pinned
 *     wire contract face (#124). The server's own {@link CcctlServer.environments}
 *     and {@link CcctlServer.sessions} maps are first-party proof it took the
 *     control traffic;
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
import { formatAuthority, type HostEndpoint } from "@ccctl/core";
import type { CcctlServer } from "@ccctl/server";
import { createSession, registerEnvironment } from "./bridge-wire-conformance.js";
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

/** Inputs to observe the control leg (the environments-bridge register + session-create POSTs). */
export interface ControlLegOptions {
  /** The real local ccctl server the worker's control channel points at. */
  readonly server: CcctlServer;
  /** The account Bearer the §1/§2 control POSTs carry (received, never persisted). */
  readonly bearer: string;
  /** The Anthropic stand-in, used to prove control did NOT leak to it. */
  readonly standIn: InferenceStandIn;
}

/**
 * Drive the control leg — the current environments-bridge flow's two account-Bearer
 * POSTs, environment register (§1) then session create (§2) — against the local
 * server, and return a receiver-grounded {@link ObservedConnection}. Grounds "reached
 * the local server" in the server's OWN {@link CcctlServer.environments} and
 * {@link CcctlServer.sessions} records, and "did not reach api.anthropic.com" in the
 * stand-in's own (unchanged) log; throws if any ground is not met, so a broken flow
 * cannot masquerade as a pass.
 *
 * The register/create RESPONSES are exercised against the pinned wire contract face by
 * the {@link registerEnvironment} / {@link createSession} helpers (#124), so the leg
 * verifies the current register→worker contract — the bytes a worker parses — not
 * merely the status codes and the server-side side-effects.
 */
export async function observeControlLeg(options: ControlLegOptions): Promise<ObservedConnection> {
  const { server, bearer, standIn } = options;
  const anthropicBefore = standIn.received.length;
  const environmentsBefore = server.environments.size;
  const sessionsBefore = server.sessions.size;
  const authority = formatAuthority(server.address.host, server.address.port);

  // §1 — register the environment; grounded in the server's own environments record.
  const { environmentId } = await registerEnvironment(server, bearer);
  if (server.environments.size !== environmentsBefore + 1 || !server.environments.has(environmentId)) {
    throw new Error("ccctl e2e: local server did not record the registered environment");
  }
  // §2 — create the session; grounded in the server's own sessions record. The helper
  // also asserts the minted ws_url points at THIS server's per-session worker channel.
  const { sessionId } = await createSession(server, bearer);
  if (server.sessions.size !== sessionsBefore + 1 || !server.sessions.has(sessionId)) {
    throw new Error("ccctl e2e: local server did not record the created session");
  }
  // Neither control POST leaked to the api.anthropic.com stand-in.
  if (standIn.received.length !== anthropicBefore) {
    throw new Error("ccctl e2e: session-control traffic leaked to the api.anthropic.com stand-in");
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
