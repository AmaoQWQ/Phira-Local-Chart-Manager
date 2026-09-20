/**
 * Read-only room monitoring for a Phira-mp+ (PMP) instance.
 *
 * PMP exposes no plain HTTP room listing: its HTTP surface is `GET /api/events` (SSE),
 * `/api/ws`, plugin-registered routes and `/health/*`, while the documented snapshot
 * command `room.list` lives in OpenUDS — which is `#[cfg(unix)]` and therefore absent on
 * Windows. So the gateway combines two sources:
 *
 *   - a **snapshot** from a plugin-registered HTTP route (`PMP_ROOMS_SNAPSHOT_PATH`,
 *     default `/api/rooms/info`, the path used in PMP's own plugin guide),
 *   - **incremental events** from `/api/events`.
 *
 * Either source may be missing in practice, so the connection state is reported instead of
 * assumed: a snapshot may 404 (no plugin yet), events may never arrive (wrong port), and a
 * reconnect silently loses whatever happened in between — which is exactly why a
 * successful (re)connect triggers a fresh snapshot. Whatever we cannot know is surfaced as
 * `status()`, never papered over.
 */

export interface MonitorRoom {
  id: string;
  uuid: string | null;
  hostId: number | null;
  chartId: number | null;
  chartName: string | null;
  state: string | null;
  playerCount: number | null;
  maxUsers: number | null;
  locked: boolean | null;
  hidden: boolean | null;
  /** Players seen through join/leave events; PMP only reports totals in snapshots. */
  players: number[];
  lastScore: { userId: number; score: number; chartId: number | null; at: string } | null;
  updatedAt: string;
}

export type SnapshotState = "unknown" | "ok" | "unavailable";

export interface MonitorStatus {
  enabled: boolean;
  connected: boolean;
  snapshot: SnapshotState;
  lastEventAt: string | null;
  lastSnapshotAt: string | null;
  lastError: string | null;
  reconnects: number;
  eventCount: number;
  roomCount: number;
  /** Recent raw frames, kept so an unexpected PMP payload can be diagnosed from the UI. */
  sample: string[];
}

export interface MonitorRoomsOptions {
  /** PMP HTTP base, e.g. `http://127.0.0.1:12347`. */
  baseUrl: string;
  /** Plugin route that returns the room list, if one is installed. */
  snapshotPath?: string;
  /** Event stream path: PMP's own `/api/events`, or the plugin's filtered `/api/rooms/listen`. */
  eventsPath?: string;
  /** Optional bearer token for the snapshot route. */
  token?: string | null;
  enabled?: boolean;
}

export interface MonitorRoomEvent {
  type: string;
  data: Record<string, unknown>;
}

const DEFAULT_SNAPSHOT_PATH = "/api/rooms";
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const SNAPSHOT_INTERVAL_MS = 60_000;
const SAMPLE_LIMIT = 5;

/** Accepts both the documented snake_case and the camelCase spellings plugins may use. */
function pick(source: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (source[name] !== undefined && source[name] !== null) return source[name];
  }
  return undefined;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** PMP reports players as ids in some payloads and as objects in others. */
function asPlayerIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids: number[] = [];
  for (const entry of value) {
    const id = typeof entry === "number" ? entry : asNumber((entry as Record<string, unknown>)?.id ?? (entry as Record<string, unknown>)?.user_id);
    if (id !== null && Number.isSafeInteger(id)) ids.push(id);
  }
  return ids;
}

/** `host` is an id in the v2 shape and an object in the gooophira-compatible one. */
function asHostId(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (value && typeof value === "object") return asNumber((value as Record<string, unknown>).id);
  return null;
}

/** `chart` is either an id or `{id, name}`. */
function asChart(value: unknown): { id: number | null; name: string | null } {
  if (typeof value === "number") return { id: Number.isSafeInteger(value) ? value : null, name: null };
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return { id: asNumber(pick(source, "id", "chart_id", "chartId")), name: asString(pick(source, "name", "chart_name", "chartName")) };
  }
  return { id: null, name: null };
}

/** The two snapshot shapes name states differently (`SELECTING_CHART`, `select_chart`). */
function normalizeState(value: string | null): string | null {
  return value ? value.trim().toLowerCase() : null;
}

