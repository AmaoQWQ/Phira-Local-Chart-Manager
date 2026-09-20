import fs from "node:fs";
import path from "node:path";

export interface RecordDecoderOptions {
  key: Buffer;
  expectedChartId?: number;
  expectedUserId?: number;
}

export type RecordDecoder = (token: string, options: RecordDecoderOptions) => any;
export type PrivateUploadHandler = (body: unknown, dependencies: Record<string, unknown>) => Promise<unknown>;

export interface RecordDecoderPlugin {
  path: string;
  decodePhiraRecordToken: RecordDecoder;
  handlePrivateUpload: PrivateUploadHandler;
}

/**
 * Loads the record decoder as an optional adapter. The gateway deliberately does not
 * import a decoder at module evaluation time: a fresh checkout without the private key
 * (or without an optional decoder build) must still be able to start.
 *
 * A plugin may export both functions from one module, or keep the historical layout
 * where `private-upload-adapter.js` sits beside `phira-record-decoder.js`.
 */
export function loadRecordDecoderPlugin(modulePath: string | null): RecordDecoderPlugin | null {
  if (!modulePath) return null;
  const resolved = path.resolve(modulePath);
  if (!fs.existsSync(resolved)) return null;
  try {
    const adapter = require(resolved) as Record<string, unknown>;
    const siblingPath = path.join(path.dirname(resolved), "phira-record-decoder.js");
    const decoderModule = typeof adapter.decodePhiraRecordToken === "function"
      ? adapter
      : fs.existsSync(siblingPath) ? require(siblingPath) as Record<string, unknown> : null;
    if (!decoderModule || typeof decoderModule.decodePhiraRecordToken !== "function" ||
        typeof adapter.handlePrivateUpload !== "function") return null;
    return {
      path: resolved,
      decodePhiraRecordToken: decoderModule.decodePhiraRecordToken as RecordDecoder,
      handlePrivateUpload: adapter.handlePrivateUpload as PrivateUploadHandler,
    };
  } catch {
    return null;
  }
}
