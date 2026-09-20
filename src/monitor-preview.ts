import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Bridge between this gateway and the phira-web-monitor renderer (MIT).
 *
 * The browser renderer (`monitor-client`, compiled to WebAssembly) never parses a
 * chart format itself: `ChartPlayer.load_chart(id)` downloads
 * `{apiBase}/chart/{id}` and bincode-deserializes a `(ChartInfo, Chart)` pair that
 * the server produced. Upstream that server is `monitor-proxy`; here it is the
 * `chart-compiler` binary built from the very same parser sources, so the preview
 * and the renderer can never disagree about a chart.
 *
 * Compiling decodes the music into raw PCM, so a payload is tens of megabytes and
 * must be cached on disk. The cache file name embeds the source package's size and
 * mtime, which makes every entry immutable: re-uploading a chart produces a new name
 * instead of overwriting a file another request may still be streaming.
 */

export interface MonitorPreviewOptions {
  /** Directory holding the vendored renderer (`pkg/`, `bin/`, optional `respack/`). */
  rendererPath: string;
  /** Directory holding compiled chart payloads. */
  cachePath: string;
  /** Upper bound for one compilation. */
  timeoutMs?: number;
  /** Soft cap for the payload cache; oldest entries are evicted first. 0 disables it. */
  maxCacheBytes?: number;
}

export interface CompiledChart {
  filePath: string;
  bytes: number;
  cached: boolean;
  /** Summary printed by the compiler: name, duration, note counts, sample rate. */
  meta: Record<string, unknown> | null;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** Decoded PCM dominates a payload (a 4-minute stereo song is ~90 MB), so cap the cache. */
const DEFAULT_MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * Bumped whenever the compiler's output changes meaning, so stale entries cannot be
 * reused: the summary's playable length was once the last note's start time, which cut
 * trailing holds short.
 */
const CACHE_VERSION = 3;
/** Asset file names are served straight from disk, so allow only plain names. */
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".bin": "application/octet-stream",
};

export function contentTypeForAsset(fileName: string): string {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] || "application/octet-stream";
}

/** Resolves one whitelisted asset inside `directory`, refusing traversal attempts. */
export function monitorAssetPath(directory: string, fileName: string): string | null {
  if (!SAFE_FILE_NAME.test(fileName) || fileName.includes("..")) return null;
  return path.join(directory, fileName);
}

/** Lists servable asset names; returns an empty list when the directory is absent. */
export function listMonitorAssets(directory: string): string[] {
  try {
    return fs.readdirSync(directory)
      .filter((name) => SAFE_FILE_NAME.test(name) && fs.statSync(path.join(directory, name)).isFile())
      .sort();
  } catch {
    return [];
  }
}

export class MonitorChartCompiler {
  private readonly executable: string;
  private readonly rendererPath: string;
  private readonly cachePath: string;
  private readonly timeoutMs: number;
  private readonly maxCacheBytes: number;
  /** One in-flight compilation per source revision, shared by concurrent requests. */
  private readonly pending = new Map<string, Promise<CompiledChart>>();
  /** The stale-version sweep is once per process. */
  private swept = false;

  constructor(options: MonitorPreviewOptions) {
    this.rendererPath = path.resolve(options.rendererPath);
    this.cachePath = path.resolve(options.cachePath);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
    this.executable = path.join(this.rendererPath, "bin", process.platform === "win32" ? "chart-compiler.exe" : "chart-compiler");
  }

  get pkgPath(): string {
    return path.join(this.rendererPath, "pkg");
  }

  get respackPath(): string {
    return path.join(this.rendererPath, "respack");
  }

  /** Whether the compiler binary was built; without it previews cannot be offered. */
  get available(): boolean {
    return fs.existsSync(this.executable);
  }

  /**
   * Cache key for the vendored assets. The browser caches the WASM loader and binary
   * aggressively, so serving them from a stable URL meant a rebuilt renderer (for
   * example after the volume patch) kept being shadowed by the stale copy for as long
   * as the cache entry lived, with the failures swallowed client-side. Putting this
   * token in the path makes every rebuild a new URL, so a plain page reload is enough.
   */
  assetVersion(): string {
    const fingerprint = (directory: string): string[] =>
      listMonitorAssets(directory).map((name) => `${name}:${statOrNull(path.join(directory, name))?.size ?? 0}`);
    const parts = [...fingerprint(this.pkgPath), ...fingerprint(this.respackPath)];
    if (parts.length === 0) return "";
    return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
  }

