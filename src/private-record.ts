import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, inflateSync } from "node:zlib";
import { PRIVATE_CHART_ID, PRIVATE_UPLOADER_ID } from "./private-chart";

const PRIVATE_PLAYER_BASE = 2_000_000_000;
const PRIVATE_PLAYER_RANGE = 100_000_000;
const FIRST_RECORD_ID = 1_600_000_001;

export interface PrivateRecordSummary {
  score: number;
  accuracy: number;
  fullCombo: boolean;
  perfect: number;
  good: number;
  bad: number;
  miss: number;
  maxCombo: number;
  speed: number;
  mods: number;
}

interface PrivateRecord extends PrivateRecordSummary {
  id: number;
  player: number;
  chart: number;
  best: boolean;
  bestStd: boolean;
  time: string;
  std: number | null;
  stdScore: number | null;
  payloadSha256?: string;
}

interface PrivatePlayer {
  id: number;
  name: string;
  joined: string;
  lastLogin: string;
  sourceName?: string;
  sourceAvatar?: string | null;
}

interface PrivateRating {
  owner: string;
  chart: number;
  score: number;
  time: string;
}

interface PersistedStore {
  version: 1;
  nextRecordId: number;
  players: Record<string, PrivatePlayer>;
  authBindings: Record<string, number>;
  records: PrivateRecord[];
  ratings: PrivateRating[];
}

export interface PrivateUploadResult {
  chart: number;
  summary: PrivateRecordSummary;
}

/** Legacy response kept for callers that explicitly use the old opaque mode. */
export function privateOpaqueUploadAcknowledgement(): Record<string, unknown> {
  return {
    id: 0,
    expDelta: 0,
    newBest: false,
    improvement: 0,
    newRks: 0,
  };
}

export function privateUploadChartId(body: Buffer): number | null {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const chart = (parsed as Record<string, unknown>).chart;
    return typeof chart === "number" && Number.isSafeInteger(chart) ? chart : null;
  } catch {
    return null;
  }
}

/**
 * Opt-in local capture for reverse engineering the private upload format.
 * It deliberately stores only chart metadata and token, never request headers/body.
 */
export function capturePrivateUploadToken(body: Buffer, filePath: string | null): void {
  if (!filePath) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const payload = parsed as Record<string, unknown>;
  if (payload.chart !== PRIVATE_CHART_ID || typeof payload.token !== "string") return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify({
    capturedAt: new Date().toISOString(),
    chart: PRIVATE_CHART_ID,
    chartUpdated: typeof payload.chartUpdated === "string" ? payload.chartUpdated : null,
    token: payload.token,
  }) + "\n";
  fs.appendFileSync(filePath, line, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows may not support POSIX modes. */ }
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function integer(value: unknown, fallback = 0): number {
  const numberValue = finiteNumber(value, fallback);
  return Number.isSafeInteger(numberValue) ? numberValue : Math.trunc(numberValue);
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readSummary(value: unknown): PrivateRecordSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const scoreValue = record.score;
  if (typeof scoreValue !== "number" || !Number.isFinite(scoreValue) || scoreValue < 0 || scoreValue > 1_000_000) {
    return null;
  }
  let accuracy = finiteNumber(record.accuracy, 0);
  if (accuracy > 1 && accuracy <= 100) accuracy /= 100;
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1) return null;
  return {
    score: Math.round(scoreValue),
    accuracy,
    fullCombo: booleanValue(record.fullCombo ?? record.full_combo ?? record.fc),
    perfect: integer(record.perfect),
    good: integer(record.good),
    bad: integer(record.bad),
    miss: integer(record.miss),
    maxCombo: integer(record.maxCombo ?? record.max_combo),
    speed: finiteNumber(record.speed, 1),
    mods: integer(record.mods),
  };
}

export function normalizePrivateRecordSummary(value: unknown): PrivateRecordSummary | null {
  return readSummary(value);
}

