import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

// Private IDs use nonzero signed i32 values accepted by the client.
export const PRIVATE_CHART_ID = 1_500_000_001;
export const PRIVATE_CHART_MIN_ID = -2_147_483_648;
export const PRIVATE_CHART_MAX_ID = 2_147_483_647;
export const PRIVATE_UPLOADER_ID = 0;
export const PRIVATE_CHART_NAME = "Private Chart";
export const PRIVATE_CHART_ZIP_MAX_ENTRIES = 1024;
export const PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES = 128 * 1024 * 1024;
export const PRIVATE_CHART_ZIP_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export class ZipSizeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipSizeLimitError";
  }
}

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

type ZipBudget = { used: number };

type ZipEntryMetadata = {
  name: string;
  flags: number;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

type PreparedPackage = {
  packageFile: Buffer;
  assets: PackageFiles;
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
  const records = [...entries].map(([entryName, data]) => ({
    name: Buffer.from(entryName.replace(/\\/g, "/"), "utf8"),
    data,
    checksum: crc32(data),
  }));
  const localSize = records.reduce((size, record) => size + 30 + record.name.length + record.data.length, 0);
  const centralSize = records.reduce((size, record) => size + 46 + record.name.length, 0);
  const output = Buffer.allocUnsafe(localSize + centralSize + 22);
  let offset = 0;
  let centralOffset = localSize;
  for (const { name, data, checksum } of records) {
    output.writeUInt32LE(0x04034b50, offset);
    output.writeUInt16LE(20, offset + 4);
    output.writeUInt16LE(0x800, offset + 6);
    output.writeUInt16LE(0, offset + 8);
    output.writeUInt16LE(0, offset + 10);
    output.writeUInt16LE(0, offset + 12);
    output.writeUInt32LE(checksum, offset + 14);
    output.writeUInt32LE(data.length, offset + 18);
    output.writeUInt32LE(data.length, offset + 22);
    output.writeUInt16LE(name.length, offset + 26);
    output.writeUInt16LE(0, offset + 28);
    name.copy(output, offset + 30);
    data.copy(output, offset + 30 + name.length);
    const localSizeForEntry = 30 + name.length + data.length;

    output.writeUInt32LE(0x02014b50, centralOffset);
    output.writeUInt16LE(20, centralOffset + 4);
    output.writeUInt16LE(20, centralOffset + 6);
    output.writeUInt16LE(0x800, centralOffset + 8);
    output.writeUInt16LE(0, centralOffset + 10);
    output.writeUInt16LE(0, centralOffset + 12);
    output.writeUInt16LE(0, centralOffset + 14);
    output.writeUInt32LE(checksum, centralOffset + 16);
    output.writeUInt32LE(data.length, centralOffset + 20);
    output.writeUInt32LE(data.length, centralOffset + 24);
    output.writeUInt16LE(name.length, centralOffset + 28);
    output.writeUInt16LE(0, centralOffset + 30);
    output.writeUInt16LE(0, centralOffset + 32);
    output.writeUInt16LE(0, centralOffset + 34);
    output.writeUInt16LE(0, centralOffset + 36);
    output.writeUInt32LE(0, centralOffset + 38);
    output.writeUInt32LE(offset, centralOffset + 42);
    name.copy(output, centralOffset + 46);
    centralOffset += 46 + name.length;
    offset += localSizeForEntry;
  }
  output.writeUInt32LE(0x06054b50, centralOffset);
  output.writeUInt16LE(0, centralOffset + 4);
  output.writeUInt16LE(0, centralOffset + 6);
  output.writeUInt16LE(records.length, centralOffset + 8);
  output.writeUInt16LE(records.length, centralOffset + 10);
  output.writeUInt32LE(centralSize, centralOffset + 12);
  output.writeUInt32LE(localSize, centralOffset + 16);
  output.writeUInt16LE(0, centralOffset + 20);
  return output;
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

function normalizePackageForClient(packageFile: Buffer, entries: Map<string, Buffer>): Buffer {
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

function zipDirectory(packageFile: Buffer): ZipEntryMetadata[] | null {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let end = packageFile.lastIndexOf(endSignature);
  while (end >= 0) {
    if (end + 22 <= packageFile.length) {
      const commentLength = packageFile.readUInt16LE(end + 20);
      if (end + 22 + commentLength === packageFile.length) break;
    }
    end = packageFile.lastIndexOf(endSignature, end - 1);
  }
  // Keep the existing support for arbitrary non-ZIP packages used by older clients.
  if (end < 0) return null;

  const invalid = (): never => { throw new Error("invalid ZIP package"); };
  if (end + 22 > packageFile.length || packageFile.readUInt32LE(end) !== 0x06054b50) return invalid();
  const diskNumber = packageFile.readUInt16LE(end + 4);
  const directoryDisk = packageFile.readUInt16LE(end + 6);
  const diskCount = packageFile.readUInt16LE(end + 8);
  const count = packageFile.readUInt16LE(end + 10);
  const directorySize = packageFile.readUInt32LE(end + 12);
  const directoryOffset = packageFile.readUInt32LE(end + 16);
  if (count > PRIVATE_CHART_ZIP_MAX_ENTRIES || diskCount > PRIVATE_CHART_ZIP_MAX_ENTRIES) {
    throw new ZipSizeLimitError(`ZIP 条目数超过上限（${PRIVATE_CHART_ZIP_MAX_ENTRIES}）`);
  }
  if (diskNumber !== 0 || directoryDisk !== 0 || diskCount !== count) return invalid();
  if (end >= 20 && packageFile.readUInt32LE(end - 20) === 0x07064b50) {
    throw new Error("ZIP64 package sizes are not supported");
  }
  if (directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error("ZIP64 package sizes are not supported");
  }
  if (directoryOffset + directorySize > end || directoryOffset > packageFile.length) return invalid();

  const metadata: ZipEntryMetadata[] = [];
  const directoryEnd = directoryOffset + directorySize;
  let cursor = directoryOffset;
  let declaredTotal = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > directoryEnd || packageFile.readUInt32LE(cursor) !== 0x02014b50) return invalid();
    const flags = packageFile.readUInt16LE(cursor + 8);
    const compression = packageFile.readUInt16LE(cursor + 10);
    const compressedSize = packageFile.readUInt32LE(cursor + 20);
    const uncompressedSize = packageFile.readUInt32LE(cursor + 24);
    const nameLength = packageFile.readUInt16LE(cursor + 28);
    const extraLength = packageFile.readUInt16LE(cursor + 30);
    const commentLength = packageFile.readUInt16LE(cursor + 32);
    const startDisk = packageFile.readUInt16LE(cursor + 34);
    const localOffset = packageFile.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > directoryEnd) return invalid();
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff || startDisk === 0xffff) {
      throw new Error("ZIP64 package sizes are not supported");
    }
    if (startDisk !== 0) return invalid();
    let extraCursor = cursor + 46 + nameLength;
    const extraEnd = extraCursor + extraLength;
    while (extraCursor + 4 <= extraEnd) {
      const extraId = packageFile.readUInt16LE(extraCursor);
      const extraSize = packageFile.readUInt16LE(extraCursor + 2);
      if (extraCursor + 4 + extraSize > extraEnd) return invalid();
      if (extraId === 0x0001) throw new Error("ZIP64 package sizes are not supported");
      extraCursor += 4 + extraSize;
    }
    if (extraCursor !== extraEnd) return invalid();

    if (uncompressedSize > PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES) {
      throw new ZipSizeLimitError(`ZIP 单条目解压后超过上限（128 MiB）`);
    }
    declaredTotal += uncompressedSize;
    if (declaredTotal > PRIVATE_CHART_ZIP_MAX_TOTAL_BYTES) {
      throw new ZipSizeLimitError("ZIP 解压后总量超过上限（256 MiB）");
    }

    if (localOffset + 30 > directoryOffset || packageFile.readUInt32LE(localOffset) !== 0x04034b50) return invalid();
    const localCompressedSize = packageFile.readUInt32LE(localOffset + 18);
    const localUncompressedSize = packageFile.readUInt32LE(localOffset + 22);
    const localNameLength = packageFile.readUInt16LE(localOffset + 26);
    const localExtraLength = packageFile.readUInt16LE(localOffset + 28);
    if (localCompressedSize === 0xffffffff || localUncompressedSize === 0xffffffff) {
      throw new Error("ZIP64 package sizes are not supported");
    }
    let localExtraCursor = localOffset + 30 + localNameLength;
    const localExtraEnd = localExtraCursor + localExtraLength;
    if (localExtraEnd > directoryOffset) return invalid();
    while (localExtraCursor + 4 <= localExtraEnd) {
      const extraId = packageFile.readUInt16LE(localExtraCursor);
      const extraSize = packageFile.readUInt16LE(localExtraCursor + 2);
      if (localExtraCursor + 4 + extraSize > localExtraEnd) return invalid();
      if (extraId === 0x0001) throw new Error("ZIP64 package sizes are not supported");
      localExtraCursor += 4 + extraSize;
    }
    if (localExtraCursor !== localExtraEnd) return invalid();
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > directoryOffset || dataEnd > directoryOffset || dataEnd < dataStart) return invalid();
    const name = packageFile.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    metadata.push({ name, flags, compression, compressedSize, uncompressedSize, localOffset });
    cursor = recordEnd;
  }
  return metadata;
}