  /**
   * Returns the compiled payload for a chart package, compiling it on first use.
   * `chartId` only names the cache entry; the package path is the source of truth.
   */
  async payload(chartId: number, packagePath: string): Promise<CompiledChart> {
    if (!this.available) throw new Error(`chart compiler is missing at ${this.executable}`);
    this.dropStaleVersions();
    const key = this.cacheKey(chartId, packagePath);
    const cachedPath = path.join(this.cachePath, `${key}.bin`);
    const cachedStat = statOrNull(cachedPath);
    if (cachedStat && cachedStat.size > 0) {
      return { filePath: cachedPath, bytes: cachedStat.size, cached: true, meta: this.readMeta(key) };
    }

    const existing = this.pending.get(key);
    if (existing) return existing;

    const work = this.compile(key, packagePath)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }

  /**
   * Summary of an already compiled payload, or null when it has not been built yet.
   * Reading it never triggers compilation.
   */
  metaFor(chartId: number, packagePath: string): Record<string, unknown> | null {
    try {
      return this.readMeta(this.cacheKey(chartId, packagePath));
    } catch {
      return null;
    }
  }

  /** Cache identity of one chart revision, usable as an immutable URL cache key. */
  revisionFor(chartId: number, packagePath: string): string | null {
    try {
      return this.cacheKey(chartId, packagePath);
    } catch {
      return null;
    }
  }

  /**
   * The chart illustration copied next to a compiled payload, which the renderer needs as
   * its playfield background. Null when the package has none in a displayable format.
   */
  backgroundFor(chartId: number, packagePath: string): { filePath: string; contentType: string } | null {
    try {
      const key = this.cacheKey(chartId, packagePath);
      const extension = this.readMeta(key)?.backgroundExtension;
      if (typeof extension !== "string" || extension === "") return null;
      const filePath = path.join(this.cachePath, `${key}.bg.${extension}`);
      if (!statOrNull(filePath)) return null;
      return { filePath, contentType: contentTypeForAsset(`bg.${extension}`) };
    } catch {
      return null;
    }
  }

  /** Cache identity of one source revision: the package never changes in place. */
  private cacheKey(chartId: number, packagePath: string): string {
    const stat = fs.statSync(packagePath);
    // The prefix keeps names self-describing; chart IDs are negative, so a name that
    // starts with a digit or a dash cannot be assumed here.
    return `chart${CACHE_VERSION}-${chartId}.${stat.size}.${Math.floor(stat.mtimeMs)}`;
  }

  /**
   * Lists this compiler's own cache files, optionally filtered by extension. Every entry
   * naming rule is enforced elsewhere (`listMonitorAssets` guards served web assets), so
   * only path separators are rejected here.
   */
  private cacheFiles(extension: string): string[] {
    try {
      return fs.readdirSync(this.cachePath).filter((name) => name.endsWith(extension) && !/[\\/]/.test(name));
    } catch {
      return [];
    }
  }

  /**
   * Removes payloads left by an earlier compiler revision. They can never be reused
   * (their summary means something else) and each one is tens of megabytes.
   */
  private dropStaleVersions(): void {
    if (this.swept) return;
    this.swept = true;
    const current = `chart${CACHE_VERSION}-`;
    for (const name of this.cacheFiles("")) {
      if (!name.startsWith("chart") || name.startsWith(current)) continue;
      try {
        fs.rmSync(path.join(this.cachePath, name), { force: true });
      } catch {
        // Busy or already gone; the capacity limit is the backstop.
      }
    }
  }

