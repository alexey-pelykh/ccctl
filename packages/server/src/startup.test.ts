// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  ADDRESS_IN_USE_CODE,
  brandListenError,
  CCCTL_CONFIG_DIR,
  DEFAULT_HOST,
  LOCAL_SERVER_AUTH_ENV,
  LOCAL_SERVER_AUTH_FILE_NAME,
  requireLocalServerAuth,
  resolveBindHost,
  resolveLocalServerAuthPath,
  WILDCARD_BIND_HOST,
  XDG_CONFIG_HOME_ENV,
  type AuthFileReader,
} from "./startup.js";

/** A Node-style `listen()` error (an ErrnoException with a `.code`), built without binding a socket. */
function listenError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe("requireLocalServerAuth — refuse-start-without-auth complete to spec (#57, #14 AC1)", () => {
  // No auth file on disk — every env-source / refusal case injects this so the unit stays
  // hermetic (it never reads the real ~/.config/ccctl/local-server-auth).
  const noAuthFile: AuthFileReader = () => null;
  // A deterministic config home so the resolved auth-file path is assertable without the
  // real environment or home directory.
  const XDG = { [XDG_CONFIG_HOME_ENV]: "/xdg-config" };
  const authFilePath = resolveLocalServerAuthPath(XDG);

  describe("source 1 — the env var (primary)", () => {
    it("returns the configured secret (trimmed)", () => {
      expect(requireLocalServerAuth({ [LOCAL_SERVER_AUTH_ENV]: "  s3cret  " }, { readAuthFile: noAuthFile })).toBe(
        "s3cret",
      );
    });

    it("takes precedence over the config file when both are set (12-factor override)", () => {
      expect(requireLocalServerAuth({ [LOCAL_SERVER_AUTH_ENV]: "from-env" }, { readAuthFile: () => "from-file" })).toBe(
        "from-env",
      );
    });

    it("reads from the injected env only — never mutates process.env", () => {
      const before = process.env[LOCAL_SERVER_AUTH_ENV];
      requireLocalServerAuth({ [LOCAL_SERVER_AUTH_ENV]: "isolated" }, { readAuthFile: noAuthFile });
      expect(process.env[LOCAL_SERVER_AUTH_ENV]).toBe(before);
    });
  });

  describe("source 2 — the config file (fallback, #57)", () => {
    it("returns the file's secret (trimmed) when the env var is absent", () => {
      expect(requireLocalServerAuth({}, { readAuthFile: () => "  file-s3cret  \n" })).toBe("file-s3cret");
    });

    it("looks for the file at the resolved XDG config path", () => {
      let readPath: string | undefined;
      requireLocalServerAuth(XDG, {
        readAuthFile: (path) => {
          readPath = path;
          return "ok";
        },
      });
      expect(readPath).toBe(authFilePath);
    });

    it("propagates a real file I/O error (not ENOENT) rather than masquerading as no-auth", () => {
      const eacces: AuthFileReader = () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      };
      expect(() => requireLocalServerAuth({}, { readAuthFile: eacces })).toThrow(/EACCES/);
    });
  });

  describe("no auth on any source → refuse to start (S1: absent)", () => {
    it("throws a clear error stating auth is required when neither source is configured", () => {
      expect(() => requireLocalServerAuth({}, { readAuthFile: noAuthFile })).toThrow(/local-server auth is required/);
    });

    it("is actionable: names the env key, the config-file path it looked for, and how to configure either (AC2)", () => {
      let message = "";
      try {
        requireLocalServerAuth(XDG, { readAuthFile: noAuthFile });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(LOCAL_SERVER_AUTH_ENV); // the exact expected config key
      expect(message).toContain(authFilePath); // the exact file path it looked for
      expect(message).toMatch(/writing the secret to/); // how to configure the file source
    });
  });

  describe("present-but-empty is not valid auth (S2 / AC3: malformed-or-empty → no auth, refused)", () => {
    it("treats a present-but-blank env value as no auth", () => {
      expect(() => requireLocalServerAuth({ [LOCAL_SERVER_AUTH_ENV]: "" }, { readAuthFile: noAuthFile })).toThrow(
        /auth is required/,
      );
      expect(() => requireLocalServerAuth({ [LOCAL_SERVER_AUTH_ENV]: "   " }, { readAuthFile: noAuthFile })).toThrow(
        /auth is required/,
      );
    });

    it("treats a present-but-blank config file as no auth (an empty file is not a secret)", () => {
      expect(() => requireLocalServerAuth({}, { readAuthFile: () => "" })).toThrow(/auth is required/);
      expect(() => requireLocalServerAuth({}, { readAuthFile: () => "   \n  " })).toThrow(/auth is required/);
    });

    it("falls through a blank env to a valid config file (blank env ≠ auth, but the file still counts)", () => {
      expect(requireLocalServerAuth({ [LOCAL_SERVER_AUTH_ENV]: "  " }, { readAuthFile: () => "file-secret" })).toBe(
        "file-secret",
      );
    });
  });
});

