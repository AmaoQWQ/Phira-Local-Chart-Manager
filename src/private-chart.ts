import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

// Private IDs use nonzero signed i32 values accepted by the client.
export const PRIVATE_CHART_ID = 1_500_000_001;
export const PRIVATE_CHART_MIN_ID = -2_147_483_648;
export const PRIVATE_CHART_MAX_ID = 2_147_483_647;
export const PRIVATE_UPLOADER_ID = 0;
export const PRIVATE_CHART_NAME = "Private Chart";

type IllustrationExtension = "jpg" | "jpeg" | "png";
type AudioExtension = "mp3" | "ogg" | "wav";

export interface PrivateChartDefinition {
  id: number;
  name: string;
  level: string;
  difficulty: number;
  charter: string;
  composer: string;
  illustrator: string;
  description: string;
  ranked: boolean;
  reviewed: boolean;
  stable: boolean;
  stableRequest: boolean;
  // Whether this chart is injected into online list/search responses.
  // Direct chart metadata and resource URLs remain available when false.
  listed: boolean;
  tags: string[];
  created: string;
  updated: string;
  chartUpdated: string;
  // Internal asset extensions. They are used to build resource URLs and are
  // removed from the public Chart metadata response.
  illustrationExtension?: IllustrationExtension;
  musicExtension?: AudioExtension;
  previewExtension?: AudioExtension;
  // True when the package ships no dedicated preview entry, so the preview URL is
  // served from the music file. This avoids a duplicate copy on disk and in every
  // asset repair pass. Undefined keeps the legacy behaviour for older records.
  previewIsMusic?: boolean;
  // Identity of the package the extracted assets were produced from. Startup repair
  // uses it to tell "already extracted" from "package was replaced" without opening
  // the package. Absent on records written before this field existed.
  packageAssets?: { size: number; mtimeMs: number };
}

interface PersistedCharts {
  version: 1;
  charts: PrivateChartDefinition[];
}

export interface PrivateResource {
  filePath: string;
  contentType: string;
}

export interface PrivateChartUploadFiles {
  packageFile: Buffer;
  illustration?: Buffer;
  music?: Buffer;
  preview?: Buffer;
}

type PackageFiles = {
  illustration?: Buffer;
  illustrationExtension?: IllustrationExtension;
  music?: Buffer;
  musicExtension?: AudioExtension;
  preview?: Buffer;
  previewExtension?: AudioExtension;
  previewIsMusic?: boolean;
  info?: string;
};