function findSummary(value: unknown, depth = 0): PrivateRecordSummary | null {
  if (depth > 5 || value === null || value === undefined) return null;
  const direct = readSummary(value);
  if (direct) return direct;
  if (typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSummary(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const child of Object.values(value)) {
    const found = findSummary(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function jsonCandidates(bytes: Buffer): unknown[] {
  const candidates: Buffer[] = [bytes];
  for (const decoder of [gunzipSync, inflateSync]) {
    try {
      candidates.push(decoder(bytes));
    } catch {
      // Not a zlib/gzip payload; try the next representation.
    }
  }
  const values: unknown[] = [];
  for (const candidate of candidates) {
    const text = candidate.toString("utf8");
    const starts = [0, text.indexOf("{")].filter((value) => value >= 0);
    for (const start of starts) {
      const end = text.lastIndexOf("}");
      if (end < start) continue;
      try {
        values.push(JSON.parse(text.slice(start, end + 1)) as unknown);
      } catch {
        // The official closed client may use a binary token. Explicit summary fields
        // and JSON/base64 JSON remain supported for this independent gateway.
      }
    }
  }
  return values;
}

function decodeTokenSummary(token: unknown): PrivateRecordSummary | null {
  if (typeof token !== "string" || token.length < 4) return null;
  const normalized = token.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bytes = Buffer.from(normalized, "base64");
    for (const value of jsonCandidates(bytes)) {
      const summary = findSummary(value);
      if (summary) return summary;
    }
  } catch {
    return null;
  }
  return null;
}

/** Return safe diagnostics for an upload that could not be decoded. */
export function privateUploadDiagnostics(body: Buffer): Record<string, unknown> {
  const diagnostics: Record<string, unknown> = { bodyBytes: body.length };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    diagnostics.parse = "invalid-json";
    return diagnostics;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.parse = "non-object-json";
    return diagnostics;
  }

  const payload = parsed as Record<string, unknown>;
  diagnostics.keys = Object.keys(payload).sort();
  diagnostics.chart = typeof payload.chart === "number" ? payload.chart : typeof payload.chart;
  diagnostics.hasDirectSummary = Boolean(findSummary(payload));

  if (typeof payload.token !== "string") {
    diagnostics.token = "missing-or-not-string";
    return diagnostics;
  }

  diagnostics.tokenChars = payload.token.length;
  diagnostics.tokenSha256 = crypto.createHash("sha256").update(payload.token).digest("hex");
  try {
    const normalized = payload.token.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalized, "base64");
    const prefix = decoded.subarray(0, 32);
    diagnostics.decodedBytes = decoded.length;
    diagnostics.decodedPrefixHex = prefix.toString("hex");
    diagnostics.decodedPrefixAscii = prefix.toString("ascii").replace(/[^\x20-\x7e]/g, ".");
    diagnostics.encoding = decoded.length > 2 && decoded[0] === 0x1f && decoded[1] === 0x8b
      ? "gzip"
      : decoded.length > 2 && decoded[0] === 0x78
        ? "zlib-like"
        : "binary-or-raw";
  } catch {
    diagnostics.encoding = "invalid-base64";
  }
  return diagnostics;
}

export function parsePrivateUploadPayload(body: Buffer): PrivateUploadResult | null {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const chart = integer(payload.chart, -1);
  if (chart !== PRIVATE_CHART_ID) return null;
  const summary = findSummary(payload) || decodeTokenSummary(payload.token);
  if (!summary) return null;
  return { chart, summary };
}

function defaultStore(): PersistedStore {
  return { version: 1, nextRecordId: FIRST_RECORD_ID, players: {}, authBindings: {}, records: [], ratings: [] };
}

function compareRecords(left: PrivateRecord, right: PrivateRecord): number {
  return right.score - left.score || right.accuracy - left.accuracy || left.time.localeCompare(right.time);
}

export class PrivateRecordStore {
  private readonly filePath: string;
  private data: PersistedStore;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): PersistedStore {
    if (!fs.existsSync(this.filePath)) return defaultStore();
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<PersistedStore>;
    if (parsed.version !== 1 || !Array.isArray(parsed.records) || !parsed.players) return defaultStore();
    return {
      version: 1,
      nextRecordId: Number(parsed.nextRecordId) || FIRST_RECORD_ID,
      players: parsed.players as Record<string, PrivatePlayer>,
      authBindings: parsed.authBindings && typeof parsed.authBindings === "object"
        ? parsed.authBindings as Record<string, number>
        : {},
      records: parsed.records as PrivateRecord[],
      ratings: Array.isArray(parsed.ratings) ? parsed.ratings as PrivateRating[] : [],
    };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tempPath, this.filePath);
  }

  playerIdForAuthorization(authorization: string | string[] | undefined): number {
    const value = Array.isArray(authorization) ? authorization.join(",") : authorization || "anonymous";
    const authKey = crypto.createHash("sha256").update(value).digest("hex");
    const boundId = this.data.authBindings[authKey];
    const digest = Buffer.from(authKey, "hex");
    const id = Number.isSafeInteger(boundId) && boundId > 0
      ? boundId
      : PRIVATE_PLAYER_BASE + (digest.readUInt32BE(0) % PRIVATE_PLAYER_RANGE);
    const now = new Date().toISOString();
    const key = String(id);
    const player = this.data.players[key];
    if (player) {
      player.lastLogin = now;
    } else {
      this.data.players[key] = { id, name: "Private Player", joined: now, lastLogin: now };
    }
    this.save();
    return id;
  }

  bindAuthorizationToUser(authorization: string | string[] | undefined, userId: number): number | null {
    const value = Array.isArray(authorization) ? authorization.join(",") : authorization;
    if (!value || !Number.isSafeInteger(userId) || userId <= 0) return null;
    const authKey = crypto.createHash("sha256").update(value).digest("hex");
    const existing = this.data.authBindings[authKey];
    if (existing !== undefined && existing !== userId) return null;
    this.data.authBindings[authKey] = userId;
    const now = new Date().toISOString();
    const key = String(userId);
    if (this.data.players[key]) this.data.players[key].lastLogin = now;
    else this.data.players[key] = { id: userId, name: "Private Player", joined: now, lastLogin: now };
    this.save();
    return userId;
  }

  hasPlayer(id: number): boolean {
    return id !== PRIVATE_UPLOADER_ID && Boolean(this.data.players[String(id)]);
  }

  userMetadata(id: number): Record<string, unknown> | null {
    const player = this.data.players[String(id)];
    if (!player) return null;
    const displayName = `${player.sourceName || player.name || "Private Player"}`.replace(/-P$/, "") + "-P";
    return {
      id: player.id,
      name: displayName,
      email: null,
      hykbUid: null,
      avatar: player.sourceAvatar || null,
      badge: null,
      badges: [],
      badgeNames: {},
      language: "zh-CN",
      bio: "Local private score player",
      exp: 0,
      rks: 0,
      roles: 0,
      joined: player.joined,
      lastLogin: player.lastLogin,
    };
  }

  updatePlayerProfile(id: number, name: string, avatar: string | null): boolean {
    const player = this.data.players[String(id)];
    if (!player || !name.trim()) return false;
    if (player.sourceName === name && player.sourceAvatar === avatar) return true;
    player.sourceName = name.trim();
    player.sourceAvatar = avatar;
    this.save();
    return true;
  }

  upload(player: number, chart: number, summary: PrivateRecordSummary, payloadSha256?: string): Record<string, unknown> {
    if (payloadSha256) {
      const duplicate = this.data.records.find((record) => record.player === player && record.chart === chart && record.payloadSha256 === payloadSha256);
      if (duplicate) {
        return { id: duplicate.id, expDelta: 0, newBest: duplicate.best, improvement: 0, newRks: 0 };
      }
    }
    const previous = this.best(player, chart);
    const isBest = !previous || summary.score > previous.score || summary.accuracy > previous.accuracy;
    if (isBest) {
      for (const record of this.data.records) {
        if (record.player === player && record.chart === chart) record.best = false;
      }
    }
    const record: PrivateRecord = {
      ...summary,
      id: this.data.nextRecordId++,
      player,
      chart,
      best: isBest,
      bestStd: false,
      time: new Date().toISOString(),
      std: null,
      stdScore: null,
      ...(payloadSha256 ? { payloadSha256 } : {}),
    };
    this.data.records.push(record);
    this.save();
    return {
      id: record.id,
      expDelta: 0,
      newBest: isBest,
      improvement: previous ? Math.max(0, record.score - previous.score) : record.score,
      newRks: 0,
    };
  }

  best(player: number, chart: number): PrivateRecord | null {
    return this.data.records
      .filter((record) => record.player === player && record.chart === chart && record.best)
      .sort(compareRecords)[0] || null;
  }

  bestSummary(player: number, chart: number): Record<string, unknown> {
    const record = this.best(player, chart);
    return record
      ? { score: record.score, accuracy: record.accuracy, fullCombo: record.fullCombo }
      : { score: 0, accuracy: 0, fullCombo: false };
  }

  leaderboard(chart: number, std: boolean): Record<string, unknown>[] {
    const bestByPlayer = new Map<number, PrivateRecord>();
    for (const record of this.data.records) {
      if (record.chart !== chart || !record.best) continue;
      const old = bestByPlayer.get(record.player);
      if (!old || compareRecords(record, old) < 0) bestByPlayer.set(record.player, record);
    }
    return [...bestByPlayer.values()]
      .sort((left, right) => (std ? compareRecords(left, right) : compareRecords(left, right)))
      .slice(0, 15)
      .map((record, index) => this.toApiRecord(record, index + 1));
  }

  playerRecords(player: number): Record<string, unknown>[] {
    return this.data.records
      .filter((record) => record.player === player)
      .sort((left, right) => right.time.localeCompare(left.time))
      .slice(0, 100)
      .map((record) => this.toApiRecord(record));
  }

  adminRecords(filters: { chart?: number; player?: number } = {}): Record<string, unknown>[] {
    return this.data.records
      .filter((record) => filters.chart === undefined || record.chart === filters.chart)
      .filter((record) => filters.player === undefined || record.player === filters.player)
      .sort((left, right) => right.time.localeCompare(left.time))
      .map((record) => this.toApiRecord(record));
  }

  adminPlayers(): Record<string, unknown>[] {
    return Object.values(this.data.players)
      .sort((left, right) => left.id - right.id)
      .map((player) => ({ ...player }));
  }

  private ratingOwner(authorization: string | string[] | undefined): string {
    const value = Array.isArray(authorization) ? authorization.join(",") : authorization || "anonymous";
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  private ratingForOwner(owner: string, chart: number): number {
    const rating = this.data.ratings.find((item) => item.owner === owner && item.chart === chart);
    return rating?.score || 0;
  }

  ratingForAuthorization(authorization: string | string[] | undefined, chart: number): number {
    return this.ratingForOwner(this.ratingOwner(authorization), chart);
  }

  rateForAuthorization(authorization: string | string[] | undefined, chart: number, score: number): number {
    const owner = this.ratingOwner(authorization);
    const index = this.data.ratings.findIndex((item) => item.owner === owner && item.chart === chart);
    if (score === 0) {
      if (index >= 0) {
        this.data.ratings.splice(index, 1);
        this.save();
      }
      return 0;
    }
    const rating: PrivateRating = { owner, chart, score, time: new Date().toISOString() };
    if (index >= 0) this.data.ratings[index] = rating;
    else this.data.ratings.push(rating);
    this.save();
    return score;
  }

  ratingSummary(chart: number): { rating: number | null; ratingCount: number } {
    const ratings = this.data.ratings.filter((item) => item.chart === chart);
    if (ratings.length === 0) return { rating: null, ratingCount: 0 };
    const average = ratings.reduce((total, item) => total + item.score, 0) / ratings.length / 10;
    return { rating: Number(average.toFixed(6)), ratingCount: ratings.length };
  }

  adminUpload(player: number, chart: number, summary: PrivateRecordSummary): Record<string, unknown> {
    const result = this.upload(player, chart, summary) as { id: number };
    return this.adminRecords().find((record) => record.id === result.id) || result;
  }

  deleteRecord(id: number): boolean {
    const index = this.data.records.findIndex((record) => record.id === id);
    if (index < 0) return false;
    const removed = this.data.records[index];
    this.data.records.splice(index, 1);
    this.recalculateBest(removed.player, removed.chart);
    this.save();
    return true;
  }

  deleteChartRecords(chart: number): number {
    const before = this.data.records.length;
    this.data.records = this.data.records.filter((record) => record.chart !== chart);
    const removed = before - this.data.records.length;
    const ratingsBefore = this.data.ratings.length;
    this.data.ratings = this.data.ratings.filter((rating) => rating.chart !== chart);
    if (removed > 0 || ratingsBefore !== this.data.ratings.length) this.save();
    return removed;
  }

  private recalculateBest(player: number, chart: number): void {
    const records = this.data.records.filter((record) => record.player === player && record.chart === chart);
    for (const record of records) record.best = false;
    const best = records.sort(compareRecords)[0];
    if (best) best.best = true;
  }

  private toApiRecord(record: PrivateRecord, rank?: number): Record<string, unknown> {
    return {
      id: record.id,
      player: record.player,
      chart: record.chart,
      score: record.score,
      accuracy: record.accuracy,
      perfect: record.perfect,
      good: record.good,
      bad: record.bad,
      miss: record.miss,
      speed: record.speed,
      max_combo: record.maxCombo,
      full_combo: record.fullCombo,
      best: record.best,
      best_std: record.bestStd,
      mods: record.mods,
      time: record.time,
      std: record.std,
      std_score: record.stdScore,
      ...(rank === undefined ? {} : { rank }),
    };
  }
}
