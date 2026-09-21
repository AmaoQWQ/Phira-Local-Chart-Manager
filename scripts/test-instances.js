const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const testRoot = path.join(root, "data", "test-instances");
const registryPath = path.join(testRoot, "instances.json");
const previousRegistry = fs.existsSync(registryPath) ? fs.readFileSync(registryPath) : null;
const temporaryDataPath = testRoot;
const node = process.execPath;
const env = {
  ...process.env,
  PORT: "18443",
  ADMIN_PORT: "19000",
  MULTIPLAYER_ENABLED: "false",
  INSTANCE_REGISTRY_PATH: "data/test-instances/instances.json",
  PRIVATE_RECORDS_DB_PATH: "data/test-instances/default/records.sqlite",
  PRIVATE_RECORDS_PATH: "data/test-instances/default/records.json",
};
const tokenLine = fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/).find((line) => /^ADMIN_TOKEN=/.test(line));
if (!tokenLine) throw new Error("ADMIN_TOKEN missing from .env");
const token = tokenLine.slice("ADMIN_TOKEN=".length).trim().replace(/^['"]|['"]$/g, "");
const child = spawn(node, [path.join(root, "dist", "index.js")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let childOutput = "";
child.stdout.on("data", (chunk) => { childOutput += chunk.toString(); });
child.stderr.on("data", (chunk) => { childOutput += chunk.toString(); });

const headers = { Authorization: `Bearer ${token}` };
async function api(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      return payload;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

(async () => {
  try {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const instances = await api("http://127.0.0.1:19000/api/admin/instances");
    if (!instances.some((item) => item.id === "default")) throw new Error("default instance missing");
    const created = await api("http://127.0.0.1:19000/api/admin/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "test-instance", name: "Test Instance", hosts: ["test-instance.local"], enabled: true }),
    });
    await api("http://127.0.0.1:19000/api/admin/instances/test-instance", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "X-Admin-Reason": encodeURIComponent("Update regression instance"),
      },
      body: JSON.stringify({ name: "Updated Test", hosts: ["test-instance.local"], enabled: false }),
    });
    const dashboard = await api("http://127.0.0.1:19000/api/admin/dashboard?instance=test-instance");
    if (dashboard.instance?.id !== "test-instance") throw new Error("instance selection failed");
    await api("http://127.0.0.1:19000/api/admin/instances/test-instance", {
      method: "DELETE",
      headers: {
        "X-Admin-Reason": encodeURIComponent("Delete regression instance"),
        "X-Admin-Confirm": "test-instance",
      },
    });
    console.log(`instance API test passed; default=default; created=${created.id}; selected=${dashboard.instance.id}`);
  } finally {
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", resolve);
      child.kill();
      setTimeout(resolve, 1500);
    });
    fs.rmSync(temporaryDataPath, { recursive: true, force: true });
    if (previousRegistry === null) fs.rmSync(registryPath, { force: true });
    else fs.writeFileSync(registryPath, previousRegistry);
  }
})().catch((error) => {
  console.error(`${error.message || error}${childOutput ? `\n${childOutput}` : ""}`);
  process.exitCode = 1;
});