/** v2 snapshots embed finished rounds; the last record is the freshest score. */
function lastScoreFrom(body: Record<string, unknown>): MonitorRoom["lastScore"] {
  const rounds = body.rounds;
  if (!Array.isArray(rounds) || rounds.length === 0) return null;
  const round = rounds[rounds.length - 1] as Record<string, unknown> | null;
  const records = round?.records;
  if (!Array.isArray(records) || records.length === 0) return null;
  const record = records[records.length - 1] as Record<string, unknown>;
  const userId = asNumber(pick(record, "player", "user_id", "userId"));
  const score = asNumber(pick(record, "score"));
  if (userId === null || score === null) return null;
  return { userId, score, chartId: asNumber(pick(round ?? {}, "chart", "chart_id", "chartId")), at: new Date().toISOString() };
}

export class PmpRoomMonitor {
  private readonly baseUrl: string;
  private readonly snapshotPath: string;
  private readonly eventsPath: string;
  private readonly token: string | null;
  private readonly enabled: boolean;
  private readonly rooms = new Map<string, MonitorRoom>();
  private readonly sample: string[] = [];
  private controller: AbortController | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private connected = false;
  private snapshot: SnapshotState = "unknown";
  private lastEventAt: string | null = null;
  private lastSnapshotAt: string | null = null;
  private lastError: string | null = null;
  private reconnects = 0;
  private eventCount = 0;
  private readonly eventListeners = new Set<(event: MonitorRoomEvent) => void>();