  private readMeta(key: string): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(this.cachePath, `${key}.json`), "utf8"));
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  private async compile(key: string, packagePath: string): Promise<CompiledChart> {
    fs.mkdirSync(this.cachePath, { recursive: true });
    const target = path.join(this.cachePath, `${key}.bin`);
    // A partially written payload must never be visible under the final name.
    const temporary = `${target}.${process.pid}.tmp`;
    let stdout: string;
    try {
      stdout = await this.run(packagePath, temporary);
      try {
        fs.renameSync(temporary, target);
      } catch (error) {
        // Another process may have published this exact revision first, in which case
        // the payload already exists and is byte-identical; a live stream holding the
        // destination open on Windows is the other realistic cause.
        if (!statOrNull(target)) throw error;
        fs.rmSync(temporary, { force: true });
      }
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      // The compiler may have written the illustration next to the temporary payload.
      const stem = temporary.slice(0, temporary.lastIndexOf("."));
      for (const name of this.cacheFiles("")) {
        if (name.includes(".bg.") && name.startsWith(stem)) {
          fs.rmSync(path.join(this.cachePath, name), { force: true });
        }
      }
      throw error;
    }
    const meta = parseSummary(stdout);
    // The compiler derives the illustration's file name from the output path it was given,
    // which is the temporary one, so it has to be moved to the final name as well.
    const extension = typeof meta?.backgroundExtension === "string" ? meta.backgroundExtension : "";
    if (extension !== "") {
      const temporaryBackground = `${target}.${process.pid}.bg.${extension}`;
      const finalBackground = path.join(this.cachePath, `${key}.bg.${extension}`);
      try {
        if (statOrNull(temporaryBackground)) fs.renameSync(temporaryBackground, finalBackground);
      } catch {
        // A missing illustration only costs the background layer.
      }
    }
    // The summary lands next to the payload so the admin UI can show a duration and a
    // note count without re-reading or re-compiling anything.
    if (meta) {
      try {
        fs.writeFileSync(path.join(this.cachePath, `${key}.json`), JSON.stringify(meta), "utf8");
      } catch {
        // Purely informational; a preview still works without it.
      }
    }
    this.prune(key);
    this.enforceCacheLimit(target);
    const stat = fs.statSync(target);
    return { filePath: target, bytes: stat.size, cached: false, meta };
  }

  /**
   * Keeps the payload cache under its cap by dropping the least recently built
   * payloads. Deletion of a file another request still streams may fail; that entry
   * simply survives until a later build retries.
   */
  private enforceCacheLimit(keep: string): void {
    if (this.maxCacheBytes <= 0) return;
    const entries = this.cacheFiles(".bin")
      .map((name) => {
        const filePath = path.join(this.cachePath, name);
        const stat = statOrNull(filePath);
        return stat ? { filePath, size: stat.size, mtimeMs: stat.mtimeMs } : null;
      })
      .filter((entry): entry is { filePath: string; size: number; mtimeMs: number } => entry !== null);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= this.maxCacheBytes) return;
    for (const entry of entries.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (total <= this.maxCacheBytes) break;
      if (entry.filePath === keep) continue;
      try {
        fs.rmSync(entry.filePath, { force: true });
        // The summary sidecar belongs to the payload and would otherwise leak.
        fs.rmSync(entry.filePath.replace(/\.bin$/, ".json"), { force: true });
        total -= entry.size;
      } catch {
        // In use by a live response; leave it for the next build.
      }
    }
  }

  /** Drops everything belonging to superseded revisions of the same chart. */
  private prune(currentKey: string): void {
    const prefix = `${currentKey.split(".")[0]}.`;
    for (const name of this.cacheFiles("")) {
      if (!name.startsWith(prefix)) continue;
      // The current revision owns <key>.bin, <key>.json and <key>.bg.<ext>; anything else
      // under this revision's name is a leftover of an interrupted compilation.
      if (name === `${currentKey}.bin` || name === `${currentKey}.json` || name.startsWith(`${currentKey}.bg.`)) continue;
      try {
        fs.rmSync(path.join(this.cachePath, name), { force: true });
      } catch {
        // Another request may still be streaming it; the next compile prunes again.
      }
    }
  }

  /** Runs one compilation, resolving with the summary the compiler prints on stdout. */
  private run(packagePath: string, outputPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [packagePath, outputPath], { windowsHide: true });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`chart compilation timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < 65536) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 8192) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `chart compiler exited with code ${code}`));
      });
    });
  }

  /** Cache footprint, for the admin status panel. */
  stats(): { entries: number; bytes: number; maxBytes: number } {
    let entries = 0;
    let bytes = 0;
    for (const name of this.cacheFiles(".bin")) {
      const stat = statOrNull(path.join(this.cachePath, name));
      if (!stat) continue;
      entries += 1;
      bytes += stat.size;
    }
    return { entries, bytes, maxBytes: this.maxCacheBytes };
  }
}

/**
 * Reads the JSON summary the compiler prints. It is the only source for a chart's
 * duration, which the admin seek bar needs and which the WASM player does not expose.
 */
function parseSummary(stdout: string): Record<string, unknown> | null {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function statOrNull(filePath: string): fs.Stats | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}
