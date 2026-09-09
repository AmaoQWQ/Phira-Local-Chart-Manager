const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const distEntry = path.join(projectRoot, "dist", "index.js");
const pidFile = path.join(projectRoot, ".phira-api-probe.pid");
const serverLog = path.join(projectRoot, "logs", "server.log");
const serverErrorLog = path.join(projectRoot, "logs", "server-error.log");

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
  const certPath = path.resolve(projectRoot, process.env.TLS_CERT_PATH || "certs/server.crt");
  const keyPath = path.resolve(projectRoot, process.env.TLS_KEY_PATH || "certs/server.key");
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

function start() {
  const existingPid = readPid();
  if (existingPid && processExists(existingPid)) {
    console.log(`Phira API Probe is already running (PID ${existingPid}).`);
    return;
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
    env: process.env,
    stdio: ["ignore", output, errors],
    windowsHide: true,
  });

  child.unref();
  fs.closeSync(output);
  fs.closeSync(errors);
  fs.writeFileSync(pidFile, `${child.pid}\n`, "utf8");
  console.log(`Phira API Probe started in the background (PID ${child.pid}).`);
  console.log(`Server output: ${serverLog}`);
}

function stop() {
  const pid = readPid();
  if (!pid) {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    console.log("Phira API Probe is not running.");
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

  fs.unlinkSync(pidFile);
  console.log(`Phira API Probe stopped (PID ${pid}).`);
}

const command = process.argv[2];
if (command === "start") {
  start();
} else if (command === "stop") {
  stop();
} else {
  console.error(`Usage: node ${path.relative(process.cwd(), __filename)} <start|stop>`);
  process.exitCode = 1;
}
