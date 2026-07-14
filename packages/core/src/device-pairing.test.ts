// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import {
  buildPairingUrl,
  deviceToken,
  loggablePairingUrl,
  PAIRING_TOKEN_PARAM,
  PAIRING_TOKEN_REDACTED,
} from "./index.js";

describe("deviceToken", () => {
  it("tags a non-empty string as a DeviceToken", () => {
    expect(deviceToken("abc123")).toBe("abc123");
  });

  it("rejects an empty or whitespace-only token — a blank token is not a secret", () => {
    expect(() => deviceToken("")).toThrow(/non-empty/);
    expect(() => deviceToken("   ")).toThrow(/non-empty/);
  });
});

describe("buildPairingUrl (tunnel origin + token in the URL fragment)", () => {
  const token = deviceToken("Zm9vYmFy_-0");

  it("carries the token in the fragment, never the query — a fragment is never sent to the server", () => {
    const url = buildPairingUrl({ host: "phone.tailnet.ts.net", token });
    expect(url).toBe(`https://phone.tailnet.ts.net/#${PAIRING_TOKEN_PARAM}=Zm9vYmFy_-0`);
    // The token is after the `#`, and there is no query string carrying it.
    expect(url).not.toContain("?");
    expect(url.split("#")[1]).toBe(`${PAIRING_TOKEN_PARAM}=Zm9vYmFy_-0`);
  });

  it("appends an explicit port via the shared authority formatter", () => {
    expect(buildPairingUrl({ host: "host.ts.net", port: 8443, token })).toBe(
      `https://host.ts.net:8443/#${PAIRING_TOKEN_PARAM}=Zm9vYmFy_-0`,
    );
  });

  it("brackets an IPv6 tunnel host — with and without a port", () => {
    expect(buildPairingUrl({ host: "fd7a:115c:a1e0::1", token })).toBe(
      `https://[fd7a:115c:a1e0::1]/#${PAIRING_TOKEN_PARAM}=Zm9vYmFy_-0`,
    );
    expect(buildPairingUrl({ host: "fd7a:115c:a1e0::1", port: 8443, token })).toBe(
      `https://[fd7a:115c:a1e0::1]:8443/#${PAIRING_TOKEN_PARAM}=Zm9vYmFy_-0`,
    );
  });

  it("honors a custom scheme", () => {
    expect(buildPairingUrl({ host: "host.ts.net", token, scheme: "http" })).toBe(
      `http://host.ts.net/#${PAIRING_TOKEN_PARAM}=Zm9vYmFy_-0`,
    );
  });

  it("percent-encodes a token that carries a URL-reserved character", () => {
    const url = buildPairingUrl({ host: "host.ts.net", token: deviceToken("a b&c") });
    expect(url).toBe(`https://host.ts.net/#${PAIRING_TOKEN_PARAM}=a%20b%26c`);
  });
});

describe("loggablePairingUrl (redact the token before it reaches a log)", () => {
  const token = deviceToken("s3cr3t-Zm9vYmFy_-0");

  it("replaces the fragment's token value with REDACTED, keeping the origin + param name", () => {
    const url = buildPairingUrl({ host: "phone.tailnet.ts.net", token });
    const safe = loggablePairingUrl(url);
    expect(safe).toBe(`https://phone.tailnet.ts.net/#${PAIRING_TOKEN_PARAM}=${PAIRING_TOKEN_REDACTED}`);
    // The raw secret never survives into the loggable projection.
    expect(safe).not.toContain("s3cr3t");
  });

  it("leaves a URL without the pairing fragment unchanged", () => {
    expect(loggablePairingUrl("https://phone.tailnet.ts.net/")).toBe("https://phone.tailnet.ts.net/");
  });
});
