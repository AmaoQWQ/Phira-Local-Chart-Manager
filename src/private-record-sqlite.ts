import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PRIVATE_UPLOADER_ID } from "./private-chart";
import type { PrivateRecordSummary } from "./private-record";

const PRIVATE_PLAYER_BASE = 2_000_000_000;
const PRIVATE_PLAYER_RANGE = 100_000_000;
const FIRST_RECORD_ID = 1_600_000_001;

interface PrivateRecord {
  id: number;
  player: number;
  chart: number;
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
  best: boolean;
  bestStd: boolean;
  time: string;
  std: number | null;
  stdScore: number | null;
  payloadSha256?: string;
}

type SqlRow = Record<string, unknown>;

function rowNumber(row: SqlRow, key: string, fallback = 0): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value) || fallback;
}

function rowString(row: SqlRow, key: string, fallback = ""): string {
  return typeof row[key] === "string" ? row[key] as string : fallback;
}

function rowToRecord(row: SqlRow): PrivateRecord {
  const payloadSha256 = rowString(row, "payload_sha256");
  return {
    id: rowNumber(row, "id"),
    player: rowNumber(row, "player"),
    chart: rowNumber(row, "chart"),
    score: rowNumber(row, "score"),
    accuracy: rowNumber(row, "accuracy"),
    fullCombo: rowNumber(row, "full_combo") !== 0,
    perfect: rowNumber(row, "perfect"),
    good: rowNumber(row, "good"),
    bad: rowNumber(row, "bad"),
    miss: rowNumber(row, "miss"),
    maxCombo: rowNumber(row, "max_combo"),
    speed: rowNumber(row, "speed", 1),
    mods: rowNumber(row, "mods"),
    best: rowNumber(row, "best") !== 0,
    bestStd: rowNumber(row, "best_std") !== 0,
    time: rowString(row, "time"),
    std: row[keyOrNull(row, "std")] as number | null,
    stdScore: row[keyOrNull(row, "std_score")] as number | null,
    ...(payloadSha256 ? { payloadSha256 } : {}),
  };
}

function keyOrNull(row: SqlRow, key: string): string {
  return key;
}