function zipEntries(packageFile: Buffer, budget: ZipBudget = { used: 0 }, directory = zipDirectory(packageFile)): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  if (!directory) return entries;
  const declaredTotal = directory.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (budget.used + declaredTotal > PRIVATE_CHART_ZIP_MAX_TOTAL_BYTES) {
    throw new ZipSizeLimitError("ZIP 解压后总量超过上限（256 MiB）");
  }

  for (const entry of directory) {
    const { name, compression, compressedSize, uncompressedSize, localOffset } = entry;
    if (!name || name.endsWith("/") || name.includes("..")) continue;
    const localNameLength = packageFile.readUInt16LE(localOffset + 26);
    const localExtraLength = packageFile.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = packageFile.subarray(dataStart, dataStart + compressedSize);
    const remaining = PRIVATE_CHART_ZIP_MAX_TOTAL_BYTES - budget.used;
    const allowed = Math.min(PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES, remaining);
    let content: Buffer | null = null;
    try {
      if (compression === 0) {
        content = compressed;
      } else if (compression === 8) {
        content = inflateRawSync(compressed, { maxOutputLength: allowed + 1 });
      }
      if (content) {
        if (content.length > PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES) {
          throw new ZipSizeLimitError("ZIP 单条目实际解压后超过上限（128 MiB）");
        }
        if (content.length > remaining) {
          throw new ZipSizeLimitError("ZIP 解压后实际总量超过上限（256 MiB）");
        }
        budget.used += content.length;
        if (content.length === uncompressedSize) entries.set(name.replace(/\\/g, "/"), content);
      }
    } catch (error) {
      if (error instanceof ZipSizeLimitError) throw error;
      if (error instanceof RangeError) {
        const limit = remaining <= PRIVATE_CHART_ZIP_MAX_ENTRY_BYTES ? "ZIP 解压后总量超过上限（256 MiB）" : "ZIP 单条目实际解压后超过上限（128 MiB）";
        throw new ZipSizeLimitError(limit);
      }
      // A malformed optional entry should not make the whole package path unsafe.
    }
  }
  return entries;
}

