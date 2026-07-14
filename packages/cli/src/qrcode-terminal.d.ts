// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Ambient types for `qrcode-terminal` (#74) — the zero-dependency terminal-QR renderer
 * the CLI's {@link defaultRenderQr} draws the pairing QR with. The package ships no types
 * and no `@types/qrcode-terminal`, so this is the minimal slice the CLI actually calls:
 * `generate(input, { small }, callback)`, where the callback receives the rendered string
 * (the library invokes it synchronously). Modeled as the CommonJS default export
 * (`module.exports`), which is how Node's ESM interop surfaces it under `NodeNext`.
 */
declare module "qrcode-terminal" {
  /** The `generate` options the renderer uses. */
  export interface GenerateOptions {
    /**
     * Render with unicode half-blocks — half the height and no ANSI color — so the code
     * fits an 80-column terminal without wrapping (a wrapped QR is unscannable) and
     * survives being piped to a log.
     */
    readonly small?: boolean;
  }

  interface QrcodeTerminal {
    /** Render `input` as a terminal QR, passing the rendered string to `callback` (invoked synchronously). */
    generate(input: string, options: GenerateOptions, callback: (qrcode: string) => void): void;
  }

  const qrcodeTerminal: QrcodeTerminal;
  export default qrcodeTerminal;
}