export class PrivateRecordSqliteStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(databasePath: string, legacyJsonPath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    // synchronous=NORMAL is the standard durability/throughput trade-off for WAL mode:
    // commits stop fsyncing on every write while a crash still cannot corrupt the file.
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        joined TEXT NOT NULL,
        last_login TEXT NOT NULL,
        source_name TEXT,
        source_avatar TEXT
      );
      CREATE TABLE IF NOT EXISTS auth_bindings (
        auth_key TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY,
        player INTEGER NOT NULL,
        chart INTEGER NOT NULL,
        score INTEGER NOT NULL,
        accuracy REAL NOT NULL,
        full_combo INTEGER NOT NULL,
        perfect INTEGER NOT NULL,
        good INTEGER NOT NULL,
        bad INTEGER NOT NULL,
        miss INTEGER NOT NULL,
        max_combo INTEGER NOT NULL,
        speed REAL NOT NULL,
        mods INTEGER NOT NULL,
        best INTEGER NOT NULL,
        best_std INTEGER NOT NULL,
        time TEXT NOT NULL,
        std REAL,
        std_score REAL,
        payload_sha256 TEXT
      );
      CREATE INDEX IF NOT EXISTS records_chart_best ON records(chart, best, score DESC, accuracy DESC);
      CREATE INDEX IF NOT EXISTS records_player_chart ON records(player, chart, best);
      CREATE UNIQUE INDEX IF NOT EXISTS records_upload_dedup ON records(player, chart, payload_sha256)
        WHERE payload_sha256 IS NOT NULL;
      CREATE TABLE IF NOT EXISTS ratings (
        owner TEXT NOT NULL,
        chart INTEGER NOT NULL,
        score INTEGER NOT NULL,
        time TEXT NOT NULL,
        PRIMARY KEY(owner, chart)
      );
      CREATE INDEX IF NOT EXISTS ratings_chart ON ratings(chart);
    `);
    this.migrateLegacyJson(legacyJsonPath);
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  /**
   * Reuses compiled statements. Every SQL string in this class is a fixed template
   * (filters only change bound parameters), so the cache stays a small bounded set and
   * read paths stop recompiling the same statement on every request.
   */
  private statement(sql: string): ReturnType<DatabaseSync["prepare"]> {
    let cached = this.statements.get(sql);
    if (cached === undefined) {
      cached = this.db.prepare(sql);
      this.statements.set(sql, cached);
    }
    return cached;
  }

  private meta(key: string): string | null {
    const row = this.statement("SELECT value FROM meta WHERE key = ?").get(key) as SqlRow | undefined;
    return row ? rowString(row, "value") : null;
  }

  private setMeta(key: string, value: string): void {
    this.statement("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private migrateLegacyJson(legacyJsonPath: string): void {
    if (this.meta("legacy_json_checked") !== null) return;
    const legacyExists = fs.existsSync(legacyJsonPath);
    if (legacyExists) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacyJsonPath, "utf8")) as Partial<{
          nextRecordId: number;
          players: Record<string, Record<string, unknown>>;
          authBindings: Record<string, number>;
          records: Record<string, unknown>[];
          ratings: Record<string, unknown>[];
        }>;
        this.db.exec("BEGIN IMMEDIATE");
        for (const player of Object.values(parsed.players || {})) {
          this.statement(`INSERT OR IGNORE INTO players(id, name, joined, last_login, source_name, source_avatar)
            VALUES(?, ?, ?, ?, ?, ?)`).run(
            Number(player.id), String(player.name || "Private Player"), String(player.joined || new Date().toISOString()),
            String(player.lastLogin || player.joined || new Date().toISOString()),
            typeof player.sourceName === "string" ? player.sourceName : null,
            typeof player.sourceAvatar === "string" ? player.sourceAvatar : null,
          );
        }
        for (const [authKey, userId] of Object.entries(parsed.authBindings || {})) {
          if (/^[a-f0-9]{64}$/i.test(authKey) && Number.isSafeInteger(Number(userId))) {
            this.statement("INSERT OR IGNORE INTO auth_bindings(auth_key, user_id) VALUES(?, ?)").run(authKey, Number(userId));
          }
        }
        for (const record of parsed.records || []) {
          this.statement(`INSERT OR IGNORE INTO records(
            id, player, chart, score, accuracy, full_combo, perfect, good, bad, miss, max_combo,
            speed, mods, best, best_std, time, std, std_score, payload_sha256
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            Number(record.id), Number(record.player), Number(record.chart), Number(record.score), Number(record.accuracy),
            record.fullCombo ? 1 : 0, Number(record.perfect || 0), Number(record.good || 0), Number(record.bad || 0),
            Number(record.miss || 0), Number(record.maxCombo || 0), Number(record.speed ?? 1), Number(record.mods || 0),
            record.best ? 1 : 0, record.bestStd ? 1 : 0, String(record.time || new Date().toISOString()),
            typeof record.std === "number" ? record.std : null, typeof record.stdScore === "number" ? record.stdScore : null,
            typeof record.payloadSha256 === "string" ? record.payloadSha256 : null,
          );
        }
        for (const rating of parsed.ratings || []) {
          if (typeof rating.owner !== "string") continue;
          this.statement("INSERT OR IGNORE INTO ratings(owner, chart, score, time) VALUES(?, ?, ?, ?)").run(
            rating.owner, Number(rating.chart), Number(rating.score), String(rating.time || new Date().toISOString()),
          );
        }
        const requestedNextId = Number(parsed.nextRecordId) || FIRST_RECORD_ID;
        const maxIdRow = this.statement("SELECT COALESCE(MAX(id), 0) AS max_id FROM records").get() as SqlRow;
        const nextId = Math.max(requestedNextId, rowNumber(maxIdRow, "max_id") + 1, FIRST_RECORD_ID);
        this.setMeta("next_record_id", String(nextId));
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* Keep the original migration error. */ }
        throw error;
      }
    }
    if (this.meta("next_record_id") === null) this.setMeta("next_record_id", String(FIRST_RECORD_ID));
    this.setMeta("legacy_json_checked", legacyExists ? legacyJsonPath : "none");
  }

  private authorizationKey(authorization: string | string[] | undefined): string {
    const value = Array.isArray(authorization) ? authorization.join(",") : authorization || "anonymous";
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  playerIdForAuthorization(authorization: string | string[] | undefined): number {
    const authKey = this.authorizationKey(authorization);
    const binding = this.statement("SELECT user_id FROM auth_bindings WHERE auth_key = ?").get(authKey) as SqlRow | undefined;
    const digest = Buffer.from(authKey, "hex");
    const boundId = binding ? rowNumber(binding, "user_id") : 0;
    const id = boundId > 0 ? boundId : PRIVATE_PLAYER_BASE + (digest.readUInt32BE(0) % PRIVATE_PLAYER_RANGE);
    const now = new Date().toISOString();
    const existing = this.statement("SELECT id, last_login FROM players WHERE id = ?").get(id) as SqlRow | undefined;
    if (existing) {
      // Profile and record reads must not take the write lock on every request, so the
      // last-seen timestamp is refreshed at most once a minute.
      const lastSeen = Date.parse(rowString(existing, "last_login"));
      if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > 60_000) {
        this.statement("UPDATE players SET last_login = ? WHERE id = ?").run(now, id);
      }
    } else {
      this.statement("INSERT INTO players(id, name, joined, last_login) VALUES(?, ?, ?, ?)").run(id, "Private Player", now, now);
    }
    return id;
  }

  bindAuthorizationToUser(authorization: string | string[] | undefined, userId: number): number | null {
    const value = Array.isArray(authorization) ? authorization.join(",") : authorization;
    if (!value || !Number.isSafeInteger(userId) || userId <= 0) return null;
    const authKey = this.authorizationKey(authorization);
    const existing = this.statement("SELECT user_id FROM auth_bindings WHERE auth_key = ?").get(authKey) as SqlRow | undefined;
    if (existing && rowNumber(existing, "user_id") !== userId) return null;
    this.statement("INSERT INTO auth_bindings(auth_key, user_id) VALUES(?, ?) ON CONFLICT(auth_key) DO UPDATE SET user_id = excluded.user_id").run(authKey, userId);
    const now = new Date().toISOString();
    if (this.statement("SELECT id FROM players WHERE id = ?").get(userId)) this.statement("UPDATE players SET last_login = ? WHERE id = ?").run(now, userId);
    else this.statement("INSERT INTO players(id, name, joined, last_login) VALUES(?, ?, ?, ?)").run(userId, "Private Player", now, now);
    return userId;
  }

  hasPlayer(id: number): boolean {
    return id !== PRIVATE_UPLOADER_ID && Boolean(this.statement("SELECT 1 FROM players WHERE id = ?").get(id));
  }

  userMetadata(id: number): Record<string, unknown> | null {
    const player = this.statement("SELECT * FROM players WHERE id = ?").get(id) as SqlRow | undefined;
    if (!player) return null;
    const sourceName = rowString(player, "source_name") || rowString(player, "name", "Private Player");
    const displayName = `${sourceName.replace(/-P$/, "")}-P`;
    return {
      id,
      name: displayName,
      email: null,
      hykbUid: null,
      avatar: rowString(player, "source_avatar") || null,
      badge: null,
      badges: [],
      badgeNames: {},
      language: "zh-CN",
      bio: "Local private score player",
      exp: 0,
      rks: 0,
      roles: 0,
      joined: rowString(player, "joined"),
      lastLogin: rowString(player, "last_login"),
    };
  }

  updatePlayerProfile(id: number, name: string, avatar: string | null): boolean {
    if (!name.trim() || !this.statement("SELECT id FROM players WHERE id = ?").get(id)) return false;
    this.statement("UPDATE players SET source_name = ?, source_avatar = ? WHERE id = ?").run(name.trim(), avatar, id);
    return true;
  }

  upload(player: number, chart: number, summary: PrivateRecordSummary, payloadSha256?: string): Record<string, unknown> {
    if (payloadSha256) {
      const duplicate = this.statement("SELECT id, best FROM records WHERE player = ? AND chart = ? AND payload_sha256 = ?").get(player, chart, payloadSha256) as SqlRow | undefined;
      if (duplicate) return { id: rowNumber(duplicate, "id"), expDelta: 0, newBest: rowNumber(duplicate, "best") !== 0, improvement: 0, newRks: 0 };
    }
    const previous = this.best(player, chart);
    const isBest = !previous || summary.score > previous.score || summary.accuracy > previous.accuracy;
    const time = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (isBest) this.statement("UPDATE records SET best = 0 WHERE player = ? AND chart = ?").run(player, chart);
      const nextId = rowNumber(this.statement("SELECT value FROM meta WHERE key = 'next_record_id'").get() as SqlRow, "value", FIRST_RECORD_ID);
      this.statement("UPDATE meta SET value = ? WHERE key = 'next_record_id'").run(String(nextId + 1));
      this.statement(`INSERT INTO records(
        id, player, chart, score, accuracy, full_combo, perfect, good, bad, miss, max_combo,
        speed, mods, best, best_std, time, std, std_score, payload_sha256
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        nextId, player, chart, summary.score, summary.accuracy, summary.fullCombo ? 1 : 0, summary.perfect,
        summary.good, summary.bad, summary.miss, summary.maxCombo, summary.speed, summary.mods, isBest ? 1 : 0,
        0, time, null, null, payloadSha256 || null,
      );
      this.db.exec("COMMIT");
      return { id: nextId, expDelta: 0, newBest: isBest, improvement: previous ? Math.max(0, summary.score - previous.score) : summary.score, newRks: 0 };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  best(player: number, chart: number): PrivateRecord | null {
    const row = this.statement("SELECT * FROM records WHERE player = ? AND chart = ? AND best = 1 ORDER BY score DESC, accuracy DESC, time ASC LIMIT 1").get(player, chart) as SqlRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  bestSummary(player: number, chart: number): Record<string, unknown> {
    const record = this.best(player, chart);
    return record ? { score: record.score, accuracy: record.accuracy, fullCombo: record.fullCombo } : { score: 0, accuracy: 0, fullCombo: false };
  }

  leaderboard(chart: number, _std: boolean): Record<string, unknown>[] {
    const rows = this.statement("SELECT * FROM records WHERE chart = ? AND best = 1 ORDER BY score DESC, accuracy DESC, time ASC LIMIT 15").all(chart) as SqlRow[];
    return rows.map((row, index) => this.toApiRecord(rowToRecord(row), index + 1));
  }

  playerRecords(player: number): Record<string, unknown>[] {
    const rows = this.statement("SELECT * FROM records WHERE player = ? ORDER BY time DESC LIMIT 100").all(player) as SqlRow[];
    return rows.map((row) => this.toApiRecord(rowToRecord(row)));
  }

  adminRecords(filters: { chart?: number; player?: number } = {}): Record<string, unknown>[] {
    const clauses = ["1 = 1"];
    const params: number[] = [];
    if (filters.chart !== undefined) { clauses.push("chart = ?"); params.push(filters.chart); }
    if (filters.player !== undefined) { clauses.push("player = ?"); params.push(filters.player); }
    const rows = this.statement(`SELECT * FROM records WHERE ${clauses.join(" AND ")} ORDER BY time DESC`).all(...params) as SqlRow[];
    return rows.map((row) => this.toApiRecord(rowToRecord(row)));
  }

  adminPlayers(): Record<string, unknown>[] {
    const rows = this.statement("SELECT id, name, joined, last_login AS lastLogin FROM players ORDER BY id").all() as SqlRow[];
    return rows.map((row) => ({ id: rowNumber(row, "id"), name: rowString(row, "name"), joined: rowString(row, "joined"), lastLogin: rowString(row, "lastLogin") }));
  }

  /** Shared WHERE fragment for the record list/count queries. */
  private recordFilter(filters: { chart?: number; player?: number }): { clause: string; params: number[] } {
    const clauses = ["1 = 1"];
    const params: number[] = [];
    if (filters.chart !== undefined) { clauses.push("chart = ?"); params.push(filters.chart); }
    if (filters.player !== undefined) { clauses.push("player = ?"); params.push(filters.player); }
    return { clause: clauses.join(" AND "), params };
  }

  /** Number of matching rows, counted by SQLite instead of materialising them. */
  countRecords(filters: { chart?: number; player?: number } = {}): number {
    const { clause, params } = this.recordFilter(filters);
    const row = this.statement(`SELECT COUNT(*) AS count FROM records WHERE ${clause}`).get(...params) as SqlRow;
    return rowNumber(row, "count");
  }

  /**
   * Highest record id in the table. Insert ids increase monotonically, so the value
   * captured before a request identifies everything that request created.
   */
  maxRecordId(): number {
    const row = this.statement("SELECT COALESCE(MAX(id), 0) AS max_id FROM records").get() as SqlRow;
    return rowNumber(row, "max_id");
  }

  /** A bounded page of records, newest first, for audit snapshots and listings. */
  recentRecords(filters: { chart?: number; player?: number } = {}, limit = 500): Record<string, unknown>[] {
    const { clause, params } = this.recordFilter(filters);
    const rows = this.statement(`SELECT * FROM records WHERE ${clause} ORDER BY time DESC LIMIT ?`).all(...params, limit) as SqlRow[];
    return rows.map((row) => this.toApiRecord(rowToRecord(row)));
  }

  /** Records created after the given id, newest first, bounded by limit. */
  recordsAfter(id: number, limit = 500): Record<string, unknown>[] {
    const rows = this.statement("SELECT * FROM records WHERE id > ? ORDER BY time DESC LIMIT ?").all(id, limit) as SqlRow[];
    return rows.map((row) => this.toApiRecord(rowToRecord(row)));
  }

  recordById(id: number): Record<string, unknown> | null {
    const row = this.statement("SELECT * FROM records WHERE id = ?").get(id) as SqlRow | undefined;
    return row ? this.toApiRecord(rowToRecord(row)) : null;
  }

  adminUpload(player: number, chart: number, summary: PrivateRecordSummary): Record<string, unknown> {
    const result = this.upload(player, chart, summary) as { id: number };
    return this.recordById(result.id) || result;
  }

  deleteRecord(id: number): boolean {
    const row = this.statement("SELECT player, chart FROM records WHERE id = ?").get(id) as SqlRow | undefined;
    if (!row) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.statement("DELETE FROM records WHERE id = ?").run(id);
      this.recalculateBest(rowNumber(row, "player"), rowNumber(row, "chart"));
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  deleteChartRecords(chart: number): number {
    const count = rowNumber(this.statement("SELECT COUNT(*) AS count FROM records WHERE chart = ?").get(chart) as SqlRow, "count");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.statement("DELETE FROM records WHERE chart = ?").run(chart);
      this.statement("DELETE FROM ratings WHERE chart = ?").run(chart);
      this.db.exec("COMMIT");
      return count;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  private recalculateBest(player: number, chart: number): void {
    this.statement("UPDATE records SET best = 0 WHERE player = ? AND chart = ?").run(player, chart);
    const row = this.statement("SELECT id FROM records WHERE player = ? AND chart = ? ORDER BY score DESC, accuracy DESC, time ASC LIMIT 1").get(player, chart) as SqlRow | undefined;
    if (row) this.statement("UPDATE records SET best = 1 WHERE id = ?").run(rowNumber(row, "id"));
  }

  private ratingOwner(authorization: string | string[] | undefined): string {
    return this.authorizationKey(authorization);
  }

  ratingForAuthorization(authorization: string | string[] | undefined, chart: number): number {
    const row = this.statement("SELECT score FROM ratings WHERE owner = ? AND chart = ?").get(this.ratingOwner(authorization), chart) as SqlRow | undefined;
    return row ? rowNumber(row, "score") : 0;
  }

  rateForAuthorization(authorization: string | string[] | undefined, chart: number, score: number): number {
    const owner = this.ratingOwner(authorization);
    if (score === 0) this.statement("DELETE FROM ratings WHERE owner = ? AND chart = ?").run(owner, chart);
    else this.statement("INSERT INTO ratings(owner, chart, score, time) VALUES(?, ?, ?, ?) ON CONFLICT(owner, chart) DO UPDATE SET score = excluded.score, time = excluded.time").run(owner, chart, score, new Date().toISOString());
    return score;
  }

  ratingSummary(chart: number): { rating: number | null; ratingCount: number } {
    const row = this.statement("SELECT AVG(score) AS average, COUNT(*) AS count FROM ratings WHERE chart = ?").get(chart) as SqlRow;
    const count = rowNumber(row, "count");
    return count === 0 ? { rating: null, ratingCount: 0 } : { rating: Number((rowNumber(row, "average") / 10).toFixed(6)), ratingCount: count };
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