const FALLBACK_LINE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries: Map<string, Buffer>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [entryName, data] of entries) {
    const name = Buffer.from(entryName.replace(/\\/g, "/"), "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(Buffer.concat([local, data]));

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const localData = Buffer.concat(localParts);
  const centralData = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(localData.length, 16);
  return Buffer.concat([localData, centralData, end]);
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

function generatedInfoYml(info: string, entries: Map<string, Buffer>): string {
  const names = [...entries.keys()];
  const first = (pattern: RegExp): string => names.find((name) => pattern.test(name)) || "";
  const name = infoValue(info, "name") || infoValue(info, "title") || "Private Chart";
  const level = infoValue(info, "level") || "Custom";
  const difficulty = infoValue(info, "difficulty") || level.match(/(?:lv\.?|level\s*)(\d+(?:\.\d+)?)/i)?.[1] || "0";
  const music = infoValue(info, "music") || infoValue(info, "song") || first(/\.(?:mp3|ogg|wav)$/i);
  const illustration = infoValue(info, "illustration") || infoValue(info, "picture") || first(/\.(?:jpg|jpeg|png)$/i);
  const chart = infoValue(info, "chart") || first(/\.json$/i);
  return [
    `name: ${yamlQuote(name)}`,
    `level: ${yamlQuote(level)}`,
    `difficulty: ${difficulty}`,
    `charter: ${yamlQuote(infoValue(info, "charter") || "")}`,
    `composer: ${yamlQuote(infoValue(info, "composer") || "")}`,
    `illustrator: ${yamlQuote(infoValue(info, "illustrator") || "")}`,
    `music: ${yamlQuote(music)}`,
    `illustration: ${yamlQuote(illustration)}`,
    `chart: ${yamlQuote(chart)}`,
    "",
  ].join("\n");
}

function normalizePackageForClient(packageFile: Buffer): Buffer {
  const entries = zipEntries(packageFile);
  if (entries.size === 0) return packageFile;
  const names = [...entries.keys()];
  const lowerNames = new Set(names.map((name) => name.toLocaleLowerCase()));
  let changed = false;
  const infoName = names.find((name) => /(?:^|\/)info\.(?:ya?ml)$/i.test(name));
  const textInfoName = names.find((name) => /(?:^|\/)info\.txt$/i.test(name));
  if (!infoName && textInfoName) {
    entries.set("info.yml", Buffer.from(generatedInfoYml(entries.get(textInfoName)?.toString("utf8") || "", entries), "utf8"));
    changed = true;
  } else if (infoName && textInfoName) {
    const existingInfo = entries.get(infoName)?.toString("utf8") || "";
    if (!/\r?\n/.test(existingInfo) && existingInfo.includes("\\n")) {
      entries.set(infoName, Buffer.from(generatedInfoYml(entries.get(textInfoName)?.toString("utf8") || "", entries), "utf8"));
      changed = true;
    }
  }
  const chartTexts = names
    .filter((name) => /\.json$/i.test(name))
    .map((name) => entries.get(name)?.toString("utf8") || "")
    .join("\\n");
  if (!lowerNames.has("line.png") && /["'](?:\.\/)?line\.png["']/i.test(chartTexts)) {
    entries.set("line.png", FALLBACK_LINE_PNG);
    changed = true;
  }
  return changed ? createStoredZip(entries) : packageFile;
}

function zipEntries(packageFile: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const end = packageFile.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > packageFile.length) return entries;
  const count = packageFile.readUInt16LE(end + 10);
  const directoryOffset = packageFile.readUInt32LE(end + 16);
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > packageFile.length || packageFile.readUInt32LE(cursor) !== 0x02014b50) break;
    const flags = packageFile.readUInt16LE(cursor + 8);
    const compression = packageFile.readUInt16LE(cursor + 10);
    const compressedSize = packageFile.readUInt32LE(cursor + 20);
    const nameLength = packageFile.readUInt16LE(cursor + 28);
    const extraLength = packageFile.readUInt16LE(cursor + 30);
    const commentLength = packageFile.readUInt16LE(cursor + 32);
    const localOffset = packageFile.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const name = packageFile.subarray(nameStart, nameStart + nameLength).toString(flags & 0x800 ? "utf8" : "utf8");
    cursor = nameStart + nameLength + extraLength + commentLength;
    if (!name || name.endsWith("/") || name.includes("..")) continue;
    if (localOffset + 30 > packageFile.length || packageFile.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLength = packageFile.readUInt16LE(localOffset + 26);
    const localExtraLength = packageFile.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart < 0 || dataEnd > packageFile.length) continue;
    const compressed = packageFile.subarray(dataStart, dataEnd);
    try {
      const content = compression === 0 ? compressed : compression === 8 ? inflateRawSync(compressed) : null;
      if (content) entries.set(name.replace(/\\/g, "/"), content);
    } catch {
      // A malformed optional entry should not make the whole package path unsafe.
    }
  }
  return entries;
}

/**
 * Lists entry names by reading only the ZIP central directory at the end of the file.
 * This answers "does this package ship its own preview entry?" without inflating the
 * package. Returns null when the directory cannot be read safely, in which case the
 * caller must leave the stored record untouched.
 */
