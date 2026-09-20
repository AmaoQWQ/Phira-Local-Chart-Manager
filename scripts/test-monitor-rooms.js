// End-to-end check of the read-only room list. A fake PMP serves the two snapshot shapes
// the HSNPhira v2 plugin actually returns plus the /api/events stream, and the real gateway
// must combine them, attribute each room to the instance owning its chart, and enforce the
// visibility rule.
//
//   node scripts/test-monitor-rooms.js
//
// The fixture payloads below are copied from the documented shapes, not invented:
//   /api/rooms       {rooms:[{roomid, host:{id,name}, chart:{id,name}|null, players:[{id,name}], lock, state}], total}
//   /api/rooms/info  [{name, data:{host:int, users:[int], chart:int|null, lock, state, rounds:[{chart, records:[…]}]}}]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(root, 'data', 'test-rooms-'));
const bootstrap = randomUUID();
let child;
let pmp;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Fake PMP: whichever snapshot shape the test sets, plus the SSE stream. */
function startFakePmp(port, snapshot) {
  const clients = new Set();
  const state = { snapshot, available: true, managed: new Map(), announcements: [] };
  const server = http.createServer((request, response) => {
    const url = (request.url || '').split('?')[0];
    if (url.startsWith('/admin/rooms')) {
      if (request.headers['x-admin-token'] !== bootstrap) {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end('{"ok":false,"message":"管理员令牌无效"}');
        return;
      }
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (url === '/admin/rooms' && request.method === 'GET') return send(200, { ok: true, total_rooms: state.managed.size, rooms: [...state.managed.values()] });
        if (url === '/admin/rooms/hosted' && request.method === 'POST') {
          const existing = state.managed.get(body.roomId);
          if (existing) return send(200, { ...existing, created: false });
          const room = { ok: true, hosted: true, roomid: body.roomId, owner_id: body.ownerId, capacity: body.maxUsers, allowed_user_ids: body.allowedUserIds, host_id: body.hostId, chart: body.chart, chart_mode: body.chartMode, chart_pool: body.chartPool || [], state: 'SelectChart', users: [], monitors: [] };
          state.managed.set(body.roomId, room); return send(201, { ...room, created: true });
        }
        if (url === '/admin/rooms/precreate' && request.method === 'POST') {
          const room = { ok: true, hosted: false, roomid: body.roomId, owner_id: body.ownerId, capacity: body.allowedUserIds.length, allowed_user_ids: body.allowedUserIds, host_id: null, chart: body.chart, chart_mode: 'HOST_SELECT', chart_pool: [], state: 'SelectChart', users: [], monitors: [] };
          state.managed.set(body.roomId, room); return send(201, { ...room, created: true });
        }
        const match = /^\/admin\/rooms\/([A-Za-z0-9_-]+)\/(hosted|disband|chat|chart_pool)$/.exec(url);
        if (!match) return send(404, { ok: false, message: '不存在' });
        const room = state.managed.get(match[1]);
        if (!room) return send(404, { ok: false, message: '未找到房间' });
        if (match[2] === 'hosted' && request.method === 'GET') return send(200, room);
        if (match[2] === 'hosted' && request.method === 'PATCH') {
          if (body.maxUsers !== undefined) room.capacity = body.maxUsers;
          if (body.allowedUserIds !== undefined) room.allowed_user_ids = body.allowedUserIds;
          if (body.hostId !== undefined) room.host_id = body.hostId;
          if (body.chart !== undefined) room.chart = body.chart;
          if (body.chartMode !== undefined) room.chart_mode = body.chartMode;
          if (body.chartPool !== undefined) room.chart_pool = body.chartPool;
          return send(200, room);
        }
        if (match[2] === 'chat' && request.method === 'POST') { state.announcements.push([match[1], body.message]); return send(200, { ok: true }); }
        if (match[2] === 'disband' && request.method === 'POST') { state.managed.delete(match[1]); return send(200, { ok: true, roomid: match[1] }); }
        return send(405, { ok: false, message: '方法不支持' });
      });
      return;
    }
    if ((request.url || '').startsWith('/api/rooms')) {
      if (!state.available) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end('{"error":"no such plugin route"}');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(state.snapshot));
      return;
    }
    if ((request.url || '').startsWith('/api/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      response.write('event: ready\ndata: {"type":"ready"}\n\n');
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    server,
    emit(type, data) {
      // The plugin translates through sse:translate and forwards the server's snake_case
      // event name with the payload fields next to it.
      for (const client of clients) client.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    },
    setSnapshot(next) { state.snapshot = next; },
    setSnapshotAvailable(value) { state.available = value; },
    close() { for (const client of clients) client.end(); server.close(); },
  })));
}

