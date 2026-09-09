const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(root, 'data', 'test-admin-accounts-'));
const bootstrap = randomUUID(), password = randomUUID();
let child;
async function port() { const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const p = server.address().port; await new Promise(r => server.close(r)); return p; }
async function main() {
  // Simulate an existing installation: upgrading must not lock out old members.
  const { DatabaseSync } = require('node:sqlite');
  const previous = new DatabaseSync(path.join(testRoot, 'accounts.sqlite'));
  previous.exec("CREATE TABLE admin_users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL UNIQUE COLLATE NOCASE,password_hash TEXT NOT NULL,salt TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','user')),instance_limit INTEGER NOT NULL DEFAULT 2,disabled INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL)");
  previous.prepare("INSERT INTO admin_users(username,password_hash,salt,role,created) VALUES(?,?,?,?,?)").run('previous-member', 'unused-test-hash', 'unused-test-salt', 'user', '2026-01-01');
  previous.close();
  const publicPort = await port(), adminPort = await port();
  child = spawn(process.execPath, [path.join(root, 'dist', 'index.js')], { cwd: root, windowsHide: true, stdio: 'ignore', env: {
    ...process.env, HOST: '127.0.0.1', PORT: String(publicPort), ADMIN_PORT: String(adminPort), MULTIPLAYER_ENABLED: 'false',
    ADMIN_TOKEN: bootstrap, INSTANCE_REGISTRY_PATH: path.join(testRoot, 'instances.json'), PRIVATE_CHARTS_PATH: path.join(testRoot, 'charts'),
    PRIVATE_RECORDS_DB_PATH: path.join(testRoot, 'records.sqlite'), PRIVATE_RECORDS_PATH: path.join(testRoot, 'records.json'),
    PRIVATE_TOKEN_CAPTURE_PATH: '', LOG_TO_FILE: 'false', DEBUG_BODY: 'true', UPSTREAM_BASE_URL: 'https://127.0.0.1:1' } });
  function request(route, method = 'GET', body, actor, extra = {}, secure = true) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? '' : JSON.stringify(body);
      const req = (secure ? https : http).request({ hostname: '127.0.0.1', port: secure ? publicPort : adminPort, path: route, method, rejectUnauthorized: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Admin-Request': '1', ...(actor ? { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrf } : {}), ...extra } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let payload; try { payload = JSON.parse(text); } catch {} resolve({ status: res.statusCode, data: payload, text, cookies: res.headers['set-cookie'] || [] }); });
      }); req.on('error', reject); req.end(data);
    });
  }
  for (let i = 0; i < 60; i++) { try { if ((await request('/health')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  async function auth(action, username, fields = {}) {
    const r = await request('/api/admin/auth/' + action, 'POST', { username, password, ...(action === 'register' ? { application: { reason: 'Testing private chart collection management.', useType: 'personal', socialAccount: 'Test platform: test-only', notes: '' } } : {}), ...fields });
    assert.ok([200, 201].includes(r.status), action + ' must succeed');
    assert.match(r.cookies[0], /HttpOnly; SameSite=Strict/); assert.match(r.cookies[0], /; Secure/);
    return { cookie: r.cookies[0].split(';')[0], csrf: r.data.csrf, user: r.data.user };
  }
  assert.equal((await request('/admin')).status, 200);
  assert.equal((await request('/api/admin/auth/status')).data.setupRequired, true);
  assert.equal((await request('/api/admin/auth/setup', 'POST', { username: 'intruder', password, adminToken: 'wrong' })).status, 403);
  assert.equal((await request('/api/admin/auth/register', 'POST', { username: 'missing-profile', password })).status, 422);
  const alice = await auth('register', 'alice', { role: 'admin', instanceLimit: 999, approvalStatus: 'approved', permissions: { reviewUsers: true, manageInstances: true } });
  assert.equal(alice.user.role, 'user'); assert.equal(alice.user.instanceLimit, 2);
  assert.equal(alice.user.approvalStatus, 'pending');
  assert.deepEqual(alice.user.permissions, { reviewUsers: false, manageInstances: false });
  assert.equal((await request('/api/admin/instances', 'GET', undefined, alice)).status, 403);
  assert.equal((await request('/api/admin/auth/status')).data.setupRequired, true);
  const admin = await auth('setup', 'owner', { adminToken: bootstrap });
  assert.equal(admin.user.role, 'admin');
  assert.equal((await request('/api/admin/users', 'GET', undefined, admin)).data.find(u => u.username === 'previous-member').approvalStatus, 'approved');
  assert.equal((await request('/api/admin/users/' + alice.user.id + '/review', 'POST', { revision: 1, decision: 'approved' }, admin)).status, 200);
  assert.equal((await request('/api/admin/auth/setup', 'POST', { username: 'second-admin', password, adminToken: bootstrap })).status, 409);
  const bob = await auth('register', 'bob');
  assert.equal((await request('/api/admin/users/' + bob.user.id + '/review', 'POST', { revision: 1, decision: 'approved' }, alice)).status, 403);
  assert.equal((await request('/api/admin/users/' + bob.user.id + '/review', 'POST', { revision: 1, decision: 'rejected' }, admin)).status, 422);
  assert.equal((await request('/api/admin/users/' + bob.user.id + '/review', 'POST', { revision: 1, decision: 'rejected', note: 'Please explain the team usage.' }, admin)).status, 200);
  assert.equal((await request('/api/admin/auth/me', 'GET', undefined, bob)).data.user.approvalStatus, 'rejected');
  assert.equal((await request('/api/admin/instances', 'POST', { id: 'not-approved' }, bob)).status, 403);
  const groupApplication = { reason: 'Sharing practice charts in a small rhythm game community.', useType: 'group', socialAccount: 'Test platform: community-only' };
  assert.equal((await request('/api/admin/auth/application', 'POST', { application: groupApplication }, bob)).status, 422);
  assert.equal((await request('/api/admin/auth/application', 'POST', { application: { ...groupApplication, organization: 'Test Community' } }, bob)).status, 200);
  const reviewer = await auth('register', 'reviewer');
  assert.equal((await request('/api/admin/users/' + reviewer.user.id + '/permissions', 'PATCH', { reviewUsers: true, manageInstances: false }, admin)).status, 422);
  await request('/api/admin/users/' + reviewer.user.id + '/review', 'POST', { revision: 1, decision: 'approved' }, admin);
  assert.equal((await request('/api/admin/users/' + reviewer.user.id + '/permissions', 'PATCH', { reviewUsers: true, manageInstances: false }, admin)).status, 200);
  assert.equal((await request('/api/admin/users/' + reviewer.user.id + '/review', 'POST', { revision: 1, decision: 'approved' }, reviewer)).status, 403);
  assert.equal((await request('/api/admin/users/' + bob.user.id + '/review', 'POST', { revision: 1, decision: 'approved' }, reviewer)).status, 409, 'Stale application revision must not be approved');
  const decisions = await Promise.all(['approved', 'rejected'].map(decision => request('/api/admin/users/' + bob.user.id + '/review', 'POST', { revision: 2, decision, note: 'Review checked.' }, reviewer)));
  assert.equal(decisions.filter(r => r.status === 200).length, 1, 'Only one concurrent reviewer decision may commit');
  assert.equal(decisions.filter(r => r.status === 409).length, 1);
  if ((await request('/api/admin/auth/me', 'GET', undefined, bob)).data.user.approvalStatus === 'rejected') {
    await request('/api/admin/auth/application', 'POST', { application: { ...groupApplication, organization: 'Test Community' } }, bob);
    await request('/api/admin/users/' + bob.user.id + '/review', 'POST', { revision: 3, decision: 'approved' }, reviewer);
  }
  assert.equal((await request('/api/admin/users/' + bob.user.id, 'PATCH', { instanceLimit: 900 }, reviewer)).status, 403);
  assert.equal((await request('/api/admin/users/' + reviewer.user.id + '/permissions', 'PATCH', { reviewUsers: true, manageInstances: true }, reviewer)).status, 403);
  assert.equal((await request('/api/admin/users/' + bob.user.id + '/history', 'GET', undefined, reviewer)).data.some(e => e.action === 'resubmit'), true);
  assert.deepEqual((await request('/api/admin/instances', 'GET', undefined, alice)).data, []);
  assert.equal((await request('/api/admin/dashboard', 'GET', undefined, alice)).status, 403);
  const creates = await Promise.all([1, 2, 3].map(i => request('/api/admin/instances', 'POST', { id: 'alice-' + i, name: 'Alice ' + i, ownerId: bob.user.id }, alice)));
  assert.equal(creates.filter(r => r.status === 201).length, 2, 'Concurrent creation must enforce quota');
  assert.equal(creates.filter(r => r.status === 409).length, 1);
  const owned = (await request('/api/admin/instances', 'GET', undefined, alice)).data;
  assert.ok(owned.every(i => i.ownerId === alice.user.id));
  assert.equal(owned[0].chartsPath, undefined, 'Filesystem paths must not be disclosed');
  const id = owned[0].id;
  assert.equal((await request('/api/admin/dashboard?instance=' + id, 'GET', undefined, reviewer)).status, 403);
  await request('/api/admin/users/' + reviewer.user.id + '/permissions', 'PATCH', { reviewUsers: false, manageInstances: true }, admin);
  assert.equal((await request('/api/admin/dashboard?instance=' + id, 'GET', undefined, reviewer)).status, 200);
  assert.equal((await request('/api/admin/instances/' + id, 'PATCH', { name: 'Staff updated' }, reviewer)).status, 200);
  assert.equal((await request('/api/admin/users', 'GET', undefined, reviewer)).status, 403, 'Instance managers cannot read registration profiles without review permission');
  assert.equal((await request('/api/admin/instances/' + id, 'PATCH', { hosts: ['blocked.example'] }, reviewer)).status, 403);
  await request('/api/admin/users/' + reviewer.user.id + '/permissions', 'PATCH', { reviewUsers: false, manageInstances: false }, admin);
  assert.equal((await request('/api/admin/dashboard?instance=' + id, 'GET', undefined, reviewer)).status, 403, 'Permission revocation must apply to the same session immediately');
  for (const route of ['/api/admin/dashboard', '/api/admin/charts', '/api/admin/records', '/api/admin/download/-1']) {
    assert.equal((await request(route + '?instance=' + id, 'GET', undefined, bob)).status, 403, 'Foreign access must fail: ' + route);
  }
  for (const method of ['PATCH', 'DELETE']) assert.equal((await request('/api/admin/instances/' + id, method, { name: 'Stolen' }, bob)).status, 403);
  assert.equal((await request('/api/admin/charts/batch-delete?instance=' + id, 'POST', { all: true }, bob)).status, 403);
  assert.equal((await request('/api/admin/instances/' + id, 'PATCH', { hosts: ['phira.5wyxi.com'] }, alice)).status, 403);
  assert.equal((await request('/api/admin/instances/' + id, 'PATCH', { ownerId: bob.user.id, name: 'Renamed' }, alice)).status, 200);
  assert.equal((await request('/api/admin/instances', 'GET', undefined, alice)).data[0].ownerId, alice.user.id);
  assert.equal((await request('/api/admin/users', 'GET', undefined, alice)).status, 403);
  assert.equal((await request('/api/admin/users/' + alice.user.id, 'PATCH', { instanceLimit: 999 }, alice)).status, 403);
  assert.equal((await request('/api/admin/instances/' + id, 'PATCH', { name: 'Cross site' }, alice, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/admin/instances/' + id, 'DELETE', {}, alice, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await request('/api/admin/instances', 'GET', undefined, undefined, { Authorization: 'Bearer ' + bootstrap })).status, 401, 'Legacy token must not authorize public access');
  assert.equal((await request('/api/admin/users/' + alice.user.id, 'PATCH', { instanceLimit: 3 }, admin)).status, 200);
  assert.equal((await request('/api/admin/instances', 'POST', { id: 'alice-extra', name: 'Extra' }, alice)).status, 201);
  assert.equal((await request('/api/admin/users/' + alice.user.id, 'PATCH', { instanceLimit: 0 }, admin)).status, 200);
  assert.equal((await request('/api/admin/instances', 'GET', undefined, alice)).data.length, 3, 'Quota reductions must preserve data');
  assert.equal((await request('/api/admin/instances', 'POST', { id: 'alice-blocked' }, alice)).status, 409);
  assert.equal((await request('/api/admin/instances/' + id, 'DELETE', {}, admin)).status, 200, 'Super admin can delete user instances');
  assert.equal((await request('/api/admin/instances/default', 'DELETE', {}, admin)).status, 422);
  assert.equal((await request('/api/admin/users/' + alice.user.id, 'PATCH', { disabled: true }, admin)).status, 200);
  assert.equal((await request('/api/admin/instances', 'GET', undefined, alice)).status, 401);
  assert.equal((await request('/api/admin/auth/login', 'POST', { username: 'alice', password })).status, 401);
  assert.equal((await request('/api/admin/users/' + alice.user.id, 'PATCH', { disabled: false }, admin)).status, 200);
  const alice2 = await auth('login', 'alice');
  assert.equal((await request('/api/admin/auth/password', 'POST', { currentPassword: password, password: password + '-new' }, alice2)).status, 200);
  assert.equal((await request('/api/admin/auth/me', 'GET', undefined, alice2)).status, 401);
  assert.equal((await request('/api/admin/auth/login', 'POST', { username: 'alice', password })).status, 401);
  const alice3 = await auth('login', 'alice', { password: password + '-new' });
  assert.equal((await request('/api/admin/auth/logout', 'POST', {}, alice3)).status, 200);
  assert.equal((await request('/api/admin/auth/me', 'GET', undefined, alice3)).status, 401);
  assert.equal((await request('/api/admin/users/' + admin.user.id, 'PATCH', { disabled: true }, admin)).status, 422);
  assert.equal((await request('/api/admin/instances', 'GET', undefined, undefined, { Authorization: 'Bearer ' + bootstrap }, false)).status, 200, 'Local administrative scripts retain compatibility');
  for (const name of fs.readdirSync(testRoot).filter(name => name.startsWith('accounts.sqlite'))) {
    const bytes = fs.readFileSync(path.join(testRoot, name));
    assert.equal(bytes.includes(Buffer.from(password)), false, 'Account storage must not contain plaintext passwords');
    assert.equal(bytes.includes(Buffer.from(bootstrap)), false, 'Account storage must not contain the bootstrap secret');
    assert.equal(bytes.includes(Buffer.from(alice.cookie.split('=')[1])), false, 'Only session hashes may be persisted');
  }
  console.log('Account API passed: migration, application validation, pending access restrictions, rejection/resubmission, concurrent reviews, delegated permissions/revocation, protected admin setup, sessions, quota limits, ownership, CSRF, suspension and passwords.');
}
main().catch(error => { console.error(String(error.message).replaceAll(bootstrap, '[REDACTED]').replaceAll(password, '[REDACTED]')); process.exitCode = 1; }).finally(async () => {
  if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  const resolved = path.resolve(testRoot);
  if (path.dirname(resolved) !== path.join(root, 'data') || !path.basename(resolved).startsWith('test-admin-accounts-')) throw new Error('Unsafe test cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true });
});
