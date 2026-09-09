import net from "node:net";
import {
  getPrivateChartById,
  isPrivateChartId,
  PRIVATE_CHART_ID,
  PrivateChartStore,
} from "./private-chart";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_ROOM_ID_BYTES = 20;
const MAX_TOKEN_BYTES = 32;
const MAX_PLAYERS = 2;
const MAX_JUDGES_PER_FRAME = 4096;

type JudgeEvent = {
  time: number;
  lineId: number;
  noteId: number;
  judgement: number;
};

type ScoreSummary = {
  score: number;
  accuracy: number;
  fullCombo: boolean;
};

type JudgeStats = {
  events: Map<string, JudgeEvent>;
};

type User = { id: number; name: string; monitor: boolean };
type RoomState =
  | { type: "SelectChart"; id: number | null }
  | { type: "WaitingForReady" }
  | { type: "Playing" };
type Room = {
  id: string;
  hostId: number;
  users: Map<number, MultiplayerSession>;
  chart: { id: number; name: string } | null;
  state: RoomState;
  ready: Set<number>;
  locked: boolean;
  cycle: boolean;
  judgeStats: Map<number, JudgeStats>;
};

type UserResolver = (token: string) => Promise<User>;
type ChartResolver = (id: number) => Promise<{ id: number; name: string }>;

class Reader {
  private offset: number;
  constructor(private readonly buffer: Buffer, offset = 0) {
    this.offset = offset;
  }

  private ensure(size: number): void {
    if (this.offset + size > this.buffer.length) throw new Error("truncated-packet");
  }

  u8(): number {
    this.ensure(1);
    return this.buffer[this.offset++];
  }

  bool(): boolean {
    return this.u8() === 1;
  }

