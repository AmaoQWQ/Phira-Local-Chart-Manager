const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { deflateRawSync } = require("node:zlib");

const root = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phira-private-zip-http-"));
let child;
let childOutput = "";

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(port, route, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: "127.0.0.1",
      port,
      path: route,
      method,
      rejectUnauthorized: false,
      headers: { "Content-Length": data.length, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
    setTimeout(resolve, 2000);
  });
}

async function main() {
  const publicPort = await unusedPort();
  const adminPort = await unusedPort();
  const adminToken = randomUUID();
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(publicPort),
    ADMIN_PORT: String(adminPort),
    MULTIPLAYER_ENABLED: "false",
    ADMIN_TOKEN: adminToken,
    INSTANCE_REGISTRY_PATH: path.join(tempRoot, "instances.json"),
    PRIVATE_CHARTS_PATH: path.join(tempRoot, "charts"),
    PRIVATE_RECORDS_DB_PATH: path.join(tempRoot, "records.sqlite"),
    PRIVATE_RECORDS_PATH: path.join(tempRoot, "records.json"),
    PRIVATE_TOKEN_CAPTURE_PATH: "",
    LOG_TO_FILE: "false",
    DEBUG_BODY: "false",
    UPSTREAM_BASE_URL: "https://127.0.0.1:1",
    TLS_CERT_PATH: path.join(root, "certs", "server.crt"),
    TLS_KEY_PATH: path.join(root, "certs", "server.key"),
  };
  child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { childOutput += chunk.toString(); });
  child.stderr.on("data", (chunk) => { childOutput += chunk.toString(); });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const health = await request(publicPort, "/health", "GET");
        if (health.status === 200) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "Gateway did not start");

    const password = randomUUID();
    const setup = await request(publicPort, "/api/admin/auth/setup", "POST", {
      username: "zip-limit-admin",
      password,
      adminToken,
    }, { "X-Admin-Request": "1" });
    assert.equal(setup.status, 201, setup.text);
    const cookie = setup.headers["set-cookie"]?.[0]?.split(";")[0];
    assert.ok(cookie, "admin session cookie was not set");

    const data = Buffer.alloc(128 * 1024 * 1024 + 1);
    const compressed = deflateRawSync(data);
    const name = Buffer.from("oversized.bin");
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const localData = Buffer.concat([local, compressed]);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    name.copy(central, 46);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(localData.length, 16);
    const packageFile = Buffer.concat([localData, central, end]);
    const upload = await request(publicPort, "/api/admin/charts", "POST", {
      id: -901,
      packageBase64: packageFile.toString("base64"),
    }, {
      Cookie: cookie,
      "X-CSRF-Token": setup.json.csrf,
      "X-Admin-Request": "1",
    });
    assert.equal(upload.status, 413, upload.text);
    assert.match(upload.json.error, /128 MiB/);
    assert.equal(fs.existsSync(path.join(tempRoot, "charts", "-901")), false, "rejected upload wrote a chart directory");
    console.log("Private ZIP HTTP test passed: ZIP size violations return HTTP 413 before chart files are written.");
  } catch (error) {
    throw new Error(`${error.message || error}${childOutput ? `\n${childOutput}` : ""}`);
  } finally {
    await stopServer();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
