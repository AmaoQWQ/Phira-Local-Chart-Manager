// End-to-end check of the chart preview: the WASM renderer assets, the bincode
// payload the player downloads, its cached summary, and the admin page that drives it.
//
//   node scripts/test-monitor-preview.js
//
// The real chart packages are only read, never modified; every writable path points
// into a temporary directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(root, 'data', 'test-monitor-'));
const cachePath = path.join(testRoot, 'cache');
const chartsPath = path.join(root, 'data', 'private-charts');
const bootstrap = randomUUID();
let child;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Raw request that keeps the body as a Buffer, for binary payloads. */
function raw(port, route, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const request = https.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method,
      rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function main() {
  const publicPort = await freePort();
  const adminPort = await freePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(publicPort),
    ADMIN_PORT: String(adminPort),
    MULTIPLAYER_ENABLED: 'false',
    ADMIN_TOKEN: bootstrap,
    INSTANCE_REGISTRY_PATH: path.join(testRoot, 'instances.json'),
    PRIVATE_CHARTS_PATH: chartsPath,
    PRIVATE_RECORDS_DB_PATH: path.join(testRoot, 'records.sqlite'),
    PRIVATE_RECORDS_PATH: path.join(testRoot, 'records.json'),
    PRIVATE_TOKEN_CAPTURE_PATH: '',
    MONITOR_CACHE_PATH: cachePath,
    MONITOR_CACHE_MAX_MB: '4096',
    LOG_TO_FILE: 'false',
    DEBUG_BODY: 'false',
    UPSTREAM_BASE_URL: 'https://127.0.0.1:1',
  };
  child = spawn(process.execPath, [path.join(root, 'dist', 'index.js')], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await raw(publicPort, '/health')).status === 200) break;
      } catch { /* not listening yet */ }
      if (i > 60) throw new Error('gateway did not start');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const json = async (route, options) => {
      const response = await raw(publicPort, route, options);
      let parsed;
      try { parsed = JSON.parse(response.body.toString('utf8')); } catch { parsed = null; }
      return { ...response, data: parsed };
    };

    const setup = await json('/api/admin/auth/setup', {
      method: 'POST',
      body: { username: 'preview-owner', password: randomUUID(), adminToken: bootstrap },
      headers: { 'X-Admin-Request': '1' },
    });
    assert.equal(setup.status, 201, 'admin setup should succeed');
    const session = { Cookie: setup.headers['set-cookie'][0].split(';')[0], 'X-Admin-Request': '1' };
    const admin = (route, options = {}) => json('/api/admin/' + route, { ...options, headers: { ...session, ...options.headers } });

    // 1. The admin page must embed the preview and stay syntactically valid inline JS.
    const page = await raw(publicPort, '/admin');
    assert.equal(page.status, 200);
    const html = page.body.toString('utf8');
    for (const marker of ['id="previewDialog"', 'id="previewCanvas"', 'ChartPlayer', "monitor_client.js", 'previewAssetBase']) {
      assert.ok(html.includes(marker), `admin page must contain ${marker}`);
    }
    // Volume is added by a build-time patch to the upstream player, so both the control
    // and the API it drives have to be present.
    for (const marker of ['id="previewVolume"', 'set_volume']) {
      assert.ok(html.includes(marker), `admin page must contain ${marker}`);
    }
    // Regression guard: resuming used to re-seek with an extrapolated position, which
    // restarted the chart instead of continuing it.
    assert.ok(!html.includes('set_time(at)'), 'the resume path must not re-seek the player');
    // Regression guard: the skipped range has to be settled with autoplay off (silent
    // Miss bookkeeping) instead of firing one hitsound and particle burst per note.
    for (const marker of ['previewSilentCatchUp', 'set_autoplay(false)', 'pendingSeek']) {
      assert.ok(html.includes(marker), `admin page must contain ${marker}`);
    }
    // 1b. The renderer is an upstream build with deliberate patches. The wasm is a
    //     binary, so the browser cannot be asked whether they are present; the build script
    //     is checked instead, because silently dropping a patch there is the failure mode.
    const buildScript = fs.readFileSync(path.join(root, 'scripts', 'build-renderer.js'), 'utf8');
    for (const patch of ['GainNode', 'set_volume', 'clear(0.0, 0.0, 0.0, 0.0)', 'keep_below']) {
      assert.ok(buildScript.includes(patch), `scripts/build-renderer.js must still apply the ${patch} patch`);
    }
    console.log(`build patches: volume, transparent clear, kept hold head`);

    // Regression guard: abandoning a load (closing the dialog) used to leave the busy flag
    // set, so every later preview click was dropped without any feedback.
    for (const marker of ['PREVIEW.epoch', 'previewLoadChart', 'if(!dialog.open)return', 'PREVIEW.inflight']) {
      assert.ok(html.includes(marker), `admin page must contain ${marker}`);
    }
    // The background layer mirrors the reference player: blurred illustration, cover crop
    // and two shades (a fixed 0.3 plus the chart's own dim factor).
    for (const marker of ['id="previewBackground"', 'previewBackgroundBlur', 'backgroundDim', 'object-fit:cover', 'rgba(0,0,0,0.3)']) {
      assert.ok(html.includes(marker), `admin page must contain ${marker}`);
    }
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    assert.ok(scripts.length > 0, 'admin page must inline its script');
    for (const [index, code] of scripts.entries()) {
      try {
        new vm.Script(code, { filename: `admin-inline-${index}.js` });
      } catch (error) {
        throw new Error(`inline admin script #${index} does not parse: ${error.message}`);
      }
    }
    console.log(`admin page: ${scripts.length} inline script(s) parse, preview markup present`);

    // 2. Status reports the vendored engine and the payload cache.
    const status = await admin('monitor/status');
    assert.equal(status.status, 200, 'monitor status should be readable by an admin');
    assert.equal(status.data.available, true, 'chart-compiler must be present (run npm run build:renderer)');
    assert.ok(status.data.pkg.includes('monitor_client.js'), 'pkg must expose the WASM loader');
    assert.ok(status.data.pkg.includes('monitor_client_bg.wasm'), 'pkg must expose the WASM binary');
    assert.ok(Array.isArray(status.data.respack), 'respack list must be reported');
    assert.equal(status.data.cache.entries, 0, 'cache starts empty');
    assert.match(status.data.version, /^[a-f0-9]{12}$/, 'renderer assets must be versioned for cache busting');
    console.log(`status: pkg=${status.data.pkg.length} files, respack=${status.data.respack.length} files, version=${status.data.version}`);

    // 3. Static engine assets are served with the types a browser module loader needs,
    //    both at the versioned URL the client uses and at the bare one.
    const version = status.data.version;
    for (const route of [`monitor/pkg/${version}/monitor_client_bg.wasm`, 'monitor/pkg/monitor_client_bg.wasm']) {
      const wasm = await admin(route);
      assert.equal(wasm.status, 200, `${route} should be served`);
      assert.match(wasm.headers['content-type'], /application\/wasm/);
      assert.equal(wasm.body.subarray(0, 4).toString('hex'), '0061736d', 'must start with the WASM magic number');
    }
    const loader = await admin(`monitor/pkg/${version}/monitor_client.js`);
    assert.equal(loader.status, 200);
    assert.match(loader.headers['content-type'], /text\/javascript/);
    assert.match(loader.body.toString('utf8'), /export/, 'the loader must be an ES module');
    assert.match(loader.body.toString('utf8'), /set_volume/, 'the volume patch must be compiled in');
    // The loader derives the binary URL from its own module URL, so the version segment
    // has to survive that resolution.
    assert.match(loader.body.toString('utf8'), /new URL\('monitor_client_bg\.wasm', import\.meta\.url\)/);
    const respack = await admin(`monitor/respack/${version}/info.yml`);
    assert.equal(respack.status, 200, 'the versioned respack path must work too');
    console.log(`assets: wasm ${loader.body.length} B loader, versioned URL resolves`);

    // 4. The payload the player fetches must be a real compiled chart.
    const chartId = -1;
    const pezSize = fs.statSync(path.join(chartsPath, String(chartId), 'chart-package.pez')).size;
    const first = await admin(`monitor/i/default/chart/${chartId}`);
    assert.equal(first.status, 200, 'chart payload should compile');
    assert.match(first.headers['content-type'], /application\/octet-stream/);
    assert.ok(first.body.length > 1024 * 1024, `payload should be substantial, got ${first.body.length} B`);
    // bincode with varint encoding starts with the length prefix of the first String field.
    assert.ok(first.body.length > pezSize, 'decoded payload must be larger than the compressed package');
    assert.ok(first.headers.etag, 'payload must carry a validator so repeat previews are cheap');
    console.log(`chart #${chartId}: pez ${(pezSize / 1048576).toFixed(1)} MB -> payload ${(first.body.length / 1048576).toFixed(1)} MB`);

    // 5. Cached summary gives the UI a duration and note count.
    const meta = await admin(`monitor/i/default/meta/${chartId}`);
    assert.equal(meta.status, 200, 'summary should exist after compiling');
    assert.equal(meta.data.ok, true);
    assert.equal(typeof meta.data.duration, 'number');
    assert.ok(meta.data.duration > 10, 'duration should be plausible');
    assert.ok(meta.data.notes > 0, 'chart should contain notes');
    assert.equal(meta.data.bytes, first.body.length, 'summary size must match the payload');
    // The playable length must cover the music and the chart content (including a
    // trailing hold), not stop at the last note's start time.
    assert.ok(meta.data.musicSeconds > 0, 'music length must be reported');
    assert.ok(meta.data.chartEnd > 0, 'chart content end must be reported');
    assert.ok(meta.data.chartEnd >= meta.data.lastNote, 'chart end must cover the last note');
    assert.ok(Math.abs(meta.data.duration - Math.max(meta.data.musicSeconds, meta.data.chartEnd)) < 0.01, 'playable length must be max(music, chart end)');
    assert.ok(meta.data.duration > meta.data.lastNote, 'playable length must outlast the last note start');
    console.log(`meta #${chartId}: "${meta.data.name}" ${meta.data.duration.toFixed(1)}s (music ${meta.data.musicSeconds.toFixed(1)}s, chart ${meta.data.chartEnd.toFixed(1)}s, last note ${meta.data.lastNote.toFixed(1)}s), ${meta.data.notes} notes, ${meta.data.lines} lines`);

    // 5b. The playfield background: the packaged illustration, exported next to the payload
    // and served under a revision-keyed URL.
    assert.match(meta.data.backgroundExtension, /^(jpg|jpeg|png|gif|webp|avif)$/, 'the illustration must be exported in a displayable format');
    assert.equal(typeof meta.data.backgroundDim, 'number', 'the dim factor must be reported');
    assert.ok(meta.data.revision, 'the summary must carry a revision for immutable background URLs');
    const background = await admin(`monitor/i/default/background/${chartId}`);
    assert.equal(background.status, 200, 'the illustration must be served');
    assert.match(background.headers['content-type'], /^image\//);
    assert.ok(background.body.length > 4096, `illustration should be a real image, got ${background.body.length} B`);
    console.log(`background #${chartId}: ${background.headers['content-type']} ${(background.body.length / 1024).toFixed(0)} KB, dim ${meta.data.backgroundDim}`);

    // 6. A second request is served from the cache, byte for byte.
    const second = await admin(`monitor/i/default/chart/${chartId}`);
    assert.equal(second.status, 200);
    assert.ok(second.body.equals(first.body), 'cached payload must be identical');
    const after = await admin('monitor/status');
    assert.equal(after.data.cache.entries, 1, 'exactly one cached payload');
    assert.equal(after.data.cache.bytes, first.body.length);
    console.log(`cache: 1 entry, ${(after.data.cache.bytes / 1048576).toFixed(1)} MB`);

    // 7. Conditions of use: conditional requests, auth, missing charts, traversal.
    const revalidated = await admin(`monitor/i/default/chart/${chartId}`, { headers: { 'If-None-Match': first.headers.etag } });
    assert.equal(revalidated.status, 304, 'matching validator must yield 304');
    assert.equal((await json('/api/admin/monitor/status')).status, 401, 'no session must not read monitor endpoints');
    assert.equal((await admin('monitor/i/default/chart/-999999')).status, 404, 'unknown chart must be 404');
    assert.equal((await admin('monitor/i/missing/chart/-1')).status, 403, 'unknown instance must not resolve');
    assert.equal((await admin('monitor/pkg/..%2F..%2Fpackage.json')).status, 404, 'path traversal must be refused');
    console.log('guards: 304 revalidation, 401 without session, 404 unknown chart, 403 unknown instance, traversal refused');

    console.log('\nmonitor preview: all checks passed');
  } finally {
    // Cleanup must never mask a real failure: on Windows the killed server can hold
    // SQLite and payload files open for a moment, so retry and then give up quietly.
    child.kill();
    for (let i = 0; i < 12; i++) {
      try {
        fs.rmSync(testRoot, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
}

main().catch((error) => {
  console.error(`\nmonitor preview test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