  constructor(options: MonitorRoomsOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.snapshotPath = options.snapshotPath && options.snapshotPath.startsWith("/") ? options.snapshotPath : DEFAULT_SNAPSHOT_PATH;
    this.eventsPath = options.eventsPath && options.eventsPath.startsWith("/") ? options.eventsPath : "/api/events";
    this.token = options.token || null;
    this.enabled = options.enabled !== false && this.baseUrl !== "";
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** Starts consuming events. Safe to call repeatedly; a stopped monitor restarts. */
  start(): void {
    if (!this.enabled || !this.stopped) return;
    this.stopped = false;
    void this.refreshSnapshot();
    void this.consume();
    this.snapshotTimer = setInterval(() => { void this.refreshSnapshot(); }, SNAPSHOT_INTERVAL_MS);
    this.snapshotTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.controller = null;
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.snapshotTimer = null;
    this.reconnectTimer = null;
    this.connected = false;
  }

  list(): MonitorRoom[] {
    return [...this.rooms.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(roomId: string): MonitorRoom | null {
    return this.rooms.get(roomId) ?? null;
  }

  /** Subscribe to already-parsed PMP events without opening another SSE connection. */
  onEvent(listener: (event: MonitorRoomEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  status(): MonitorStatus {
    return {
      enabled: this.enabled,
      connected: this.connected,
      snapshot: this.snapshot,
      lastEventAt: this.lastEventAt,
      lastSnapshotAt: this.lastSnapshotAt,
      lastError: this.lastError,
      reconnects: this.reconnects,
      eventCount: this.eventCount,
      roomCount: this.rooms.size,
      sample: [...this.sample],
    };
  }

  /**
   * Fetches the room list from the plugin route. A missing route is a normal state (no
   * plugin installed yet) and is reported as such rather than retried aggressively.
   */
  async refreshSnapshot(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const response = await fetch(`${this.baseUrl}${this.snapshotPath}`, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 404 || response.status === 501) {
        this.snapshot = "unavailable";
        this.lastError = `房间快照路由不存在（${this.snapshotPath}）：PMP 尚未安装提供该路由的插件`;
        return false;
      }
      if (!response.ok) {
        this.snapshot = "unavailable";
        this.lastError = `房间快照请求失败：HTTP ${response.status}`;
        return false;
      }
      const payload: unknown = await response.json();
      this.applySnapshot(payload);
      this.snapshot = "ok";
      this.lastSnapshotAt = new Date().toISOString();
      this.lastError = null;
      return true;
    } catch (error) {
      this.snapshot = "unavailable";
      this.lastError = `房间快照不可用：${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  /**
   * Accepts both shapes the plugin serves: the gooophira-compatible `{rooms: [...]}` and the
   * v2 array, where each entry wraps its fields in `data` and carries the room id as `name`.
   */
  private applySnapshot(payload: unknown): void {
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const list = Array.isArray(payload) ? payload : Array.isArray(record.rooms) ? record.rooms as unknown[] : null;
    if (!list) {
      this.recordSample(`snapshot:${JSON.stringify(payload).slice(0, 400)}`);
      return;
    }
    const seen = new Set<string>();
    const now = new Date().toISOString();
    for (const entry of list) {
      const room = this.parseSnapshotRoom(entry, now);
      if (!room) continue;
      const previous = this.rooms.get(room.id);
      seen.add(room.id);
      this.rooms.set(room.id, {
        ...room,
        players: room.players.length ? room.players : previous?.players ?? [],
        lastScore: room.lastScore ?? previous?.lastScore ?? null,
      });
    }
    // The snapshot is authoritative for the rooms it covers.
    for (const id of [...this.rooms.keys()]) {
      if (!seen.has(id)) this.rooms.delete(id);
    }
  }

  /** Normalises one snapshot entry, whichever of the two documented shapes it uses. */
  private parseSnapshotRoom(entry: unknown, now: string): MonitorRoom | null {
    if (!entry || typeof entry !== "object") return null;
    const source = entry as Record<string, unknown>;
    const data = source.data && typeof source.data === "object" ? source.data as Record<string, unknown> : null;
    const body = data ?? source;
    const id = asString(pick(source, "room_id", "roomId", "roomid", "id")) ?? (data ? asString(pick(source, "name")) : null);
    if (!id) return null;
    const chart = asChart(pick(body, "chart", "chart_id", "chartId"));
    const chartInfo = asChart(pick(body, "chart_info", "chartInfo"));
    const players = asPlayerIds(pick(body, "players", "users", "user_ids", "userIds"));
    return {
      id,
      uuid: asString(pick(body, "uuid")) ?? null,
      hostId: asHostId(pick(body, "host", "host_id", "hostId")),
      chartId: chart.id ?? chartInfo.id,
      // PMP+ v2 commonly returns `chart` as a bare id and puts the title in
      // sibling `chart_name` / `chart_info` fields. Treat an absent title as
      // missing metadata, never as an absent selection.
      chartName: chart.name ?? asString(pick(body, "chart_name", "chartName")) ?? chartInfo.name,
      state: normalizeState(asString(pick(body, "state", "status"))),
      playerCount: players.length || asNumber(pick(body, "player_count", "playerCount")),
      maxUsers: asNumber(pick(body, "max_users", "maxUsers")),
      locked: asBoolean(pick(body, "locked", "lock", "is_locked", "isLocked")),
      hidden: asBoolean(pick(body, "hidden", "is_hidden", "isHidden")),
      players,
      lastScore: lastScoreFrom(body),
      updatedAt: now,
    };
  }

  /** Opens the SSE stream and keeps it open, reconnecting with a bounded backoff. */
  private async consume(): Promise<void> {
    let backoff = RECONNECT_MIN_MS;
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        const response = await fetch(`${this.baseUrl}${this.eventsPath}`, {
          headers: { Accept: "text/event-stream", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
          signal: this.controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`事件流返回 HTTP ${response.status}`);
        }
        this.connected = true;
        this.lastError = null;
        backoff = RECONNECT_MIN_MS;
        // A reconnect may have missed events, so re-read the authoritative list.
        void this.refreshSnapshot();
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          if (this.stopped) break;
          buffer += decoder.decode(chunk, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            this.handleFrame(frame);
            boundary = buffer.indexOf("\n\n");
          }
        }
        throw new Error("事件流已关闭");
      } catch (error) {
        this.connected = false;
        if (this.stopped) return;
        this.lastError = `事件流中断：${error instanceof Error ? error.message : String(error)}`;
        this.reconnects += 1;
        const wait = backoff;
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
        await new Promise<void>((resolve) => {
          this.reconnectTimer = setTimeout(resolve, wait);
          this.reconnectTimer.unref?.();
        });
      }
    }
  }

  /**
   * Parses one SSE frame. PMP documents an `event:` name plus a JSON `data:` payload, and
   * the payload itself may carry a `type`; both spellings of the room events are accepted
   * because the plugin stream uses underscored names while OpenUDS documents dotted ones.
   */
  private handleFrame(frame: string): void {
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.recordSample(`unparsed:${raw.slice(0, 400)}`);
      return;
    }
    const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const type = asString(pick(body, "type", "event", "event_type", "eventType")) || eventName || "unknown";
    // Some events nest their fields under `data` while keeping the room id on the envelope,
    // so both levels are merged (the nested one wins).
    const nested = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
    const data = { ...body, ...nested };
    this.eventCount += 1;
    this.lastEventAt = new Date().toISOString();
    for (const listener of this.eventListeners) {
      try { listener({ type, data }); } catch (error) { this.recordSample(`listener:${error instanceof Error ? error.message : String(error)}`); }
    }
    this.applyEvent(type, data);
  }

  private applyEvent(type: string, data: Record<string, unknown>): void {
    if (type === "ready" || type === "heartbeat" || type === "server.heartbeat") return;
    const roomId = asString(pick(data, "room_id", "roomId", "room"));
    if (!roomId) {
      this.recordSample(`${type}:${JSON.stringify(data).slice(0, 300)}`);
      return;
    }
    const previous = this.rooms.get(roomId) ?? {
      id: roomId, uuid: null, hostId: null, chartId: null, chartName: null, state: null,
      playerCount: null, maxUsers: null, locked: null, hidden: null, players: [], lastScore: null,
      updatedAt: new Date().toISOString(),
    };
    const next: MonitorRoom = { ...previous, updatedAt: new Date().toISOString() };

    switch (type) {
      case "room.created": case "create_room": {
        // `data` carries the room's own fields (possibly nested under `data`).
        const body = (data.data && typeof data.data === "object" ? data.data : data) as Record<string, unknown>;
        next.uuid = asString(pick(data, "uuid")) ?? asString(pick(body, "uuid")) ?? next.uuid;
        next.hostId = asNumber(pick(body, "host_id", "hostId")) ?? next.hostId;
        next.chartId = asNumber(pick(body, "chart_id", "chartId")) ?? next.chartId;
        next.chartName = asString(pick(body, "chart_name", "chartName", "name")) ?? next.chartName;
        next.state = asString(pick(body, "state", "status")) ?? next.state;
        next.maxUsers = asNumber(pick(body, "max_users", "maxUsers")) ?? next.maxUsers;
        next.playerCount = asNumber(pick(body, "player_count", "playerCount")) ?? next.playerCount;
        break;
      }
      case "room.updated": case "update_room": {
        const changes = (data.changes && typeof data.changes === "object" ? data.changes : data) as Record<string, unknown>;
        next.uuid = asString(pick(changes, "uuid")) ?? next.uuid;
        next.hostId = asNumber(pick(changes, "host_id", "hostId")) ?? next.hostId;
        next.chartId = asNumber(pick(changes, "chart_id", "chartId")) ?? next.chartId;
        next.chartName = asString(pick(changes, "chart_name", "chartName", "name")) ?? next.chartName;
        next.state = asString(pick(changes, "state", "status")) ?? next.state;
        next.maxUsers = asNumber(pick(changes, "max_users", "maxUsers")) ?? next.maxUsers;
        next.playerCount = asNumber(pick(changes, "player_count", "playerCount")) ?? next.playerCount;
        next.locked = asBoolean(pick(changes, "locked", "is_locked", "isLocked")) ?? next.locked;
        next.hidden = asBoolean(pick(changes, "hidden", "is_hidden", "isHidden")) ?? next.hidden;
        break;
      }
      case "room.joined": case "join_room": {
        const userId = asNumber(pick(data, "user_id", "userId"));
        if (userId !== null && !next.players.includes(userId)) next.players = [...next.players, userId];
        next.playerCount = next.players.length || (next.playerCount ?? 0) + 1;
        break;
      }
      case "room.left": case "leave_room": {
        const userId = asNumber(pick(data, "user_id", "userId"));
        if (userId !== null) next.players = next.players.filter((id) => id !== userId);
        next.playerCount = next.players.length || Math.max(0, (next.playerCount ?? 1) - 1);
        break;
      }
      case "round.scored": case "player_score": case "new_round": {
        const userId = asNumber(pick(data, "user_id", "userId", "player"));
        const score = asNumber(pick(data, "score"));
        const chartId = asNumber(pick(data, "chart_id", "chartId", "chart"));
        if (userId !== null && score !== null) {
          next.lastScore = { userId, score, chartId, at: new Date().toISOString() };
        }
        if (chartId !== null) next.chartId = chartId;
        next.state = asString(pick(data, "state", "status")) ?? next.state;
        break;
      }
      case "start_round": {
        const chartId = asNumber(pick(data, "chart_id", "chartId", "chart"));
        if (chartId !== null) next.chartId = chartId;
        next.state = "playing";
        break;
      }
      case "round.completed": {
        next.state = "completed";
        break;
      }
      default:
        this.recordSample(`${type}:${JSON.stringify(data).slice(0, 300)}`);
        return;
    }
    this.rooms.set(roomId, next);
  }

  private recordSample(entry: string): void {
    this.sample.unshift(entry);
    if (this.sample.length > SAMPLE_LIMIT) this.sample.length = SAMPLE_LIMIT;
  }
}