function zipEntryNames(filePath: string): string[] | null {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return null;
  }
  const tailLength = Math.min(size, 1024 * 1024);
  if (tailLength < 22) return null;
  const buffer = Buffer.alloc(tailLength);
  try {
    const handle = fs.openSync(filePath, "r");
    try {
      fs.readSync(handle, buffer, 0, tailLength, size - tailLength);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
  let endOfDirectory = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endOfDirectory = offset;
      break;
    }
  }
  if (endOfDirectory < 0) return null;
  const count = buffer.readUInt16LE(endOfDirectory + 10);
  const directorySize = buffer.readUInt32LE(endOfDirectory + 12);
  const directoryOffset = buffer.readUInt32LE(endOfDirectory + 16);
  // ZIP64 sentinels mean the real directory lives elsewhere; do not guess.
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) return null;
  const base = size - tailLength;
  const limit = directoryOffset - base + directorySize;
  if (directoryOffset < base || directoryOffset + directorySize > size || limit > buffer.length) return null;
  const names: string[] = [];
  let cursor = directoryOffset - base;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > limit || buffer.readUInt32LE(cursor) !== 0x02014b50) return null;
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    if (cursor + 46 + nameLength > limit) return null;
    names.push(buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function packageAssets(packageFile: Buffer): PackageFiles {
  const entries = zipEntries(packageFile);
  const names = [...entries.keys()];
  const findName = (predicate: (name: string) => boolean): string | undefined => names.find(predicate);
  const find = (predicate: (name: string) => boolean): Buffer | undefined => {
    const name = findName(predicate);
    return name ? entries.get(name) : undefined;
  };
  const illustrationName = findName((name) => /(?:^|\/)illustration\.(?:jpg|jpeg|png)$/i.test(name))
    || findName((name) => /\.(jpg|jpeg|png)$/i.test(name));
  const musicName = findName((name) => /(?:^|\/)music\.(?:mp3|ogg|wav)$/i.test(name))
    || findName((name) => /\.(mp3|ogg|wav)$/i.test(name));
  const previewName = findName((name) => /(?:^|\/)preview\.(?:mp3|ogg|wav)$/i.test(name));
  const infoName = findName((name) => /(?:^|\/)info\.(?:ya?ml|txt)$/i.test(name));
  const imageExtension = (name: string | undefined): IllustrationExtension | undefined => {
    const extension = name?.split(".").pop()?.toLocaleLowerCase();
    return extension === "jpeg" ? "jpg" : extension === "jpg" || extension === "png" ? extension : undefined;
  };
  const audioExtension = (name: string | undefined): AudioExtension | undefined => {
    const extension = name?.split(".").pop()?.toLocaleLowerCase();
    return extension === "ogg" || extension === "wav" ? extension : extension === "mp3" ? "mp3" : undefined;
  };
  const dedicatedPreview = previewName ? entries.get(previewName) : undefined;
  return {
    illustration: illustrationName ? entries.get(illustrationName) : undefined,
    illustrationExtension: imageExtension(illustrationName),
    music: musicName ? entries.get(musicName) : undefined,
    musicExtension: audioExtension(musicName),
    preview: dedicatedPreview || (musicName ? entries.get(musicName) : undefined),
    previewExtension: audioExtension(previewName) || audioExtension(musicName),
    previewIsMusic: !dedicatedPreview && Boolean(musicName),
    info: infoName ? entries.get(infoName)?.toString("utf8") : undefined,
  };
}

function infoValue(info: string | undefined, key: string): string | undefined {
  if (!info) return undefined;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*${escapedKey}\\s*[:=]\\s*(.*?)\\s*$`, "mi").exec(info);
  if (!match || !match[1] || /^null$/i.test(match[1])) return undefined;
  return match[1].replace(/^['"]|['"]$/g, "").trim();
}

export function isPrivateChartId(id: number): boolean {
  return Number.isSafeInteger(id) && id >= PRIVATE_CHART_MIN_ID && id <= PRIVATE_CHART_MAX_ID && id !== 0;
}

export function privateChartIdFromPath(pathname: string): number | null {
  const matches = [
    /^\/chart\/(\-?\d+)(?:\/|$)/,
    /^\/record\/(?:best|list15)\/(\-?\d+)(?:\/|$)/,
  ];
  for (const pattern of matches) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    const id = Number(match[1]);
    if (Number.isSafeInteger(id)) return id;
  }
  return null;
}

function legacyDefinition(): PrivateChartDefinition {
  return {
    id: PRIVATE_CHART_ID,
    name: PRIVATE_CHART_NAME,
    level: "Custom",
    difficulty: 0,
    charter: "",
    composer: "",
    illustrator: "",
    description: "",
    ranked: false,
    reviewed: false,
    stable: false,
    stableRequest: false,
    listed: true,
    tags: [],
    created: "2026-09-03T00:00:00Z",
    updated: "2026-09-03T00:00:00Z",
    chartUpdated: "2026-09-03T00:00:00Z",
  };
}

function validDefinition(value: unknown): value is PrivateChartDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<PrivateChartDefinition>;
  return isPrivateChartId(item.id || 0) && typeof item.name === "string" && item.name.trim() !== "";
}

/**
 * Asset files this record expects inside its chart directory. Only extensions that
 * were actually extracted are listed, so a chart whose package has no illustration
 * simply has nothing to check for that slot. A shared preview reuses the music file
 * and therefore requires no file of its own.
 */
function expectedAssetFiles(chart: PrivateChartDefinition): string[] {
  const files: string[] = [];
  if (chart.illustrationExtension) files.push(`illustration.${chart.illustrationExtension}`);
  if (chart.musicExtension) files.push(`music.${chart.musicExtension}`);
  if (chart.previewExtension && chart.previewIsMusic !== true) files.push(`preview.${chart.previewExtension}`);
  return files;
}

export class PrivateChartStore {
  private readonly metadataPath: string;
  private data: PersistedCharts;

  constructor(private readonly rootPath: string, private readonly idAvailable?: (id: number) => boolean) {
    this.metadataPath = path.join(rootPath, "charts.json");
    this.data = this.load();
    this.repairExtractedAssets();
  }

  private load(): PersistedCharts {
    if (!fs.existsSync(this.metadataPath)) return { version: 1, charts: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metadataPath, "utf8")) as Partial<PersistedCharts>;
      const charts = Array.isArray(parsed.charts)
        ? parsed.charts.filter(validDefinition).map((chart) => ({ ...chart, listed: chart.listed !== false }))
        : [];
      return { version: 1, charts };
    } catch {
      return { version: 1, charts: [] };
    }
  }

  private save(): void {
    fs.mkdirSync(this.rootPath, { recursive: true });
    const temporary = `${this.metadataPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(temporary, this.metadataPath);
  }

  private repairExtractedAssets(): void {
    let changed = false;
    for (const chart of this.data.charts) {
      const directory = this.directoryFor(chart.id);
      const packagePath = path.join(directory, "chart-package.pez");
      let packageStat: fs.Stats;
      try {
        packageStat = fs.statSync(packagePath);
      } catch {
        continue;
      }
      const identity = { size: packageStat.size, mtimeMs: packageStat.mtimeMs };
      // Fast path: the package is still the one the assets were extracted from and
      // every expected asset file is present. Nothing has to be read, decompressed or
      // rewritten, so startup cost scales with the chart count instead of the total
      // package size. Records written before package identity existed are upgraded in
      // place on their first successful pass.
      const expected = expectedAssetFiles(chart);
      if (expected.length > 0 && this.assetsAreFresh(directory, expected, chart, identity)) {
        // Records written before preview sharing was recorded never learned whether
        // their preview is a dedicated entry or a copy of the music file. The package
        // answers that from its central directory alone, so the redundant copy can be
        // recognised — and later removed — without inflating anything.
        if (chart.previewIsMusic === undefined && chart.previewExtension === chart.musicExtension) {
          const names = zipEntryNames(packagePath);
          if (names && !names.some((name) => /(?:^|\/)preview\.(?:mp3|ogg|wav)$/i.test(name))) {
            chart.previewIsMusic = true;
            changed = true;
          }
        }
        if (!chart.packageAssets) {
          chart.packageAssets = identity;
          changed = true;
        }
        continue;
      }
      try {
        const originalPackage = fs.readFileSync(packagePath);
        const clientPackage = normalizePackageForClient(originalPackage);
        if (clientPackage !== originalPackage) fs.writeFileSync(packagePath, clientPackage);
        const extracted = packageAssets(clientPackage);
        if (extracted.illustration) {
          const extension = extracted.illustrationExtension || "jpg";
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(path.join(directory, `illustration.${extension}`), extracted.illustration);
          if (chart.illustrationExtension !== extension) {
            chart.illustrationExtension = extension;
            changed = true;
          }
        }
        if (extracted.music) {
          const extension = extracted.musicExtension || "mp3";
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(path.join(directory, `music.${extension}`), extracted.music);
          if (chart.musicExtension !== extension) {
            chart.musicExtension = extension;
            changed = true;
          }
        }
        // A package without its own preview entry is served straight from the music
        // file, so the duplicate preview copy is neither written nor required.
        const previewIsMusic = extracted.previewIsMusic === true;
        const previewExtension = extracted.previewExtension || extracted.musicExtension;
        if (chart.previewExtension !== previewExtension) {
          chart.previewExtension = previewExtension;
          changed = true;
        }
        if (chart.previewIsMusic !== (previewIsMusic || undefined)) {
          chart.previewIsMusic = previewIsMusic || undefined;
          changed = true;
        }
        if (extracted.preview && !previewIsMusic) {
          const extension = extracted.previewExtension || extracted.musicExtension || "mp3";
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(path.join(directory, `preview.${extension}`), extracted.preview);
        }
        // Record the identity of the package as it now stands on disk, after any
        // normalisation rewrite, so the next start-up can take the fast path.
        const finalStat = fs.statSync(packagePath);
        chart.packageAssets = { size: finalStat.size, mtimeMs: finalStat.mtimeMs };
        changed = true;
      } catch {
        // Keep a previously valid chart available if one package is malformed.
      }
    }
    if (changed) this.save();
  }

  /**
   * True when the recorded package identity still matches and every expected asset
   * exists. Records without a recorded identity fall back to comparing timestamps, so
   * an asset older than its package always forces a full repair.
   */
  private assetsAreFresh(
    directory: string,
    expected: string[],
    chart: PrivateChartDefinition,
    identity: { size: number; mtimeMs: number },
  ): boolean {
    const recorded = chart.packageAssets;
    if (recorded && (recorded.size !== identity.size || recorded.mtimeMs !== identity.mtimeMs)) return false;
    for (const name of expected) {
      try {
        const stat = fs.statSync(path.join(directory, name));
        // A zero-length asset means a failed extraction, and an asset older than its
        // package (legacy records only) means the package was replaced.
        if (stat.size === 0) return false;
        if (!recorded && stat.mtimeMs + 1000 < identity.mtimeMs) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  list(): PrivateChartDefinition[] {
    return this.data.charts.map((chart) => ({ ...chart, tags: [...chart.tags] }));
  }

  get(id: number): PrivateChartDefinition | null {
    return this.data.charts.find((chart) => chart.id === id) || null;
  }

  create(input: Partial<PrivateChartDefinition>, files: PrivateChartUploadFiles): PrivateChartDefinition {
    if (!Buffer.isBuffer(files.packageFile) || files.packageFile.length === 0) {
      throw new Error("chart package is required");
    }
    const requestedId = input.id === undefined ? undefined : Number(input.id);
    const id = requestedId === undefined || !Number.isSafeInteger(requestedId) ? this.nextId() : requestedId;
    if (!isPrivateChartId(id)) throw new Error("id must be in the private chart range");
    if (this.get(id)) throw new Error("chart id already exists");
    if (this.idAvailable && !this.idAvailable(id)) throw new Error("Chart ID is already used by another instance");
    const clientPackage = normalizePackageForClient(files.packageFile);
    const extracted = packageAssets(clientPackage);
    const packageName = infoValue(extracted.info, "name");
    const packageLevel = infoValue(extracted.info, "level");
    const packageDifficulty = infoValue(extracted.info, "difficulty");
    const packageCharter = infoValue(extracted.info, "charter");
    const packageComposer = infoValue(extracted.info, "composer");
    const packageIllustrator = infoValue(extracted.info, "illustrator");
    // The preview reuses the music file only when the package ships no preview entry
    // and no preview was uploaded alongside it.
    const previewIsMusic = extracted.previewIsMusic === true && !files.preview;
    const now = new Date().toISOString();
    const chart: PrivateChartDefinition = {
      id,
      name: String(input.name || packageName || "Private Chart").trim() || "Private Chart",
      level: String(input.level || packageLevel || "Custom").trim(),
      difficulty: Number.isFinite(Number(input.difficulty)) && Number(input.difficulty) !== 0 ? Number(input.difficulty) : Number(packageDifficulty || 0),
      charter: String(input.charter || packageCharter || "").trim(),
      composer: String(input.composer || packageComposer || "").trim(),
      illustrator: String(input.illustrator || packageIllustrator || "").trim(),
      description: String(input.description || ""),
      ranked: Boolean(input.ranked),
      reviewed: Boolean(input.reviewed),
      stable: Boolean(input.stable),
      stableRequest: Boolean(input.stableRequest),
      listed: input.listed !== false,
      tags: Array.isArray(input.tags) ? input.tags.map(String).map((tag) => tag.trim()).filter(Boolean) : [],
      created: typeof input.created === "string" && input.created ? input.created : now,
      updated: typeof input.updated === "string" && input.updated ? input.updated : now,
      chartUpdated: typeof input.chartUpdated === "string" && input.chartUpdated ? input.chartUpdated : now,
      illustrationExtension: extracted.illustrationExtension || (files.illustration ? "jpg" : undefined),
      musicExtension: extracted.musicExtension || (files.music ? "mp3" : undefined),
      previewExtension: extracted.previewExtension || extracted.musicExtension || (files.preview ? "mp3" : undefined),
      previewIsMusic: previewIsMusic || undefined,
    };
    const directory = this.directoryFor(id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "chart-package.pez"), clientPackage);
    if (files.illustration || extracted.illustration) fs.writeFileSync(path.join(directory, `illustration.${chart.illustrationExtension || "jpg"}`), files.illustration || extracted.illustration!);
    if (files.music || extracted.music) fs.writeFileSync(path.join(directory, `music.${chart.musicExtension || "mp3"}`), files.music || extracted.music!);
    if (files.preview || (extracted.preview && !previewIsMusic)) fs.writeFileSync(path.join(directory, `preview.${chart.previewExtension || "mp3"}`), files.preview || extracted.preview!);
    try {
      const packageStat = fs.statSync(path.join(directory, "chart-package.pez"));
      chart.packageAssets = { size: packageStat.size, mtimeMs: packageStat.mtimeMs };
    } catch {
      // Startup repair records the identity when the file cannot be stat'ed here.
    }
    this.data.charts.push(chart);
    this.save();
    return chart;
  }

  importCollection(collectionFile: Buffer): { created: PrivateChartDefinition[]; skipped: Record<string, string>[] } | null {
    const entries = zipEntries(collectionFile);
    const candidates = [...entries.entries()].filter(([name]) => {
      const normalized = name.replace(/\\/g, "/");
      return !normalized.includes("/") && /^#-?\d+(?:_|)(.+)\.(pez|zip)$/i.test(normalized);
    });
    if (candidates.length === 0) return null;

    const created: PrivateChartDefinition[] = [];
    const skipped: Record<string, string>[] = [];
    for (const [entryName, packageFile] of candidates) {
      const match = /^#(-?\d+)(?:_|)(.+)\.(pez|zip)$/i.exec(entryName);
      if (!match) continue;
      const id = Number(match[1]);
      const fallbackName = match[2].replace(/[_]+/g, " ").trim();
      try {
        created.push(this.create({ id, name: fallbackName }, { packageFile }));
      } catch (error) {
        skipped.push({ file: entryName, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { created, skipped };
  }

  update(id: number, input: Partial<PrivateChartDefinition>): PrivateChartDefinition | null {
    const chart = this.get(id);
    if (!chart) return null;
    const next: PrivateChartDefinition = {
      ...chart,
      ...input,
      id: chart.id,
      name: String(input.name ?? chart.name).trim() || chart.name,
      level: String(input.level ?? chart.level).trim(),
      difficulty: Number.isFinite(Number(input.difficulty ?? chart.difficulty)) ? Number(input.difficulty ?? chart.difficulty) : chart.difficulty,
      listed: input.listed === undefined ? chart.listed !== false : Boolean(input.listed),
      tags: Array.isArray(input.tags) ? input.tags.map(String).map((tag) => tag.trim()).filter(Boolean) : chart.tags,
      updated: new Date().toISOString(),
    };
    const index = this.data.charts.findIndex((item) => item.id === id);
    this.data.charts[index] = next;
    this.save();
    return next;
  }

  updateManyTags(ids: number[], tags: string[], mode: "replace" | "add" | "remove"): PrivateChartDefinition[] {
    const requested = new Set(ids.filter((id) => isPrivateChartId(id)));
    const cleanTags = [...new Set(tags.map(String).map((tag) => tag.trim()).filter(Boolean))];
    const changed: PrivateChartDefinition[] = [];
    for (const chart of this.data.charts) {
      if (!requested.has(chart.id)) continue;
      const nextTags = mode === "replace"
        ? cleanTags
        : mode === "add"
          ? [...chart.tags, ...cleanTags].filter((tag, index, values) => values.indexOf(tag) === index)
          : chart.tags.filter((tag) => !cleanTags.some((remove) => remove.toLocaleLowerCase() === tag.toLocaleLowerCase()));
      if (JSON.stringify(chart.tags) === JSON.stringify(nextTags)) continue;
      chart.tags = nextTags;
      chart.updated = new Date().toISOString();
      changed.push({ ...chart, tags: [...chart.tags] });
    }
    if (changed.length > 0) this.save();
    return changed;
  }

  /**
   * Removes one chart. Metadata is updated first (cheap and authoritative), then the
   * asset directory is deleted asynchronously so a multi-gigabyte removal never blocks
   * the event loop that serves every other request.
   */
  async delete(id: number): Promise<boolean> {
    const index = this.data.charts.findIndex((chart) => chart.id === id);
    if (index < 0) return false;
    const directory = this.checkedDirectory(id);
    this.data.charts.splice(index, 1);
    this.save();
    await fs.promises.rm(directory, { recursive: true, force: true });
    return true;
  }

  async deleteMany(ids: number[]): Promise<number[]> {
    const requested = new Set(ids.filter((id) => isPrivateChartId(id)));
    const deleted = this.data.charts.filter((chart) => requested.has(chart.id)).map((chart) => chart.id);
    if (deleted.length === 0) return deleted;
    // Validate every target before mutating anything, so a bad id cannot leave the
    // metadata out of sync with the files on disk.
    const directories = deleted.map((id) => this.checkedDirectory(id));
    this.data.charts = this.data.charts.filter((chart) => !requested.has(chart.id));
    this.save();
    const results = await Promise.allSettled(directories.map((directory) => fs.promises.rm(directory, { recursive: true, force: true })));
    for (const result of results) {
      if (result.status === "rejected") process.stderr.write(`Failed to remove chart directory: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}\n`);
    }
    return deleted;
  }

  private checkedDirectory(id: number): string {
    const directory = this.directoryFor(id);
    if (path.dirname(directory) !== path.resolve(this.rootPath)) throw new Error("invalid chart directory");
    return directory;
  }

  directoryFor(id: number): string {
    if (!isPrivateChartId(id)) throw new Error("invalid private chart id");
    return path.join(path.resolve(this.rootPath), String(id));
  }

  private nextId(): number {
    const used = new Set(this.data.charts.map((chart) => chart.id));
    for (let id = PRIVATE_CHART_ID; id <= PRIVATE_CHART_MAX_ID; id += 1) {
      if (!used.has(id) && (!this.idAvailable || this.idAvailable(id))) return id;
    }
    throw new Error("private chart id range is exhausted");
  }
}

export interface PrivateChartRatingSummary {
  rating: number | null;
  ratingCount: number;
}

type RatingSummaryProvider = (chartId: number) => PrivateChartRatingSummary;

function chartMetadata(
  definition: PrivateChartDefinition,
  baseUrl: string,
  ratingSummary: PrivateChartRatingSummary = { rating: null, ratingCount: 0 },
): Record<string, unknown> {
  const origin = baseUrl.replace(/\/+$/, "");
  const { illustrationExtension, musicExtension, previewExtension, listed, ...publicDefinition } = definition;
  return {
    ...publicDefinition,
    illustration: `${origin}/private-files/${definition.id}/illustration.${illustrationExtension || "jpg"}`,
    preview: `${origin}/private-files/${definition.id}/preview.${previewExtension || musicExtension || "mp3"}`,
    file: `${origin}/private-charts/${definition.id}.pez`,
    uploader: PRIVATE_UPLOADER_ID,
    rating: ratingSummary.rating,
    ratingCount: ratingSummary.ratingCount,
  };
}

export function privateChartMetadata(baseUrl: string, definition = legacyDefinition()): Record<string, unknown> {
  return chartMetadata(definition, baseUrl);
}

export function getPrivateChartById(
  id: number,
  baseUrl: string,
  store?: PrivateChartStore,
  ratingSummary?: PrivateChartRatingSummary,
): Record<string, unknown> | null {
  if (!isPrivateChartId(id)) return null;
  const definition = store ? store.get(id) : id === PRIVATE_CHART_ID ? legacyDefinition() : null;
  return definition ? chartMetadata(definition, baseUrl, ratingSummary) : null;
}

export function privateChartListItem(
  baseUrl: string,
  definition = legacyDefinition(),
  ratingSummary?: PrivateChartRatingSummary,
): Record<string, unknown> {
  return chartMetadata(definition, baseUrl, ratingSummary);
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function queryBoolean(query: URLSearchParams, name: string): boolean | undefined {
  const value = query.get(name);
  if (value === null || value.trim() === "") return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLocaleLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLocaleLowerCase())) return false;
  return undefined;
}

export function shouldIncludePrivateChart(query: URLSearchParams, definition = legacyDefinition()): boolean {
  if (definition.listed === false) return false;
  const search = normalized(query.get("search") || "");
  if (search) {
    const searchable = [definition.name, definition.level, definition.charter, definition.composer, definition.illustrator, ...definition.tags];
    if (!searchable.some((value) => normalized(value).includes(search))) return false;
  }
  const division = normalized(query.get("division") || "");
  if (division && division !== "regular") return false;
  const tags = (query.get("tags") || "").split(/[\s,]+/).map(normalized).filter(Boolean);
  if (tags.length > 0 && !tags.every((tag) => definition.tags.map(normalized).includes(tag))) return false;
  for (const key of ["ranked", "reviewed", "stable"] as const) {
    const value = queryBoolean(query, key);
    if (value === true || (value === false && definition[key])) return false;
  }
  const uploader = query.get("uploader");
  if (uploader !== null && uploader.trim() !== String(PRIVATE_UPLOADER_ID)) return false;
  const type = query.get("type");
  if (type === "0" || type === "1") return false;
  for (const key of ["difficulty", "level", "from", "to", "createdFrom", "createdTo"]) {
    if (query.has(key) && (query.get(key) || "").trim() !== "") return false;
  }
  return true;
}

export function mergePrivateChartsIntoList(
  response: unknown,
  query: URLSearchParams,
  baseUrl: string,
  store?: Pick<PrivateChartStore, "list">,
  ratingSummaryProvider?: RatingSummaryProvider,
): unknown {
  if (!response || typeof response !== "object" || Array.isArray(response)) return response;
  const listResponse = response as { results?: unknown; count?: unknown };
  if (!Array.isArray(listResponse.results)) return response;
  const definitions = store ? store.list() : [legacyDefinition()];
  const eligible = definitions.filter((definition) => shouldIncludePrivateChart(query, definition));
  const existing = new Set(listResponse.results.map((item) => item && typeof item === "object" ? (item as { id?: unknown }).id : null));
  const missing = eligible.filter((definition) => !existing.has(definition.id));
  if (missing.length === 0) return response;
  const page = Number(query.get("page") || "1");
  if (!Number.isSafeInteger(page)) return response;
  const nextResponse: Record<string, unknown> = { ...(response as Record<string, unknown>) };
  if (page === 1) {
    nextResponse.results = missing
      .map((definition) => privateChartListItem(baseUrl, definition, ratingSummaryProvider?.(definition.id)))
      .concat(listResponse.results);
  }
  if (typeof listResponse.count === "number" && Number.isFinite(listResponse.count)) nextResponse.count = listResponse.count + missing.length;
  return nextResponse;
}

function audioContentType(extension: string): string {
  return extension === "ogg" ? "audio/ogg" : extension === "wav" ? "audio/wav" : "audio/mpeg";
}

export function privateResourceForPath(pathname: string, privateChartsPath: string, store?: PrivateChartStore): PrivateResource | null {
  const packageMatch = /^\/private-charts\/(\-?\d+)\.pez$/.exec(pathname);
  const fileMatch = /^\/private-files\/(\-?\d+)\/(illustration|music|preview)\.(jpg|jpeg|png|mp3|ogg|wav)$/.exec(pathname);
  const id = Number(packageMatch?.[1] || fileMatch?.[1] || 0);
  if (!isPrivateChartId(id)) return null;
  const definition = store ? store.get(id) : id === PRIVATE_CHART_ID ? legacyDefinition() : null;
  if (!definition) return null;
  if (packageMatch) return { filePath: path.join(privateChartsPath, String(id), "chart-package.pez"), contentType: "application/octet-stream" };
  if (!fileMatch) return null;
  const directory = path.join(privateChartsPath, String(id));
  if (fileMatch[2] === "preview" && definition.previewIsMusic === true) {
    // No dedicated preview file is stored; the music file is served under the preview URL.
    const extension = definition.musicExtension || fileMatch[3];
    return { filePath: path.join(directory, `music.${extension}`), contentType: audioContentType(extension) };
  }
  const fileName = `${fileMatch[2]}.${fileMatch[3]}`;
  const contentType = fileMatch[2] === "illustration"
    ? fileMatch[3] === "png" ? "image/png" : "image/jpeg"
    : audioContentType(fileMatch[3]);
  return { filePath: path.join(directory, fileName), contentType };
}

export function isPrivateResourcePath(pathname: string): boolean {
  return /^\/private-charts\/\-?\d+\.pez$/.test(pathname) || /^\/private-files\/\-?\d+\/(?:illustration|music|preview)\.(?:jpg|jpeg|png|mp3|ogg|wav)$/.test(pathname);
}

export function privateUploaderMetadata(): Record<string, unknown> {
  return {
    id: PRIVATE_UPLOADER_ID,
    name: "Private Chart",
    email: null,
    hykbUid: null,
    avatar: null,
    badge: null,
    badges: [],
    badgeNames: {},
    language: "zh-CN",
    bio: "Local private chart uploader",
    exp: 0,
    rks: 0,
    roles: 0,
    joined: "2026-09-03T00:00:00Z",
    lastLogin: "2026-09-03T00:00:00Z",
  };
}
