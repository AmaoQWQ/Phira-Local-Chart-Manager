// Browser regression against a fully isolated Gateway. Install Playwright separately,
// then set ADMIN_UI_PLAYWRIGHT_PATH to its module directory if it is not on NODE_PATH.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { chromium } = require(process.env.ADMIN_UI_PLAYWRIGHT_PATH || 'playwright');
const { PrivateChartStore } = require('../dist/private-chart');

const root = path.resolve(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(root, 'data', 'test-admin-ui-'));
const output = path.join(root, 'artifacts', 'admin-ui');
const token = randomUUID();
let child, browser;
const errors = [];

function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [filename, content] of Object.entries(entries)) {
    const name = Buffer.from(filename), data = Buffer.from(content);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  const chartsPath = path.join(testRoot, 'default', 'charts');
  const charts = new PrivateChartStore(chartsPath);
  const packageFile = zip({ 'info.yml': 'name: Test package\nlevel: IN 15\ndifficulty: 15\n', 'chart.json': '{}' });
  const names = ['星河漫游', 'Fractured Sky', '月光航线', 'Silent Horizon', '深蓝回响', 'After the Rain'];
  for (let i = 0; i < 27; i++) charts.create({ id: -100 - i, name: names[i % names.length] + (i > 5 ? ' · ' + i : ''), charter: 'Studio ' + (i % 3 + 1), level: i % 3 ? 'IN 15' : 'AT 16', difficulty: 15 + i % 3, tags: i % 2 ? ['featured'] : ['test', 'collection'], listed: i % 4 !== 0 }, { packageFile });
  const adminPort = await freePort(), publicPort = await freePort();
  const base = 'http://127.0.0.1:' + adminPort;
  child = spawn(process.execPath, [path.join(root, 'dist', 'index.js')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(publicPort), ADMIN_PORT: String(adminPort), MULTIPLAYER_ENABLED: 'false',
      ADMIN_TOKEN: token, PRIVATE_CHARTS_PATH: chartsPath, INSTANCE_REGISTRY_PATH: path.join(testRoot, 'instances.json'),
      PRIVATE_RECORDS_PATH: path.join(testRoot, 'default', 'records.json'), PRIVATE_RECORDS_DB_PATH: path.join(testRoot, 'default', 'records.sqlite'),
      PRIVATE_TOKEN_CAPTURE_PATH: '', LOG_TO_FILE: 'false', DEBUG_BODY: 'false', UPSTREAM_BASE_URL: 'https://127.0.0.1:1' },
  });
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error('Isolated Gateway exited during startup');
    try { if ((await fetch(base + '/health')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  async function api(route, method = 'GET', body) {
    const response = await fetch(base + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Admin-Reason': 'Browser fixture operation', 'X-Admin-Confirm': route.includes('/instances/') ? route.split('/')[4].split('?')[0] : 'delete' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.ok, true, 'Isolated admin API must succeed: ' + route);
    return response.json();
  }
  for (let i = 0; i < 5; i++) await api('/api/admin/records', 'POST', { player: 2000 + i, chart: -100 - i, score: 910000 + i * 9000, accuracy: 0.92 + i * 0.01, perfect: 900, good: 20, bad: 0, miss: 0, maxCombo: 920, fullCombo: i === 4 });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(()=>new MutationObserver(()=>{const dialog=document.querySelector('#reasonDialog'),input=document.querySelector('#operationReason');if(dialog?.open&&input&&!input.value){input.value='Browser regression operation';document.querySelector('#reasonForm').requestSubmit()}}).observe(document,{subtree:true,attributes:true,attributeFilter:['open']}));
  await page.goto(base + '/admin');
  await page.waitForFunction(() => !document.querySelector('#setupDetails').hidden && !document.querySelector('#reload').disabled);
  fs.mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'login.png') });
  await page.locator('#setupDetails summary').click();
  await page.locator('#setupForm [name=adminToken]').fill(token);
  await page.locator('#setupForm [name=username]').fill('ui-owner');
  await page.locator('#setupForm [name=password]').fill('ui-test-password-only');
  await page.locator('#setupForm [name=confirmPassword]').fill('ui-test-password-only');
  await page.locator('#setupForm button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#statCharts').textContent === '27');
  await page.waitForFunction(() => !document.querySelector('#reload').disabled);
  assert.equal(await page.evaluate(() => Boolean(localStorage.getItem('private-gateway-admin-token'))), false);
  assert.equal(await page.locator('#charts tr').count(), 20);
  fs.mkdirSync(output, { recursive: true });
  await page.locator('#toasts').evaluate(el => el.replaceChildren());
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });

  await page.locator('#chartHeaderCheck').check();
  await page.locator('#chartNext').click();
  assert.equal(await page.locator('#charts tr').count(), 7);
  assert.match(await page.locator('#selectedCount').textContent(), /20/);
  await page.locator('#selectFiltered').click();
  assert.match(await page.locator('#selectedCount').textContent(), /27/);
  await page.locator('#batchTags').click();
  await page.locator('#changeTags').fill('reviewed, 测试标签');
  await page.locator('#tagsForm button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#tagsDialog').open && !document.querySelector('#reload').disabled);
  assert.equal((await api('/api/admin/charts')).filter(c => c.tags.includes('reviewed')).length, 27);
  await page.locator('#clearSelection').click();
  await page.locator('#chartSearch').fill('星河漫游');
  assert.equal(await page.locator('#charts tr').count(), 5);
  await page.locator('#charts [data-action=edit]').first().click();
  await page.locator('#editForm [name=name]').fill('<img src=x onerror=alert(1)> 测试名称');
  await page.locator('#editForm button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#editDialog').open && !document.querySelector('#reload').disabled);
  await page.locator('#chartSearch').fill('测试名称');
  assert.equal(await page.locator('#charts img').count(), 0, 'Chart names must remain text');
  await page.locator('#charts [data-action=visibility]').click();
  await page.waitForFunction(() => !document.querySelector('#reload').disabled);
  const edited = (await api('/api/admin/charts')).find(c => c.name.includes('测试名称'));
  await page.locator('#visibilityFilter').selectOption(edited.listed ? 'hidden' : 'listed');
  assert.match(await page.locator('#charts').textContent(), /没有匹配/);
  await page.locator('#visibilityFilter').selectOption('');
  await page.locator('#chartSearch').fill('');

  await page.locator('[data-view=instances]').click();
  await page.locator('#createInstance').click();
  await page.locator('#instanceId').fill('review');
  await page.locator('#instanceName').fill('联调测试实例');
  await page.locator('#instanceForm button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#instanceSelect').value === 'review' && !document.querySelector('#reload').disabled);
  assert.equal(await page.locator('#statCharts').textContent(), '0');
  assert.deepEqual((await api('/api/admin/instances')).find(i=>i.id==='review').visibility, {mode:'none',userIds:[]});
  for (const [mode, ids] of [['users',[111]],['users',[111,222]],['all',[]],['none',[]]]) {
    await page.locator('[data-action=edit-instance][data-instance=review]').click();
    await page.locator('#instanceVisibility').selectOption(mode);
    if(mode==='users') await page.locator('#instanceViewers').fill(ids.join(', '));
    assert.equal(await page.locator('#instanceViewers').isVisible(),mode==='users');
    if(mode==='users'&&ids.length===2) await page.screenshot({path:path.join(output,'visibility.png')});
    await page.locator('#instanceForm button[type=submit]').click();
    await page.waitForFunction(()=>!document.querySelector('#instanceDialog').open&&!document.querySelector('#reload').disabled);
    assert.deepEqual((await api('/api/admin/instances')).find(i=>i.id==='review').visibility,{mode,userIds:ids});
  }
  await page.locator('[data-view=upload]').click();
  await page.locator('#packageInput').setInputFiles({ name: 'review.zip', mimeType: 'application/zip', buffer: zip({ 'info.yml': 'name: Nondefault download\nlevel: IN 12\ndifficulty: 12\n', 'marker.txt': 'NONDEFAULT-INSTANCE' }) });
  await page.locator('#chartForm [name=id]').fill('-200');
  await page.locator('#uploadSubmit').click();
  await page.waitForFunction(() => document.querySelector('#statCharts').textContent === '1' && !document.querySelector('#reload').disabled);
  assert.match(await page.locator('#uploadResult').textContent(), /上传成功/);
  await page.locator('[data-view=charts]').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#charts [data-action=download]').click();
  const download = await downloadPromise;
  assert.ok(fs.readFileSync(await download.path()).includes(Buffer.from('NONDEFAULT-INSTANCE')), 'Download must read selected instance, with its own resources');
  // Public requests must continue to resolve by Host even when an instance query is supplied.
  const publicResource = await new Promise((resolve, reject) => {
    https.get({ hostname: '127.0.0.1', port: publicPort, path: '/private-charts/-100.pez?instance=review', rejectUnauthorized: false }, r => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks) })); }).on('error', reject);
  });
  assert.equal(publicResource.status, 200);
  assert.equal(publicResource.body.includes(Buffer.from('NONDEFAULT-INSTANCE')), false);

  await page.locator('[data-view=records]').click();
  await page.locator('#addRecord').click();
  await page.locator('#recordForm [name=player]').fill('456');
  await page.locator('#recordFormChart').selectOption('-200');
  await page.locator('#recordForm [name=score]').fill('990000');
  await page.locator('#recordForm [name=accuracy]').fill('99.5');
  await page.locator('#recordForm button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#recordDialog').open && !document.querySelector('#reload').disabled);
  assert.match(await page.locator('#records').textContent(), /99.50%/);
  assert.equal((await api('/api/admin/records?instance=review'))[0].accuracy, 0.995);
  await page.locator('#records [data-action=delete-record]').click();
  assert.equal(await page.locator('#confirmAction').isDisabled(), true);
  await page.locator('#confirmInput').fill('删除');
  await page.locator('#confirmAction').click();
  await page.waitForFunction(() => !document.querySelector('#confirmDialog').open && !document.querySelector('#reload').disabled);
  assert.equal((await api('/api/admin/records?instance=review')).length, 0);

  await page.locator('[data-view=upload]').click();
  const collection = zip({ '#-200_duplicate.zip': packageFile, '#-201_new.zip': packageFile });
  await page.locator('#packageInput').setInputFiles({ name: 'collection.zip', mimeType: 'application/zip', buffer: collection });
  await page.locator('#uploadSubmit').click();
  await page.waitForFunction(() => document.querySelector('#statCharts').textContent === '2' && !document.querySelector('#reload').disabled);
  assert.match(await page.locator('#uploadResult').textContent(), /新增 1 张，跳过 1/);
  assert.match(await page.locator('#uploadResult').textContent(), /#-200_duplicate.zip/);
  await page.screenshot({ path: path.join(output, 'upload.png'), fullPage: true });
  await page.locator('[data-view=charts]').click();
  await page.locator('#chartHeaderCheck').check();
  await page.locator('#deleteSelected').click();
  await page.locator('#confirmInput').fill('删除');
  await page.locator('#confirmAction').click();
  await page.waitForFunction(() => !document.querySelector('#confirmDialog').open && !document.querySelector('#reload').disabled);
  assert.equal((await api('/api/admin/charts?instance=review')).length, 0);
  assert.equal((await api('/api/admin/charts')).length, 27, 'Batch deletion must not affect another instance');
  await page.locator('#instanceSelect').selectOption('default');
  await page.waitForFunction(() => document.querySelector('#statCharts').textContent === '27' && !document.querySelector('#reload').disabled);
  await page.locator('#toasts').evaluate(el => el.replaceChildren());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.sidebar').evaluate(el => el.getAnimations().length ? Promise.all(el.getAnimations().map(animation => animation.finished)) : undefined);
  await page.screenshot({ path: path.join(output, 'mobile.png') });
  await page.screenshot({ path: path.join(output, 'mobile-full.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile page must not overflow horizontally');
  await page.setViewportSize({ width: 360, height: 800 });
  await page.locator('.sidebar').evaluate(el => el.getAnimations().length ? Promise.all(el.getAnimations().map(animation => animation.finished)) : undefined);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '360px page must not overflow horizontally');
  await page.screenshot({ path: path.join(output, 'mobile-360.png') });
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.locator('.sidebar').evaluate(el => el.getAnimations().length ? Promise.all(el.getAnimations().map(animation => animation.finished)) : undefined);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Tablet page must not overflow horizontally');
  await page.screenshot({ path: path.join(output, 'tablet.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#navToggle').click();
  assert.equal(await page.locator('#navToggle').getAttribute('aria-expanded'), 'true');
  await page.locator('[data-view=records]').click();
  assert.equal(await page.locator('#navToggle').getAttribute('aria-expanded'), 'false');
  await page.locator('#recordSearch').fill('2002');
  assert.equal(await page.locator('#records tr').count(), 1);
  // A separately registered account must see and manage only its own instances.
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const member = await memberContext.newPage();
  member.on('pageerror', error => errors.push(error.message));
  await member.goto(base + '/admin');
  await member.waitForFunction(() => !document.querySelector('#reload').disabled);
  await member.locator('#showRegister').click();
  await member.locator('#registerForm [name=username]').fill('browser-member');
  await member.locator('#registerForm [name=password]').fill('member-password-only');
  await member.locator('#registerForm [name=confirmPassword]').fill('member-password-only');
  await member.locator('#registerForm [name=reason]').fill('I want to manage charts for my rhythm game practice group. <img src=x onerror=alert(1)>');
  await member.locator('#registerForm [name=useType]').selectOption('group');
  await member.locator('#registerForm [name=organization]').fill('Browser Test Group');
  await member.locator('#registerForm [name=socialAccount]').fill('Test platform: browser-member');
  await member.locator('#registerForm button[type=submit]').click();
  await member.waitForFunction(() => !document.querySelector('#workspace').hidden && !document.querySelector('#reload').disabled);
  assert.equal(await member.locator('[data-page=application]').isVisible(), true);
  assert.equal(await member.locator('[data-view=docs]').isVisible(), true);
  assert.equal(await member.locator('[data-view=charts]').isVisible(), false);
  assert.equal(await member.locator('[data-view=settings]').isVisible(), true);
  assert.equal(await member.locator('#createInstance').isDisabled(), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#reload').click();
  await page.waitForFunction(() => !document.querySelector('#reload').disabled);
  await page.locator('#usersNav').click();
  let applicationRow = page.locator('#users tr').filter({ hasText: 'browser-member' });
  await applicationRow.locator('[data-review-user]').click();
  await page.waitForFunction(() => document.querySelector('#reviewDialog').open && !document.querySelector('#reload').disabled);
  assert.equal(await page.locator('#reviewApplication img').count(), 0, 'Application text must not execute HTML');
  await page.screenshot({ path: path.join(output, 'application-review.png') });
  await page.locator('#reviewDecision').selectOption('rejected');
  await page.locator('#reviewNote').fill('Please describe your planned group size.');
  await page.locator('#reviewForm button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#reviewDialog').open && !document.querySelector('#reload').disabled);
  await member.locator('#reload').click();
  await member.waitForFunction(() => !document.querySelector('#reload').disabled);
  assert.match(await member.locator('#applicationStatus').textContent(), /planned group size/);
  await member.locator('#applicationForm [name=notes]').fill('A small group of eight players.');
  await member.locator('#applicationForm button[type=submit]').click();
  await member.waitForFunction(() => !document.querySelector('#reload').disabled);
  assert.match(await member.locator('#applicationStatus').textContent(), /等待审核/);
  await page.locator('#reload').click();
  await page.waitForFunction(() => !document.querySelector('#reload').disabled);
  await applicationRow.locator('[data-review-user]').click();
  await page.waitForFunction(() => document.querySelector('#reviewDialog').open && !document.querySelector('#reload').disabled);
  assert.match(await page.locator('#reviewApplication').textContent(), /eight players/);
  await page.locator('#reviewForm button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#reviewDialog').open && !document.querySelector('#reload').disabled);
  await member.locator('#reload').click();
  await member.waitForFunction(() => !document.querySelector('#reload').disabled);
  await member.locator('[data-view=instances]').click();
  assert.equal(await member.locator('#usersNav').isVisible(), false);
  assert.equal(await member.locator('.instance-card').count(), 0);
  for (let i = 1; i <= 2; i++) {
    await member.locator('#createInstance').click();
    await member.locator('#instanceId').fill('member-' + i);
    await member.locator('#instanceName').fill('我的实例 ' + i);
    assert.equal(await member.locator('#instanceHosts').isVisible(), false);
    await member.locator('#instanceForm button[type=submit]').click();
    await member.waitForFunction(() => !document.querySelector('#instanceDialog').open && !document.querySelector('#reload').disabled);
  }
  assert.equal(await member.locator('#createInstance').isDisabled(), true);
  assert.match(await member.locator('#accountQuota').textContent(), /2 \/ 2/);
  await member.locator('#toasts').evaluate(el => el.replaceChildren());
  await member.screenshot({ path: path.join(output, 'member.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#reload').click();
  await page.waitForFunction(() => !document.querySelector('#reload').disabled);
  await page.locator('#usersNav').click();
  const memberRow = page.locator('#users tr').filter({ hasText: 'browser-member' });
  await memberRow.locator('[data-quota]').fill('3');
  await memberRow.locator('[data-save-user]').click();
  await page.waitForFunction(() => !document.querySelector('#reload').disabled);
  await page.locator('#toasts').evaluate(el => el.replaceChildren());
  await page.screenshot({ path: path.join(output, 'users.png'), fullPage: true });
  await member.locator('#reload').click();
  await member.waitForFunction(() => !document.querySelector('#reload').disabled);
  assert.equal(await member.locator('#createInstance').isDisabled(), false);
  assert.match(await member.locator('#accountQuota').textContent(), /2 \/ 3/);
  await memberRow.locator('[data-permissions-user]').click();
  await page.locator('#memberLevel').selectOption('manager');
  await page.locator('#permissionReason').fill('Delegate daily account administration');
  await page.screenshot({ path: path.join(output, 'permissions.png') });
  await page.locator('#permissionsForm button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#permissionsDialog').open && !document.querySelector('#reload').disabled);
  await member.locator('#reload').click();
  await member.waitForFunction(() => !document.querySelector('#reload').disabled);
  assert.equal(await member.locator('#usersNav').isVisible(), true);
  assert.equal(await member.locator('.instance-card').count(), 2, 'Manager cannot see server administrator instances without explicit grants');
  assert.match(await member.locator('#accountQuota').textContent(), /2 \/ 3/, 'Staff quota counts only owned instances');
  await api('/api/admin/auth/register', 'POST', { username: 'delegated-applicant', password: 'delegated-password-only', application: { reason: 'I plan to organize my personal practice charts.', useType: 'personal', socialAccount: 'Test platform: delegated-applicant' } });
  await member.locator('#reload').click();
  await member.waitForFunction(() => !document.querySelector('#reload').disabled);
  await member.locator('#usersNav').click();
  assert.equal(await member.locator('[data-permissions-user]').count(), 0, 'Reviewers cannot grant permissions');
  assert.equal(await member.locator('[data-save-user]').count(), 0, 'Reviewers cannot change quotas');
  await member.locator('#users tr').filter({ hasText: 'delegated-applicant' }).locator('[data-review-user]').click();
  await member.waitForFunction(() => document.querySelector('#reviewDialog').open && !document.querySelector('#reload').disabled);
  await member.locator('#reviewForm button[type=submit]').click();
  await member.waitForFunction(() => !document.querySelector('#reviewDialog').open && !document.querySelector('#reload').disabled);
  assert.equal((await api('/api/admin/users')).find(u => u.username === 'delegated-applicant').approvalStatus, 'approved');
  await memberRow.locator('[data-permissions-user]').click();
  await page.locator('#memberLevel').selectOption('ordinary');
  await page.locator('#permissionReason').fill('Revoke delegated administration');
  await page.locator('#permissionsForm button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#permissionsDialog').open && !document.querySelector('#reload').disabled);
  await member.locator('#reload').click();
  await member.waitForFunction(() => !document.querySelector('#reload').disabled);
  assert.equal(await member.locator('#usersNav').isVisible(), false);
  assert.equal(await member.locator('#users tr [data-review-user]').count(), 0, 'Revoked reviewer must clear cached applicant data');
  await memberRow.locator('[data-permissions-user]').click();
  await page.locator('#memberLevel').selectOption('senior');
  await page.locator('#assignedInstances [data-assigned="default"]').click();
  await page.locator('#addGrant').click();
  assert.equal(await page.locator('[data-grant-permission] option[value="application.read"]').count(),0,'Senior member cannot be granted application access');
  await page.locator('[data-grant-permission]').selectOption('chart.download');
  await page.locator('[data-grant-effect]').selectOption('deny');
  await page.locator('[data-grant-instances]').selectOption('default');
  await page.locator('#permissionReason').fill('Assign chart collaboration with download denied');
  await page.screenshot({path:path.join(output,'scoped-permissions.png')});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Permission editor must fit mobile viewport');
  await page.screenshot({path:path.join(output,'scoped-permissions-mobile.png')});
  await page.locator('#permissionsForm button[type=submit]').click();
  await page.waitForFunction(()=>!document.querySelector('#permissionsDialog').open&&!document.querySelector('#reload').disabled);
  await member.locator('#reload').click();
  await member.waitForFunction(()=>!document.querySelector('#reload').disabled);
  assert.match(await member.locator('#accountName').textContent(),/高级成员/);
  assert.equal(await member.locator('#usersNav').isVisible(),false);
  await member.locator('#instanceSelect').selectOption('default');
  await member.waitForFunction(()=>document.querySelector('#statCharts').textContent==='27'&&!document.querySelector('#reload').disabled);
  await member.locator('[data-view=charts]').click();
  assert.equal(await member.locator('[data-action=download]').first().isDisabled(),true);
  assert.equal(await member.locator('[data-action=edit]').first().isEnabled(),true);
  await member.locator('[data-view=instances]').click();
  assert.equal(await member.locator('[data-action=edit-instance][data-instance=default]').isDisabled(),true);
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('[data-view=audit]').click();
  await page.locator('#auditReload').click();
  await page.waitForFunction(()=>document.querySelector('#auditEvents').children.length>0&&!document.querySelector('#reload').disabled);
  await page.screenshot({path:path.join(output,'audit.png')});
  await page.locator('#usersNav').click();
  await memberRow.locator('[data-disable-user]').click();
  await page.waitForFunction(() => !document.querySelector('#reload').disabled);
  await member.locator('#reload').click();
  await member.waitForFunction(() => !document.querySelector('#authGate').hidden);
  assert.equal(await member.locator('#workspace').isVisible(), false);
  await memberContext.close();
  // Expired credentials must not leave old instance data actionable.
  await page.route('**/api/admin/dashboard?*', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'expired' }) }));
  await page.locator('#reload').click();
  await page.waitForFunction(() => !document.querySelector('#loadError').hidden);
  assert.equal(await page.locator('#authGate').isVisible(), true);
  assert.equal(await page.locator('#workspace').isVisible(), false);
  await page.unroute('**/api/admin/dashboard?*');
  assert.equal(await page.evaluate(() => Boolean(sessionStorage.getItem('private-gateway-admin-token'))), false);
  assert.deepEqual(errors, []);
  console.log('Admin UI passed: connection, 27-chart pagination/selection, filters, escaped names, editing, tags, visibility, instance creation/switching, scoped download, public isolation, upload/collection results, scores, scoped deletion, expired credentials and mobile layout.');
  console.log('Preview screenshots: artifacts/admin-ui/{desktop,mobile,upload}.png (synthetic test data only).');
}

main().catch(error => { console.error(String(error.stack || error.message).replaceAll(token, '[REDACTED]')); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  }
  const resolved = path.resolve(testRoot);
  if (path.dirname(resolved) !== path.join(root, 'data') || !path.basename(resolved).startsWith('test-admin-ui-')) throw new Error('Unsafe test cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true });
});
