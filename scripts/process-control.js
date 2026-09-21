const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const distEntry = path.join(projectRoot, "dist", "index.js");
const pidFile = path.join(projectRoot, ".phira-local-chart-manager.pid");
const serverLog = path.join(projectRoot, "logs", "server.log");
const serverErrorLog = path.join(projectRoot, "logs", "server-error.log");

function loadProjectDotEnv(environment) {
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || environment[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    environment[match[1]] = value;
  }
}

function positivePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

const runtimeEnvironment = { ...process.env };
loadProjectDotEnv(runtimeEnvironment);
const adminPort = positivePort(runtimeEnvironment.ADMIN_PORT, 9000);

function readPid() {
  if (!fs.existsSync(pidFile)) return null;
  const value = Number(fs.readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function ensureCertificateExists() {
  const certPath = path.resolve(projectRoot, runtimeEnvironment.TLS_CERT_PATH || "certs/server.crt");
  const keyPath = path.resolve(projectRoot, runtimeEnvironment.TLS_KEY_PATH || "certs/server.key");
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return true;

  console.error("TLS certificate or key not found.");
  console.error("Run: npm run cert:generate");
  return false;
}

function ensureBuildExists() {
  if (fs.existsSync(distEntry)) return true;

  console.log("dist/index.js not found; building the project first...");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "build"], {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  return result.status === 0 && fs.existsSync(distEntry);
}

function adminHealthIsReady(timeoutMs = 750) {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port: adminPort, path: "/health", timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

async function waitForReady(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processExists(pid)) return false;
    if (await adminHealthIsReady()) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return processExists(pid) && await adminHealthIsReady();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  return false;
}

async function start() {
  const existingPid = readPid();
  if (existingPid && processExists(existingPid)) {
    if (await waitForReady(existingPid, 2_000)) {
      console.log(`Phira 本地谱面管理系统已在运行（PID ${existingPid}）。`);
      return;
    }
    throw new Error(`Gateway 进程 ${existingPid} 存在，但管理端口 ${adminPort} 未就绪；请检查 ${serverErrorLog}`);
  }
  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);

  if (!ensureCertificateExists() || !ensureBuildExists()) {
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(serverLog), { recursive: true });
  const output = fs.openSync(serverLog, "a");
  const errors = fs.openSync(serverErrorLog, "a");
  const child = spawn(process.execPath, [distEntry], {
    cwd: projectRoot,
    detached: true,
    env: runtimeEnvironment,
    stdio: ["ignore", output, errors],
    windowsHide: true,
  });

  child.unref();
  fs.closeSync(output);
  fs.closeSync(errors);
  fs.writeFileSync(pidFile, `${child.pid}\n`, "utf8");

  if (!(await waitForReady(child.pid, 15_000))) {
    if (processExists(child.pid)) process.kill(child.pid, "SIGTERM");
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    throw new Error(`Gateway 未能在 15 秒内启动；请检查 ${serverErrorLog} 和 ${serverLog}`);
  }
  console.log(`Phira 本地谱面管理系统已在后台启动（PID ${child.pid}）。`);
  console.log(`服务日志：${serverLog}`);
}

async function stop() {
  const pid = readPid();
  if (!pid) {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    console.log("Phira 本地谱面管理系统未在运行。");
    return;
  }

  if (!processExists(pid)) {
    fs.unlinkSync(pidFile);
    console.log(`Removed stale PID file (PID ${pid}).`);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    console.error(`Could not stop PID ${pid}: ${error.message || error}`);
    process.exitCode = 1;
    return;
  }

  const deadline = Date.now() + 15_000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (processExists(pid)) throw new Error(`Gateway 进程 ${pid} 未能在 15 秒内停止`);
  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  console.log(`Phira 本地谱面管理系统已停止（PID ${pid}）。`);
}

async function main() {
  const command = process.argv[2];
  if (command === "start") return start();
  if (command === "stop") return stop();
  throw new Error(`Usage: node ${path.relative(process.cwd(), __filename)} <start|stop>`);
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