  i32(): number {
    this.ensure(4);
    const value = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  u32(): number {
    this.ensure(4);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  f32(): number {
    this.ensure(4);
    const value = this.buffer.readFloatLE(this.offset);
    this.offset += 4;
    return value;
  }

  uleb(): number {
    let value = 0;
    let multiplier = 1;
    for (let i = 0; i < 5; i++) {
      const byte = this.u8();
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return value;
      multiplier *= 128;
    }
    throw new Error("invalid-uleb");
  }

  string(maxBytes?: number): string {
    const length = this.uleb();
    if (maxBytes !== undefined && length > maxBytes) throw new Error("string-too-long");
    this.ensure(length);
    const value = this.buffer.subarray(this.offset, this.offset + length).toString("utf8");
    this.offset += length;
    return value;
  }

  remaining(): Buffer {
    return this.buffer.subarray(this.offset);
  }
}

class Writer {
  private readonly chunks: Buffer[] = [];

  u8(value: number): this {
    this.chunks.push(Buffer.from([value & 0xff]));
    return this;
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  i32(value: number): this {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeInt32LE(value | 0, 0);
    this.chunks.push(buffer);
    return this;
  }

  f32(value: number): this {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeFloatLE(value, 0);
    this.chunks.push(buffer);
    return this;
  }

  uleb(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid-uleb-value");
    const bytes: number[] = [];
    let current = value;
    do {
      let byte = current % 128;
      current = Math.floor(current / 128);
      if (current > 0) byte |= 0x80;
      bytes.push(byte);
    } while (current > 0);
    this.chunks.push(Buffer.from(bytes));
    return this;
  }

  string(value: string, maxBytes?: number): this {
    const bytes = Buffer.from(value, "utf8");
    if (maxBytes !== undefined && bytes.length > maxBytes) throw new Error("string-too-long");
    this.uleb(bytes.length);
    this.chunks.push(bytes);
    return this;
  }

  raw(value: Buffer): this {
    this.chunks.push(value);
    return this;
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function frame(body: Buffer): Buffer {
  const writer = new Writer();
  writer.uleb(body.length).raw(body);
  return writer.build();
}

function encodeUser(writer: Writer, user: User): void {
  writer.i32(user.id).string(user.name).bool(user.monitor);
}

function encodeRoomState(writer: Writer, state: RoomState): void {
  if (state.type === "SelectChart") {
    writer.u8(0).bool(state.id !== null);
    if (state.id !== null) writer.i32(state.id);
  } else if (state.type === "WaitingForReady") {
    writer.u8(1);
  } else {
    writer.u8(2);
  }
}

function encodeRoomForUser(writer: Writer, session: MultiplayerSession, room: Room): void {
  writer.string(room.id);
  encodeRoomState(writer, room.state);
  writer.bool(false).bool(room.locked).bool(room.cycle);
  writer.bool(room.hostId === session.user!.id);
  writer.bool(room.ready.has(session.user!.id));
  const users = [...room.users.values()].sort((a, b) => a.user!.id - b.user!.id);
  writer.uleb(users.length);
  for (const member of users) encodeUser(writer, member.user!);
}

function resultOk(writer: Writer): void {
  writer.bool(true);
}

function resultError(writer: Writer, message: string): void {
  writer.bool(false).string(message.slice(0, 200));
}

function encodeUnitReply(tag: number, error?: string): Buffer {
  const writer = new Writer().u8(tag);
  if (error) resultError(writer, error);
  else resultOk(writer);
  return writer.build();
}

function encodeMessage(message: {
  type: string;
  user?: number;
  content?: string;
  name?: string;
  id?: number;
  score?: number;
  accuracy?: number;
  fullCombo?: boolean;
}): Buffer {
  const writer = new Writer();
  switch (message.type) {
    case "Chat": writer.u8(0).i32(message.user!).string(message.content!); break;
    case "CreateRoom": writer.u8(1).i32(message.user!); break;
    case "JoinRoom": writer.u8(2).i32(message.user!).string(message.name!); break;
    case "LeaveRoom": writer.u8(3).i32(message.user!).string(message.name!); break;
    case "NewHost": writer.u8(4).i32(message.user!); break;
    case "SelectChart": writer.u8(5).i32(message.user!).string(message.name!).i32(message.id!); break;
    case "GameStart": writer.u8(6).i32(message.user!); break;
    case "Ready": writer.u8(7).i32(message.user!); break;
    case "CancelReady": writer.u8(8).i32(message.user!); break;
    case "CancelGame": writer.u8(9).i32(message.user!); break;
    case "StartPlaying": writer.u8(10); break;
    case "Played": writer.u8(11).i32(message.user!).i32(message.score!).f32(message.accuracy!).bool(message.fullCombo!); break;
    case "GameEnd": writer.u8(12); break;
    case "Abort": writer.u8(13).i32(message.user!); break;
    case "LockRoom": writer.u8(14).bool(Boolean(message.id)); break;
    case "CycleRoom": writer.u8(15).bool(Boolean(message.id)); break;
    default: throw new Error("unsupported-room-message");
  }
  return new Writer().u8(5).raw(writer.build()).build();
}

function serverReply(tag: number, error?: string): Buffer {
  return encodeUnitReply(tag, error);
}

function parseRoomId(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > MAX_ROOM_ID_BYTES || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid-room-id");
  }
  return value;
}

function parseJudgeEvents(payload: Buffer): JudgeEvent[] {
  const reader = new Reader(payload);
  const count = reader.uleb();
  if (count > MAX_JUDGES_PER_FRAME) throw new Error("too-many-judges");
  const events: JudgeEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push({
      time: reader.f32(),
      lineId: reader.u32(),
      noteId: reader.u32(),
      judgement: reader.u8(),
    });
  }
  if (reader.remaining().length !== 0) throw new Error("trailing-judge-data");
  return events;
}

function judgementCategory(judgement: number): 0 | 1 | 2 | 3 | null {
  if (judgement === 0 || judgement === 4) return 0;
  if (judgement === 1 || judgement === 5) return 1;
  if (judgement === 2) return 2;
  if (judgement === 3) return 3;
  return null;
}

function calculateScore(stats: JudgeStats | undefined): ScoreSummary {
  if (!stats || stats.events.size === 0) {
    return { score: 0, accuracy: 0, fullCombo: false };
  }

  const events = [...stats.events.values()].sort((a, b) => a.time - b.time);
  const counts = [0, 0, 0, 0];
  let combo = 0;
  let maxCombo = 0;
  for (const event of events) {
    const category = judgementCategory(event.judgement);
    if (category === null) continue;
    counts[category]++;
    if (category < 2) {
      combo++;
      maxCombo = Math.max(maxCombo, combo);
    } else {
      combo = 0;
    }
  }

  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return { score: 0, accuracy: 0, fullCombo: false };
  const accuracy = (counts[0] + counts[1] * 0.65) / total;
  const score = counts[0] === total
    ? 1_000_000
    : Math.round((0.9 * accuracy + 0.1 * (maxCombo / total)) * 1_000_000);
  return {
    score,
    accuracy,
    fullCombo: counts[2] === 0 && counts[3] === 0,
  };
}

export type MultiplayerOptions = {
  host: string;
  port: number;
  upstreamBaseUrl: string;
  privateChartBaseUrl: string;
  privateChartStore?: PrivateChartStore;
  resolveUser?: UserResolver;
};

export class MultiplayerServer {
  private readonly server = net.createServer((socket) => this.accept(socket));
  private readonly rooms = new Map<string, Room>();
  private readonly sessions = new Set<MultiplayerSession>();
  private readonly users = new Map<number, MultiplayerSession>();
  private readonly resolveUser: UserResolver;
  private readonly resolveChart: ChartResolver;

  constructor(private readonly options: MultiplayerOptions) {
    this.resolveUser = options.resolveUser || (async (token) => {
      const response = await fetch(`${options.upstreamBaseUrl.replace(/\/+$/, "")}/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("authentication-failed");
      const value = (await response.json()) as Record<string, unknown>;
      if (!Number.isSafeInteger(value.id) || typeof value.name !== "string" || !value.name.trim()) {
        throw new Error("invalid-user-response");
      }
      return { id: value.id as number, name: value.name.trim(), monitor: false };
    });
    this.resolveChart = async (id) => {
      if (isPrivateChartId(id)) {
        const chart = getPrivateChartById(id, options.privateChartBaseUrl, options.privateChartStore);
        if (!chart || typeof chart.name !== "string") throw new Error("private-chart-not-found");
        return { id, name: chart.name };
      }
      const response = await fetch(`${options.upstreamBaseUrl.replace(/\/+$/, "")}/chart/${id}`);
      if (!response.ok) throw new Error("chart-not-found");
      const value = (await response.json()) as Record<string, unknown>;
      if (!Number.isSafeInteger(value.id) || typeof value.name !== "string") throw new Error("invalid-chart-response");
      return { id: value.id as number, name: value.name };
    };
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.port, this.options.host);
    });
  }

  close(): Promise<void> {
    for (const session of this.sessions) session.close();
    return new Promise((resolve) => {
      if (!this.server.listening) resolve();
      else this.server.close(() => resolve());
    });
  }

  address(): net.AddressInfo {
    return this.server.address() as net.AddressInfo;
  }

  private accept(socket: net.Socket): void {
    const session = new MultiplayerSession(this, socket);
    this.sessions.add(session);
    socket.once("close", () => {
      this.sessions.delete(session);
      this.removeFromRoom(session);
    });
  }

  async authenticate(session: MultiplayerSession, token: string): Promise<void> {
    if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) throw new Error("auth-invalid-token");
    const user = await this.resolveUser(token);
    const old = this.users.get(user.id);
    if (old && old !== session) old.close();
    session.user = user;
    this.users.set(user.id, session);
    const writer = new Writer().u8(1).bool(true);
    encodeUser(writer, user);
    const room = session.room;
    writer.bool(Boolean(room));
    if (room) encodeRoomForUser(writer, session, room);
    session.send(writer.build());
  }

  async command(session: MultiplayerSession, payload: Buffer): Promise<void> {
    const reader = new Reader(payload);
    const tag = reader.u8();
    if (tag === 0) {
      session.send(Buffer.from([0]));
      return;
    }
    if (!session.user) {
      if (tag === 1) {
        await this.authenticate(session, reader.string(MAX_TOKEN_BYTES));
        return;
      }
      throw new Error("not-authenticated");
    }

    switch (tag) {
      case 1:
        throw new Error("auth-repeated-authenticate");
      case 2:
        await this.chat(session, reader.string(200));
        return;
      case 3:
      case 4:
        if (session.room?.state.type === "Playing") {
          const payload = reader.remaining();
          if (tag === 4) {
            try {
              this.recordJudges(session, parseJudgeEvents(payload));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              process.stdout.write(`[multiplayer] judges ignored room=${session.room.id} reason=${message}\n`);
            }
          }
          this.broadcastRawGameplay(session, tag, payload);
        }
        return;
      case 5:
        this.createRoom(session, parseRoomId(reader.string(MAX_ROOM_ID_BYTES)));
        return;
      case 6:
        this.joinRoom(session, parseRoomId(reader.string(MAX_ROOM_ID_BYTES)), reader.bool());
        return;
      case 7:
        this.leaveRoom(session);
        return;
      case 8:
        this.setLock(session, reader.bool());
        return;
      case 9:
        this.setCycle(session, reader.bool());
        return;
      case 10:
        await this.selectChart(session, reader.i32());
        return;
      case 11:
        this.requestStart(session);
        return;
      case 12:
        this.ready(session);
        return;
      case 13:
        this.cancelReady(session);
        return;
      case 14:
        this.played(session, reader.i32());
        return;
      case 15:
        this.abort(session);
        return;
      default:
        throw new Error("unsupported-client-command");
    }
  }

  private requireRoom(session: MultiplayerSession): Room {
    if (!session.room) throw new Error("room-no-room");
    return session.room;
  }

  private broadcast(room: Room, body: Buffer): void {
    for (const member of room.users.values()) member.send(body);
  }

  private broadcastToOne(session: MultiplayerSession, body: Buffer): void {
    session.send(body);
  }

  private createRoom(session: MultiplayerSession, id: string): void {
    if (session.room) throw new Error("room-already-in-room");
    if (this.rooms.has(id)) throw new Error("room-already-exists");
    const room: Room = {
      id,
      hostId: session.user!.id,
      users: new Map([[session.user!.id, session]]),
      chart: null,
      state: { type: "SelectChart", id: null },
      ready: new Set(),
      locked: false,
      cycle: false,
      judgeStats: new Map(),
    };
    this.rooms.set(id, room);
    session.room = room;
    session.send(serverReply(8));
    this.broadcast(room, encodeMessage({ type: "CreateRoom", user: session.user!.id }));
    process.stdout.write(`[multiplayer] room create ${id} user=${session.user!.id}\n`);
  }

  private joinRoom(session: MultiplayerSession, id: string, monitor: boolean): void {
    if (session.room) throw new Error("room-already-in-room");
    if (monitor) throw new Error("monitors-disabled");
    const room = this.rooms.get(id);
    if (!room) throw new Error("room-not-found");
    if (room.users.size >= MAX_PLAYERS) throw new Error("room-full");
    if (room.state.type !== "SelectChart") throw new Error("join-game-ongoing");
    room.users.set(session.user!.id, session);
    session.room = room;
    const writer = new Writer().u8(9).bool(true);
    encodeRoomState(writer, room.state);
    writer.uleb(room.users.size);
    for (const member of room.users.values()) encodeUser(writer, member.user!);
    writer.bool(false);
    session.send(writer.build());
    const joinInfo = new Writer().u8(10);
    encodeUser(joinInfo, session.user!);
    this.broadcast(room, joinInfo.build());
    this.broadcast(room, encodeMessage({ type: "JoinRoom", user: session.user!.id, name: session.user!.name }));
    if (room.cycle) this.broadcastToOne(session, encodeMessage({ type: "CycleRoom", id: 1 }));
    if (room.locked) this.broadcastToOne(session, encodeMessage({ type: "LockRoom", id: 1 }));
    process.stdout.write(`[multiplayer] room join ${id} user=${session.user!.id}\n`);
  }

  private async selectChart(session: MultiplayerSession, id: number): Promise<void> {
    const room = this.requireRoom(session);
    if (room.hostId !== session.user!.id) throw new Error("room-not-host");
    if (room.state.type !== "SelectChart") throw new Error("room-invalid-state");
    const chart = await this.resolveChart(id);
    room.chart = chart;
    // The original client updates its selected-chart context from ChangeState;
    // the Message.SelectChart entry is only the visible room log/notification.
    room.state = { type: "SelectChart", id: chart.id };
    room.ready.clear();
    this.broadcast(room, encodeMessage({ type: "SelectChart", user: session.user!.id, name: chart.name, id: chart.id }));
    this.broadcast(room, this.changeState(room.state));
    session.send(serverReply(14));
    process.stdout.write(`[multiplayer] private chart selected room=${room.id} chart=${id === PRIVATE_CHART_ID ? id : "official"}\n`);
  }

  private requestStart(session: MultiplayerSession): void {
    const room = this.requireRoom(session);
    if (room.hostId !== session.user!.id) throw new Error("room-not-host");
    if (!room.chart) throw new Error("start-no-chart-selected");
    if (room.state.type !== "SelectChart") throw new Error("room-invalid-state");
    room.ready = new Set([session.user!.id]);
    room.state = { type: "WaitingForReady" };
    this.broadcast(room, encodeMessage({ type: "GameStart", user: session.user!.id }));
    this.broadcast(room, this.changeState(room.state));
    session.send(serverReply(15));
    process.stdout.write(`[multiplayer] ready-check room=${room.id}\n`);
    this.startIfAllReady(room);
  }

  private ready(session: MultiplayerSession): void {
    const room = this.requireRoom(session);
    if (room.state.type === "Playing") throw new Error("room-invalid-state");
    if (room.state.type === "WaitingForReady") {
      room.ready.add(session.user!.id);
      this.broadcast(room, encodeMessage({ type: "Ready", user: session.user!.id }));
      process.stdout.write(`[multiplayer] player ready room=${room.id} user=${session.user!.id}\n`);
      this.startIfAllReady(room);
    }
    session.send(serverReply(16));
  }

  private startIfAllReady(room: Room): void {
    if (room.state.type !== "WaitingForReady" || room.users.size !== MAX_PLAYERS) return;
    if (![...room.users.keys()].every((id) => room.ready.has(id))) return;
    this.broadcast(room, encodeMessage({ type: "StartPlaying" }));
    room.judgeStats = new Map([...room.users.keys()].map((id) => [id, { events: new Map() }]));
    room.state = { type: "Playing" };
    this.broadcast(room, this.changeState(room.state));
    process.stdout.write(`[multiplayer] start broadcast room=${room.id} chart=${room.chart?.id ?? "none"}\n`);
  }

  private cancelReady(session: MultiplayerSession): void {
    const room = this.requireRoom(session);
    if (room.state.type !== "WaitingForReady") throw new Error("room-invalid-state");
    room.ready.delete(session.user!.id);
    this.broadcast(room, encodeMessage({ type: "CancelReady", user: session.user!.id }));
    session.send(serverReply(17));
  }

  private leaveRoom(session: MultiplayerSession): void {
    const room = this.requireRoom(session);
    session.send(serverReply(11));
    this.removeFromRoom(session);
  }

  private setLock(session: MultiplayerSession, locked: boolean): void {
    const room = this.requireRoom(session);
    if (room.hostId !== session.user!.id) throw new Error("room-not-host");
    room.locked = locked;
    this.broadcast(room, encodeMessage({ type: "LockRoom", id: locked ? 1 : 0 }));
    session.send(serverReply(12));
  }

  private setCycle(session: MultiplayerSession, cycle: boolean): void {
    const room = this.requireRoom(session);
    if (room.hostId !== session.user!.id) throw new Error("room-not-host");
    room.cycle = cycle;
    this.broadcast(room, encodeMessage({ type: "CycleRoom", id: cycle ? 1 : 0 }));
    session.send(serverReply(13));
  }

  private played(session: MultiplayerSession, recordId: number): void {
    const room = this.requireRoom(session);
    if (room.state.type !== "Playing") {
      session.send(serverReply(18, "room-invalid-state"));
      return;
    }
    void recordId;
    const summary = calculateScore(room.judgeStats.get(session.user!.id));
    this.broadcast(room, encodeMessage({
      type: "Played",
      user: session.user!.id,
      score: summary.score,
      accuracy: summary.accuracy,
      fullCombo: summary.fullCombo,
    }));
    process.stdout.write(`[multiplayer] played room=${room.id} user=${session.user!.id} score=${summary.score} accuracy=${summary.accuracy.toFixed(6)} fc=${summary.fullCombo}\n`);
    session.send(serverReply(18));
  }

  private recordJudges(session: MultiplayerSession, events: JudgeEvent[]): void {
    const room = session.room;
    if (!room || !session.user) return;
    let stats = room.judgeStats.get(session.user.id);
    if (!stats) {
      stats = { events: new Map() };
      room.judgeStats.set(session.user.id, stats);
    }
    for (const event of events) {
      const category = judgementCategory(event.judgement);
      if (category === null) continue;
      stats.events.set(`${event.lineId}:${event.noteId}`, event);
    }
  }

  private abort(session: MultiplayerSession): void {
    const room = this.requireRoom(session);
    if (room.state.type === "Playing") this.broadcast(room, encodeMessage({ type: "Abort", user: session.user!.id }));
    session.send(serverReply(19));
  }

  private async chat(session: MultiplayerSession, content: string): Promise<void> {
    const room = this.requireRoom(session);
    this.broadcast(room, encodeMessage({ type: "Chat", user: session.user!.id, content }));
    session.send(serverReply(2));
  }

  private changeState(state: RoomState): Buffer {
    return new Writer().u8(6).raw((() => { const w = new Writer(); encodeRoomState(w, state); return w.build(); })()).build();
  }

  private broadcastRawGameplay(session: MultiplayerSession, tag: number, payload: Buffer): void {
    const writer = new Writer().u8(tag).i32(session.user!.id).raw(payload);
    const body = writer.build();
    this.broadcast(session.room!, body);
  }

  removeFromRoom(session: MultiplayerSession): void {
    if (session.user && this.users.get(session.user.id) === session) this.users.delete(session.user.id);
    const room = session.room;
    if (!room) return;
    session.room = null;
    room.users.delete(session.user!.id);
    room.ready.delete(session.user!.id);
    if (room.users.size === 0) {
      this.rooms.delete(room.id);
      process.stdout.write(`[multiplayer] room destroy ${room.id}\n`);
      return;
    }
    this.broadcast(room, encodeMessage({ type: "LeaveRoom", user: session.user!.id, name: session.user!.name }));
    if (room.state.type !== "SelectChart") {
      room.state = { type: "SelectChart", id: room.chart?.id ?? null };
      room.ready.clear();
      room.judgeStats.clear();
      this.broadcast(room, this.changeState(room.state));
    }
    if (room.hostId === session.user!.id) {
      const next = room.users.keys().next().value as number;
      room.hostId = next;
      this.broadcast(room, encodeMessage({ type: "NewHost", user: next }));
      const nextSession = room.users.get(next);
      nextSession?.send(new Writer().u8(7).bool(true).build());
    }
  }
}

class MultiplayerSession {
  user: User | null = null;
  room: Room | null = null;
  private buffer = Buffer.alloc(0);
  private handshake = false;
  private closed = false;
  private queue = Promise.resolve();

  constructor(private readonly server: MultiplayerServer, private readonly socket: net.Socket) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60_000);
    socket.on("data", (chunk) => this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on("error", () => this.close());
  }

  send(body: Buffer): void {
    if (this.closed) return;
    this.socket.write(frame(body));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshake) {
      if (this.buffer.length < 1) return;
      const version = this.buffer[0];
      this.buffer = this.buffer.subarray(1);
      if (version !== PROTOCOL_VERSION) {
        this.close();
        return;
      }
      this.handshake = true;
    }
    while (true) {
      const parsed = this.readFrame();
      if (!parsed) return;
      this.queue = this.queue.then(() => this.server.command(this, parsed)).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`[multiplayer] command rejected ${message}\n`);
        this.close();
      });
    }
  }

  private readFrame(): Buffer | null {
    if (this.buffer.length === 0) return null;
    let length = 0;
    let multiplier = 1;
    let offset = 0;
    for (let i = 0; i < 5; i++) {
      if (offset >= this.buffer.length) return null;
      const byte = this.buffer[offset++];
      length += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) {
        if (length > MAX_FRAME_BYTES) {
          this.close();
          return null;
        }
        if (this.buffer.length - offset < length) return null;
        const payload = this.buffer.subarray(offset, offset + length);
        this.buffer = this.buffer.subarray(offset + length);
        return payload;
      }
      multiplier *= 128;
    }
    this.close();
    return null;
  }
}