describe("resolveLocalServerAuthPath — XDG config path for the auth secret (#57)", () => {
  it("honours an absolute $XDG_CONFIG_HOME", () => {
    expect(resolveLocalServerAuthPath({ [XDG_CONFIG_HOME_ENV]: "/cfg" }, "/home/op")).toBe(
      join("/cfg", CCCTL_CONFIG_DIR, LOCAL_SERVER_AUTH_FILE_NAME),
    );
  });

  it("falls back to ~/.config when $XDG_CONFIG_HOME is unset, empty, or relative (a relative XDG base is spec-invalid)", () => {
    const expected = join("/home/op", ".config", CCCTL_CONFIG_DIR, LOCAL_SERVER_AUTH_FILE_NAME);
    expect(resolveLocalServerAuthPath({}, "/home/op")).toBe(expected);
    expect(resolveLocalServerAuthPath({ [XDG_CONFIG_HOME_ENV]: "" }, "/home/op")).toBe(expected);
    expect(resolveLocalServerAuthPath({ [XDG_CONFIG_HOME_ENV]: "relative/cfg" }, "/home/op")).toBe(expected);
  });
});

describe("resolveBindHost — localhost-bind, never 0.0.0.0 (#14 AC2)", () => {
  it("defaults to the loopback host when no override is given (default binds loopback)", () => {
    expect(resolveBindHost()).toBe(DEFAULT_HOST);
    expect(DEFAULT_HOST).toBe("127.0.0.1");
  });

  it("returns an explicit loopback host unchanged", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(resolveBindHost(host)).toBe(host);
    }
  });

  it("refuses the 0.0.0.0 wildcard with an error explaining loopback-only", () => {
    expect(WILDCARD_BIND_HOST).toBe("0.0.0.0");
    expect(() => resolveBindHost(WILDCARD_BIND_HOST)).toThrow(/refusing to bind 0\.0\.0\.0/);
    expect(() => resolveBindHost(WILDCARD_BIND_HOST)).toThrow(/loopback only/);
  });

  it("refuses only the 0.0.0.0 wildcard at this slice — the full non-loopback refusal is #58", () => {
    // The minimal ride-along guards exactly the AC's wording ("never 0.0.0.0").
    // Refusing every non-loopback address (`::`, LAN, public) and making the
    // guarantee non-overridable is completed to spec in #58, so a routable host
    // still passes through here rather than being refused prematurely.
    expect(resolveBindHost("192.168.1.10")).toBe("192.168.1.10");
  });
});

describe("brandListenError — actionable 'port already in use' message (#156)", () => {
  it("rebrands EADDRINUSE into a branded ccctl message naming the port and the --port fix", () => {
    const raw = listenError(ADDRESS_IN_USE_CODE, "listen EADDRINUSE: address already in use 127.0.0.1:4321");
    const branded = brandListenError(raw, 4321);
    // The branded guardrail voice: `ccctl:` prefix, the port that collided, the fix.
    expect(branded.message).toMatch(/^ccctl: port 4321 is already in use/);
    expect(branded.message).toMatch(/pass --port/);
    // The raw Node diagnostic string must NOT leak through — that is the whole bug.
    expect(branded.message).not.toMatch(/EADDRINUSE/);
  });

  it("names the actual configured port so the operator knows which one collided", () => {
    const raw = listenError(ADDRESS_IN_USE_CODE, "listen EADDRINUSE: address already in use 127.0.0.1:9999");
    expect(brandListenError(raw, 9999).message).toContain("9999");
  });

  it("passes a non-EADDRINUSE listen error through unchanged (keeps its own diagnostics)", () => {
    const other = listenError("EACCES", "listen EACCES: permission denied 127.0.0.1:80");
    expect(brandListenError(other, 80)).toBe(other);
  });

  it("passes an error with no code through unchanged (only EADDRINUSE is rebranded)", () => {
    const bare = new Error("something else entirely");
    expect(brandListenError(bare, 4321)).toBe(bare);
  });
});
