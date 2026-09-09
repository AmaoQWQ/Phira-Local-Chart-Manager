const net = require("node:net");
const assert = require("node:assert/strict");
const { MultiplayerServer } = require("../dist/multiplayer");

function uleb(value) {
  const out = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return Buffer.from(out);
}

function string(value) {
  const body = Buffer.from(value, "utf8");
  return Buffer.concat([uleb(body.length), body]);
}

function packet(body) {
  return Buffer.concat([uleb(body.length), body]);
}

function judges(events) {
  const body = [Buffer.from([4]), uleb(events.length)];
  for (const event of events) {
    const encoded = Buffer.alloc(13);
    encoded.writeFloatLE(event.time, 0);
    encoded.writeUInt32LE(event.lineId, 4);
    encoded.writeUInt32LE(event.noteId, 8);
    encoded[12] = event.judgement;
    body.push(encoded);
  }
  return Buffer.concat(body);
}

function playedMessage(frame, user, score, accuracy, fullCombo) {
  return frame[0] === 5
    && frame[1] === 11
    && frame.readInt32LE(2) === user
    && frame.readInt32LE(6) === score
    && Math.abs(frame.readFloatLE(10) - accuracy) < 0.00001
    && frame[14] === (fullCombo ? 1 : 0);
}

class TestClient {
  constructor(port) {
    this.socket = net.createConnection({ host: "127.0.0.1", port });
    this.buffer = Buffer.alloc(0);
    this.frames = [];
    this.waiters = [];
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("data", (chunk) => this.onData(chunk));
  }

  async connect() {
    await this.ready;
    this.socket.write(Buffer.from([1]));
  }

  send(body) {
    this.socket.write(packet(body));
  }

  async waitFor(predicate, timeout = 3000) {
    for (let i = 0; i < this.frames.length; i++) {
      if (predicate(this.frames[i])) return this.frames.splice(i, 1)[0];
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error("multiplayer test timeout"));
      }, timeout);
      const waiter = (frame) => {
        if (!predicate(frame)) return false;
        clearTimeout(timer);
        resolve(frame);
        return true;
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    this.socket.destroy();
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      let length = 0;
      let multiplier = 1;
      let offset = 0;
      let complete = false;
      for (let i = 0; i < 5 && offset < this.buffer.length; i++) {
        const byte = this.buffer[offset++];
        length += (byte & 0x7f) * multiplier;
        if (!(byte & 0x80)) {
          complete = true;
          break;
        }
        multiplier *= 128;
      }
      if (!complete || this.buffer.length - offset < length) return;
      const frame = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      let delivered = false;
      for (let i = 0; i < this.waiters.length; i++) {
        if (this.waiters[i](frame)) {
          this.waiters.splice(i, 1);
          delivered = true;
          break;
        }
      }
      if (!delivered) this.frames.push(frame);
    }
  }
}

function messageIs(frame, messageTag, chartId) {
  if (frame[0] !== 5 || frame[1] !== messageTag) return false;
  if (messageTag !== 5) return true;
  let offset = 2;
  offset += 4;
  let length = 0;
  let multiplier = 1;
  while (frame[offset] & 0x80) {
    length += (frame[offset] & 0x7f) * multiplier;
    multiplier *= 128;
    offset++;
  }
  length += frame[offset++] * multiplier;
  offset += length;
  return frame.readInt32LE(offset) === chartId;
}

function selectedStateIs(frame, chartId) {
  return frame[0] === 6 && frame[1] === 0 && frame[2] === 1 && frame.readInt32LE(3) === chartId;
}

async function main() {
  const users = new Map([
    ["player-a", { id: 101, name: "Player A", monitor: false }],
    ["player-b", { id: 102, name: "Player B", monitor: false }],
  ]);
  const server = new MultiplayerServer({
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: "http://127.0.0.1:9", // Any accidental official request fails the test.
    privateChartBaseUrl: "https://gateway.test",
    resolveUser: async (token) => users.get(token) || (() => { throw new Error("unknown-user"); })(),
  });
  await server.listen();
  const port = server.address().port;
  const a = new TestClient(port);
  const b = new TestClient(port);
  try {
    await Promise.all([a.connect(), b.connect()]);
    a.send(Buffer.concat([Buffer.from([1]), string("player-a")]));
    b.send(Buffer.concat([Buffer.from([1]), string("player-b")]));
    await Promise.all([a.waitFor((f) => f[0] === 1 && f[1] === 1), b.waitFor((f) => f[0] === 1 && f[1] === 1)]);

    a.send(Buffer.concat([Buffer.from([5]), string("ROOM1")]));
    await a.waitFor((f) => f[0] === 8 && f[1] === 1);
    b.send(Buffer.concat([Buffer.from([6]), string("ROOM1"), Buffer.from([0])]));
    await b.waitFor((f) => f[0] === 9 && f[1] === 1);

    const select = Buffer.alloc(5);
    select[0] = 10;
    select.writeInt32LE(1500000001, 1);
    a.send(select);
    await a.waitFor((f) => f[0] === 14 && f[1] === 1);
    await b.waitFor((f) => messageIs(f, 5, 1500000001));
    await Promise.all([
      a.waitFor((f) => selectedStateIs(f, 1500000001)),
      b.waitFor((f) => selectedStateIs(f, 1500000001)),
    ]);

    a.send(Buffer.from([11]));
    await a.waitFor((f) => f[0] === 15 && f[1] === 1);
    b.send(Buffer.from([12]));
    await b.waitFor((f) => f[0] === 16 && f[1] === 1);
    await Promise.all([
      a.waitFor((f) => messageIs(f, 10)),
      b.waitFor((f) => messageIs(f, 10)),
    ]);

    a.send(judges([
      { time: 1, lineId: 0, noteId: 0, judgement: 0 },
      { time: 2, lineId: 0, noteId: 1, judgement: 1 },
      { time: 3, lineId: 0, noteId: 2, judgement: 2 },
      { time: 4, lineId: 0, noteId: 3, judgement: 3 },
    ]));
    b.send(judges([
      { time: 1, lineId: 0, noteId: 0, judgement: 0 },
      { time: 2, lineId: 0, noteId: 1, judgement: 0 },
      { time: 3, lineId: 0, noteId: 2, judgement: 1 },
      { time: 4, lineId: 0, noteId: 3, judgement: 2 },
    ]));

    a.send(Buffer.from([14, 0, 0, 0, 0]));
    const [aPlayed, bSawAPlayed] = await Promise.all([
      a.waitFor((f) => playedMessage(f, 101, 421250, 0.4125, false)),
      b.waitFor((f) => playedMessage(f, 101, 421250, 0.4125, false)),
    ]);
    assert.equal(aPlayed[14], 0);
    assert.equal(bSawAPlayed[14], 0);

    b.send(Buffer.from([14, 0, 0, 0, 0]));
    await Promise.all([
      a.waitFor((f) => playedMessage(f, 102, 671250, 0.6625, false)),
      b.waitFor((f) => playedMessage(f, 102, 671250, 0.6625, false)),
    ]);
    process.stdout.write("multiplayer test passed: private chart room relays judges and broadcasts calculated scores\n");
  } finally {
    a.close();
    b.close();
    await server.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