function preparePackage(packageFile: Buffer, budget: ZipBudget): PreparedPackage {
  const entries = zipEntries(packageFile, budget);
  const clientPackage = normalizePackageForClient(packageFile, entries);
  return { packageFile: clientPackage, assets: packageAssets(entries) };
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

function packageAssets(entries: Map<string, Buffer>): PackageFiles {
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
        const parsedEntries = zipEntries(originalPackage);
        const clientPackage = normalizePackageForClient(originalPackage, parsedEntries);
        if (clientPackage !== originalPackage) fs.writeFileSync(packagePath, clientPackage);
        const extracted = packageAssets(parsedEntries);
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
    const prepared = preparePackage(files.packageFile, { used: 0 });
    return this.createPrepared(input, files, prepared);
  }

  private createPrepared(input: Partial<PrivateChartDefinition>, files: PrivateChartUploadFiles, prepared: PreparedPackage): PrivateChartDefinition {
    if (!Buffer.isBuffer(files.packageFile) || files.packageFile.length === 0) {
      throw new Error("chart package is required");
    }
    const requestedId = input.id === undefined ? undefined : Number(input.id);
    const id = requestedId === undefined || !Number.isSafeInteger(requestedId) ? this.nextId() : requestedId;
    if (!isPrivateChartId(id)) throw new Error("id must be in the private chart range");
    if (this.get(id)) throw new Error("chart id already exists");
    if (this.idAvailable && !this.idAvailable(id)) throw new Error("Chart ID is already used by another instance");
    const clientPackage = prepared.packageFile;
    const extracted = prepared.assets;
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
    const directory = zipDirectory(collectionFile);
    if (!directory) return null;
    const candidates = directory.filter(({ name }) => {
      const normalized = name.replace(/\\/g, "/");
      return !normalized.includes("/") && /^#-?\d+(?:_|)(.+)\.(pez|zip)$/i.test(normalized);
    });
    if (candidates.length === 0) return null;

    const budget: ZipBudget = { used: 0 };
    const entries = zipEntries(collectionFile, budget, directory);
    const prepared: { entryName: string; input: Partial<PrivateChartDefinition>; packageFile: Buffer; result?: PreparedPackage; error?: string }[] = [];
    for (const candidate of candidates) {
      const entryName = candidate.name.replace(/\\/g, "/");
      const match = /^#(-?\d+)(?:_|)(.+)\.(pez|zip)$/i.exec(entryName);
      if (!match) continue;
      const id = Number(match[1]);
      const fallbackName = match[2].replace(/[_]+/g, " ").trim();
      const packageFile = entries.get(entryName);
      if (!packageFile) {
        prepared.push({ entryName, input: { id, name: fallbackName }, packageFile: Buffer.alloc(0), error: "package entry could not be read" });
        continue;
      }
      try {
        prepared.push({ entryName, input: { id, name: fallbackName }, packageFile, result: preparePackage(packageFile, budget) });
      } catch (error) {
        if (error instanceof ZipSizeLimitError) throw error;
        prepared.push({ entryName, input: { id, name: fallbackName }, packageFile, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const created: PrivateChartDefinition[] = [];
    const skipped: Record<string, string>[] = [];
    for (const item of prepared) {
      if (!item.result) {
        skipped.push({ file: item.entryName, error: item.error || "package entry could not be read" });
        continue;
      }
      try {
        created.push(this.createPrepared(item.input, { packageFile: item.packageFile }, item.result));
      } catch (error) {
        skipped.push({ file: item.entryName, error: error instanceof Error ? error.message : String(error) });
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
