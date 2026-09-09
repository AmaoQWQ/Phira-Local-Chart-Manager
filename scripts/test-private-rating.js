const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const testRoot = path.join(root, "data", "test-private-rating");
const recordsPath = path.join(testRoot, "records.json");
const port = 18444;
const chartId = JSON.parse(fs.readFileSync(path.join(root, "data", "private-charts", "charts.json"), "utf8")).charts[0].id;

function request(method, requestPath, authorization, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const headers = { "Content-Length": Buffer.byteLength(body) };
    if (authorization) headers.Authorization = authorization;
    if (body) headers["Content-Type"] = "application/json";
    const request = https.request({ hostname: "127.0.0.1", port, path: requestPath, method, rejectUnauthorized: false, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await request("GET", "/health");
      if (response.status === 200) return;
    } catch {
      // The child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("test Gateway did not start");
}

async function stopChild(child) {
  if (child.exitCode === null && !child.killed) child.kill();
  if (child.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

function json(response) {
  return JSON.parse(response.body);
}

async function main() {
  fs.rmSync(testRoot, { recursive: true, force: true });
  const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_PORT: "19001",
      MULTIPLAYER_PORT: "12350",
      INSTANCE_REGISTRY_PATH: path.join(testRoot, "instances.json"),
      PRIVATE_CHARTS_PATH: path.join(root, "data", "private-charts"),
      PRIVATE_RECORDS_PATH: recordsPath,
      PRIVATE_RECORDS_DB_PATH: path.join(testRoot, "records.sqlite"),
      PRIVATE_TOKEN_CAPTURE_PATH: "",
      PRIVATE_CHART_LISTING: "false",
    },
  });
  let childError = "";
  child.stderr.on("data", (chunk) => { childError += chunk.toString(); });
  try {
    await waitForServer();
    const userA = "Bearer private-rating-user-a";
    const userB = "Bearer private-rating-user-b";
    const initial = await request("GET", `/chart/${chartId}/rate`, userA);
    if (initial.status !== 200 || json(initial).score !== 0) throw new Error("initial rating assertion failed");
    const submittedA = await request("POST", `/chart/${chartId}/rate`, userA, { score: 8 });
    const submittedB = await request("POST", `/chart/${chartId}/rate`, userB, { score: 10 });
    const chartAfterTwo = await request("GET", `/chart/${chartId}`);
    const ownAfterSubmit = await request("GET", `/chart/${chartId}/rate`, userA);
    if (submittedA.status !== 200 || submittedB.status !== 200 || ownAfterSubmit.status !== 200 || json(ownAfterSubmit).score !== 8) {
      throw new Error("rating submit assertion failed");
    }
    const chartJson = json(chartAfterTwo);
    if (chartAfterTwo.status !== 200 || chartJson.rating !== 0.9 || chartJson.ratingCount !== 2) {
      throw new Error(`rating aggregate assertion failed: ${JSON.stringify({ status: chartAfterTwo.status, rating: chartJson.rating, ratingCount: chartJson.ratingCount })}`);
    }
    const removedA = await request("DELETE", `/chart/${chartId}/rate`, userA);
    const chartAfterDelete = json(await request("GET", `/chart/${chartId}`));
    if (removedA.status !== 200 || chartAfterDelete.rating !== 1 || chartAfterDelete.ratingCount !== 1) {
      throw new Error("rating delete assertion failed");
    }
    const removedB = await request("POST", `/chart/${chartId}/rate`, userB, { score: 0 });
    const chartAfterClear = json(await request("GET", `/chart/${chartId}`));
    if (removedB.status !== 200 || chartAfterClear.rating !== null || chartAfterClear.ratingCount !== 0) {
      throw new Error("rating clear assertion failed");
    }
    console.log(JSON.stringify({ ok: true, chart: chartId, scoreScale: "0-10", averageScale: "0-1", submitted: [8, 10], deleted: true }));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${childError ? `; child=${childError.trim()}` : ""}`);
  } finally {
    await stopChild(child);
    fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