function raw(port, route, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const request = https.request({
      hostname: '127.0.0.1', port, path: route, method, rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Admin-Request': '1', ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch { /* non-JSON */ }
        resolve({ status: response.statusCode, data, headers: response.headers, text });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

const COMPATIBLE_SNAPSHOT = {
  rooms: [
    { roomid: 'ROOM-SNAPSHOT', host: { id: 5, name: 'Host A' }, chart: { id: -101, name: 'Fixture Chart' }, players: [{ id: 11, name: 'A' }, { id: 12, name: 'B' }], lock: false, cycle: 1, state: 'playing' },
    { roomid: 'ROOM-FOREIGN', host: { id: 9, name: 'Host B' }, chart: { id: -999, name: 'Not ours' }, players: [{ id: 13, name: 'C' }], lock: true, cycle: 1, state: 'select_chart' },
  ],
  total: 3,
};

const V2_SNAPSHOT = [
  {
    name: 'ROOM-V2',
    data: {
      host: 7, users: [21, 22], lock: false, cycle: 2, chart: -999,
      state: 'WAITING_FOR_READY', playing_users: [],
      rounds: [{ chart: -999, records: [{ id: 1, player: 21, score: 880000, perfect: 800, good: 5, bad: 0, miss: 1, max_combo: 400, accuracy: 0.98, full_combo: false }] }],
    },
  },
];

async function main() {
  const publicPort = await freePort();
  const adminPort = await freePort();
  const pmpPort = await freePort();
  pmp = await startFakePmp(pmpPort, COMPATIBLE_SNAPSHOT);

  const env = {
    ...process.env,
    HOST: '127.0.0.1', PORT: String(publicPort), ADMIN_PORT: String(adminPort),
    MULTIPLAYER_ENABLED: 'false', ADMIN_TOKEN: bootstrap,
    INSTANCE_REGISTRY_PATH: path.join(testRoot, 'instances.json'),
    PRIVATE_CHARTS_PATH: path.join(testRoot, 'charts'),
    PRIVATE_RECORDS_DB_PATH: path.join(testRoot, 'records.sqlite'),
    PRIVATE_RECORDS_PATH: path.join(testRoot, 'records.json'),
    PRIVATE_TOKEN_CAPTURE_PATH: '', LOG_TO_FILE: 'false', DEBUG_BODY: 'false',
    UPSTREAM_BASE_URL: 'https://127.0.0.1:1',
    PMP_MONITOR_ENABLED: 'true',
    PMP_BASE_URL: `http://127.0.0.1:${pmpPort}`,
    PMP_ROOMS_SNAPSHOT_PATH: '/api/rooms',
    PMP_EVENTS_PATH: '/api/events',
    PMP_ADMIN_TOKEN: bootstrap,
  };
  child = spawn(process.execPath, [path.join(root, 'dist', 'index.js')], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  try {
    for (let i = 0; ; i++) {
      try { if ((await raw(publicPort, '/health')).status === 200) break; } catch { /* not up yet */ }
      if (i > 60) throw new Error('gateway did not start');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const json = (route, options) => raw(publicPort, route, options);
    // Every admin write needs an operation reason; harmless on reads.
    const mutation = { 'X-Admin-Reason': 'Room monitor fixture setup', 'X-Admin-Confirm': 'delete' };
    const setup = await json('/api/admin/auth/setup', { method: 'POST', body: { username: 'rooms-admin', password: randomUUID(), adminToken: bootstrap } });
    assert.equal(setup.status, 201, 'admin setup');
    const adminCookie = { Cookie: setup.headers['set-cookie'][0].split(';')[0] };
    // Writes need the operation reason and the session's CSRF token.
    const api = (route, options = {}) => raw(publicPort, '/api/admin/' + route, { ...options, headers: { ...adminCookie, 'X-CSRF-Token': setup.data.csrf, ...mutation, ...options.headers } });

    // 1. The compatible snapshot shape is parsed, rooms included.
    let view = await api('monitor/rooms');
    assert.equal(view.status, 200, 'rooms list');
    assert.equal(view.data.unrestricted, true, 'super administrator is unrestricted');
    assert.equal(view.data.status.snapshot, 'ok', 'snapshot route reachable');
    assert.equal(view.data.status.connected, true, 'event stream connected');
    const snapshotRoom = view.data.rooms.find((room) => room.id === 'ROOM-SNAPSHOT');
    assert.ok(snapshotRoom, `compatible snapshot must be parsed, got ${view.data.rooms.map((r) => r.id)}`);
    assert.equal(snapshotRoom.hostId, 5, 'host object -> id');
    assert.equal(snapshotRoom.chartId, -101, 'chart object -> id');
    assert.equal(snapshotRoom.chartName, 'Fixture Chart', 'chart object -> name');
    assert.equal(snapshotRoom.state, 'playing', 'state preserved');
    assert.equal(snapshotRoom.playerCount, 2, 'players counted');
    assert.equal(snapshotRoom.locked, false, 'lock mapped');
    const foreign = view.data.rooms.find((room) => room.id === 'ROOM-FOREIGN');
    assert.equal(foreign.locked, true, 'lock true mapped');
    assert.equal(foreign.playerCount, 1, 'single player counted');
    console.log(`compatible snapshot: ${view.data.rooms.map((room) => room.id).join(', ')}`);

    // Native PMP+ room management is proxied without exposing its token to the browser.
    let managed = await api('rooms/hosted', { method: 'POST', body: { roomId: 'WEB-HOSTED', allowedUserIds: [1001, 1002], maxUsers: 4, hostId: 1001, chart: { id: -101, name: 'Fixture Chart' }, chartMode: 'HOST_SELECT', chartPool: [] } });
    assert.equal(managed.status, 201, `create managed room: ${JSON.stringify(managed.data)}`);
    assert.equal(managed.data.owner_id, setup.data.user.id, 'gateway stamps the authenticated website owner');
    assert.equal(managed.data.chart.id, -101, 'private negative chart id reaches PMP');
    managed = await api('rooms');
    assert.equal(managed.status, 200, 'managed room list');
    assert.equal(managed.data.rooms[0].roomid, 'WEB-HOSTED');
    assert.equal(managed.data.rooms[0].instanceId, null, 'unowned chart is not attributed yet');
    assert.equal((await api('rooms/WEB-HOSTED/hosted', { method: 'PATCH', body: { maxUsers: 6, allowedUserIds: [1001, 1002], hostId: 1001, chart: null, chartMode: 'HOST_SELECT', chartPool: [] } })).data.capacity, 6, 'managed room update');
    assert.equal((await api('rooms/WEB-HOSTED/chat', { method: 'POST', body: { message: '网页公告' } })).status, 200, 'managed room announcement');
    console.log('managed rooms: create/list/update/chat proxy passed');

    // 2. Live events (the plugin's snake_case names) create and mutate a room.
    pmp.emit('create_room', { room_id: 'ROOM-LIVE', uuid: 'u-3', data: { host_id: 7, chart_id: -999, chart_name: 'Live', state: 'waiting', max_users: 4, player_count: 0 } });
    pmp.emit('join_room', { room_id: 'ROOM-LIVE', user_id: 42 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    view = await api('monitor/rooms');
    const live = view.data.rooms.find((room) => room.id === 'ROOM-LIVE');
    assert.ok(live, 'a room created by an event must appear');
    assert.deepEqual(live.players, [42], 'joined player recorded');
    pmp.emit('player_score', { room_id: 'ROOM-LIVE', user_id: 42, score: 900000, chart_id: -999 });
    pmp.emit('leave_room', { room_id: 'ROOM-LIVE', user_id: 42, reason: 'quit' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    view = await api('monitor/rooms');
    const after = view.data.rooms.find((room) => room.id === 'ROOM-LIVE');
    assert.equal(after.playerCount, 0, 'leave must be counted');
    assert.equal(after.lastScore.score, 900000, 'player_score recorded');
    assert.ok(view.data.status.eventCount >= 4, 'events counted');
    console.log('events: create_room/join_room/player_score/leave_room applied');

    // 3. The v2 snapshot shape is parsed too, and it is authoritative for its rooms.
    pmp.setSnapshot(V2_SNAPSHOT);
    view = await api('monitor/rooms?refresh=1');
    assert.equal(view.data.status.snapshot, 'ok', 'v2 snapshot accepted');
    const v2 = view.data.rooms.find((room) => room.id === 'ROOM-V2');
    assert.ok(v2, `v2 shape must be parsed, got ${view.data.rooms.map((r) => r.id)}`);
    assert.equal(v2.hostId, 7, 'v2 host is a bare id');
    assert.equal(v2.chartId, -999, 'v2 chart is a bare id');
    assert.equal(v2.state, 'waiting_for_ready', 'v2 state lower-cased');
    assert.equal(v2.playerCount, 2, 'v2 users counted');
    assert.equal(v2.lastScore.score, 880000, 'v2 round record surface as the last score');
    assert.equal(view.data.rooms.filter((room) => room.id === 'ROOM-LIVE').length, 0, 'a snapshot replaces the room set');
    console.log(`v2 snapshot: ${view.data.rooms.map((room) => room.id).join(', ')} (authoritative)`);

    // 4. Visibility: super administrator sees everything, a collaborator only their room.
    const created = await api('instances', { method: 'POST', body: { id: 'room-a', name: 'Room A' } });
    assert.equal(created.status, 201, `create instance: ${JSON.stringify(created.data)}`);
    assert.equal((await api('charts?instance=room-a', { method: 'POST', body: { id: -101, name: 'Fixture Chart', packageBase64: Buffer.from('SYNTHETIC').toString('base64') } })).status, 201, 'upload chart');
    // Restore the room that owns that chart, and confirm attribution.
    pmp.setSnapshot(COMPATIBLE_SNAPSHOT);
    view = await api('monitor/rooms?refresh=1');
    assert.equal(view.data.rooms.find((room) => room.id === 'ROOM-SNAPSHOT').instanceId, 'room-a', 'room attributed to the owning instance');
    assert.equal(view.data.rooms.find((room) => room.id === 'ROOM-FOREIGN').instanceId, null, 'unattributed room');

    const password = randomUUID();
    const registration = await json('/api/admin/auth/register', {
      method: 'POST',
      body: { username: 'rooms-collaborator', password, application: { reason: 'Collaborator for the room fixture.', useType: 'personal', socialAccount: 'synthetic' } },
    });
    assert.equal(registration.status, 201, 'collaborator registration');
    const collaboratorId = registration.data.user.id;
    assert.equal((await api(`users/${collaboratorId}/review`, { method: 'POST', body: { revision: 1, decision: 'approved' } })).status, 200, 'approve collaborator');
    const current = (await api('users', {})).data.find((user) => user.id === collaboratorId);
    assert.equal((await api(`users/${collaboratorId}/permissions`, {
      method: 'PATCH',
      body: { level: 'advanced', assignedInstances: ['room-a'], grants: [], revision: current.permissionRevision, reason: 'Collaborate on the room fixture instance.' },
      headers: { 'X-Admin-Reason': 'Room fixture collaboration' },
    })).status, 200, 'assign collaborator');
    const login = await json('/api/admin/auth/login', { method: 'POST', body: { username: 'rooms-collaborator', password } });
    assert.equal(login.status, 200, 'collaborator login');
    const collaborator = { Cookie: login.headers['set-cookie'][0].split(';')[0] };
    const collaboratorApi = (route, options = {}) => raw(publicPort, '/api/admin/' + route, { ...options, headers: { ...collaborator, 'X-CSRF-Token': login.data.csrf, ...mutation, ...options.headers } });

    const limited = await collaboratorApi('monitor/rooms');
    assert.equal(limited.status, 200, `collaborator may list rooms: ${JSON.stringify(limited.data)}`);
    assert.equal(limited.data.unrestricted, false, 'collaborator is restricted');
    assert.deepEqual(limited.data.rooms.map((room) => room.id), ['ROOM-SNAPSHOT'], 'collaborator sees only their instance\'s room');
    assert.equal((await collaboratorApi('monitor/rooms/ROOM-SNAPSHOT')).status, 200, 'collaborator may open their room');
    assert.equal((await collaboratorApi('monitor/rooms/ROOM-FOREIGN')).status, 404, 'invisible room must look missing');
    assert.equal((await api('monitor/rooms/ROOM-FOREIGN')).status, 200, 'super administrator may open it');
    assert.equal((await collaboratorApi('rooms')).status, 403, 'non-super account cannot access managed-room definitions');
    console.log('visibility: unrestricted=super, restricted=collaborator (detail 404 when invisible)');

    // A senior member can create and manage their own rooms. The empty hosted-room
    // whitelist is preserved as the PMP public-room marker, and does not expose rooms
    // owned by another website account.
    const beforeSenior = (await api('users', {})).data.find((user) => user.id === collaboratorId);
    assert.equal((await api(`users/${collaboratorId}/permissions`, {
      method: 'PATCH',
      body: { level: 'senior', assignedInstances: ['room-a'], grants: [], revision: beforeSenior.permissionRevision, reason: 'Allow self-service room creation.' },
      headers: { 'X-Admin-Reason': 'Enable senior room management' },
    })).status, 200, 'promote collaborator to senior');
    const seniorRoom = await collaboratorApi('rooms/hosted', { method: 'POST', body: { roomId: 'SENIOR-PUBLIC', allowedUserIds: [], maxUsers: 4, hostId: null, chart: null, chartMode: 'HOST_SELECT', chartPool: [], ownerId: setup.data.user.id } });
    assert.equal(seniorRoom.status, 201, `senior creates public hosted room: ${JSON.stringify(seniorRoom.data)}`);
    assert.deepEqual(seniorRoom.data.allowed_user_ids, [], 'empty whitelist reaches PMP unchanged');
    assert.equal(seniorRoom.data.owner_id, collaboratorId, 'browser cannot forge the room owner');
    const seniorRooms = await collaboratorApi('rooms');
    assert.equal(seniorRooms.status, 200, 'senior may list managed rooms');
    assert.deepEqual(seniorRooms.data.rooms.map((room) => room.roomid), ['SENIOR-PUBLIC'], 'senior sees only rooms they own');
    assert.equal(seniorRooms.data.total_rooms, 1, 'filtered room total matches the visible list');
    assert.equal((await collaboratorApi('rooms/WEB-HOSTED/hosted')).status, 404, 'senior cannot inspect another owner room');
    assert.equal((await collaboratorApi('rooms/WEB-HOSTED/disband', { method: 'POST', body: {} })).status, 404, 'senior cannot disband another owner room');
    assert.equal((await collaboratorApi('rooms/SENIOR-PUBLIC/hosted', { method: 'PATCH', body: { maxUsers: 6, allowedUserIds: [], hostId: null, chart: null, chartMode: 'HOST_SELECT', chartPool: [] } })).status, 200, 'senior may edit own public room');
    console.log('senior rooms: own-room isolation and empty public whitelist passed');

    // 5. A member without any instance is refused outright: no instance means no capability.
    const strangerPassword = randomUUID();
    const stranger = await json('/api/admin/auth/register', {
      method: 'POST',
      body: { username: 'rooms-stranger', password: strangerPassword, application: { reason: 'Owns nothing at all.', useType: 'personal', socialAccount: 'synthetic-2' } },
    });
    const strangerId = stranger.data.user.id;
    assert.equal((await api(`users/${strangerId}/review`, { method: 'POST', body: { revision: 1, decision: 'approved' } })).status, 200, 'approve stranger');
    const strangerLogin = await json('/api/admin/auth/login', { method: 'POST', body: { username: 'rooms-stranger', password: strangerPassword } });
    assert.equal(strangerLogin.status, 200, 'stranger login');
    const strangerApi = { Cookie: strangerLogin.headers['set-cookie'][0].split(';')[0] };
    const refused = await raw(publicPort, '/api/admin/monitor/rooms', { headers: strangerApi });
    assert.equal(refused.status, 403, 'a member with no instance must be refused');
    console.log('guards: member with no instance -> 403');

    // 6. Degraded mode: the snapshot route disappears, rooms survive through events.
    pmp.setSnapshotAvailable(false);
    pmp.emit('create_room', { room_id: 'ROOM-EVENTS-ONLY', uuid: 'u-4', data: { host_id: 3, chart_id: -999, chart_name: 'Events only', state: 'playing' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const degraded = await api('monitor/rooms?refresh=1');
    assert.equal(degraded.data.status.snapshot, 'unavailable', 'a missing snapshot route must be reported');
    assert.ok(degraded.data.status.lastError.includes('快照'), 'the reason must be surfaced');
    assert.ok(degraded.data.rooms.some((room) => room.id === 'ROOM-EVENTS-ONLY'), 'events keep the list alive without a snapshot');
    console.log(`degraded: snapshot=${degraded.data.status.snapshot}, rooms=${degraded.data.rooms.map((room) => room.id).join(', ')}`);

    // 7. Room monitoring remains available, while the removed spectator surface and
    //    permission are no longer exposed.
    const catalogue = await api('permission-catalog');
    assert.ok(catalogue.data.permissions.some(([permission]) => permission === 'monitor.view'), 'monitor.view must remain in the catalogue');
    assert.ok(!catalogue.data.permissions.some(([permission]) => permission === 'monitor.spectate'), 'monitor.spectate must be removed from the catalogue');
    const page = await raw(publicPort, '/admin');
    assert.equal(page.status, 200, 'admin page');
    const html = page.text;
    for (const marker of ['data-page="rooms"', 'id="roomsNav"', 'id="roomsReload"', 'id="createHostedRoom"', 'id="roomDialog"', 'renderRooms', 'monitor.view', '创建托管房']) {
      assert.ok(html.includes(marker), `admin page must contain ${marker}`);
    }
    assert.ok(html.includes("if(!reason&&roomMutation)reason='网页多人房间操作'"), 'room mutations receive an automatic audit reason');
    assert.ok(!html.includes("confirmDelete('解散房间"), 'disband must not open a second confirmation dialog');
    for (const marker of ['watch-room', 'spectateDialog', 'openSpectate']) assert.ok(!html.includes(marker), `admin page must not contain ${marker}`);
    const removedWatch = await raw(publicPort, '/api/admin/monitor/rooms/ROOM-SNAPSHOT/watch', { headers: adminCookie });
    assert.equal(removedWatch.status, 404, 'removed spectator route must return 404');
    assert.equal((await collaboratorApi('rooms/SENIOR-PUBLIC/disband', { method: 'POST', body: {} })).status, 200, 'senior disbands own room');
    assert.equal((await api('rooms/WEB-HOSTED/disband', { method: 'POST', body: {} })).status, 200, 'managed room disband');
    assert.equal((await api('rooms')).data.rooms.length, 0, 'disband removes managed definition');
    console.log('console: room monitor and managed-room controls remain; spectator UI is absent');

    console.log('\nroom monitor: all checks passed');
  } finally {
    child.kill();
    pmp?.close();
    for (let i = 0; i < 12; i++) {
      try { fs.rmSync(testRoot, { recursive: true, force: true }); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
  }
}

main().catch((error) => {
  console.error(`\nroom monitor test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
