const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const pmpRoot = path.join(projectRoot, "mp-server");
const executableName = process.platform === "win32" ? "phira-mp-plus-server.exe" : "phira-mp-plus-server";
const pmpExecutable = path.join(pmpRoot, "target", "release", executableName);
const pmpConfig = path.join(pmpRoot, "server_config.yml");
const pidFile = path.join(projectRoot, ".phira-pmp-plus.pid");
const outputLog = path.join(projectRoot, "logs", "pmp-server.log");
const errorLog = path.join(projectRoot, "logs", "pmp-server-error.log");

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
    return Boolean(error && error.code === "EPERM");
  }
}

function removePidFile() {
  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
}

function readConfiguredPort(name, fallback) {
  if (!fs.existsSync(pmpConfig)) return fallback;
  const source = fs.readFileSync(pmpConfig, "utf8");
  const match = source.match(new RegExp(`^${name}:\\s*(\\d+)\\s*$`, "m"));
  if (!match) return fallback;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : fallback;
}

const gamePort = readConfiguredPort("port", 12356);
const httpPort = readConfiguredPort("http_port", 12357);

function portIsOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function portIsListening(port) {
  if (process.platform !== "win32") return portIsOpen(port);
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$listener = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue; if ($listener) { 'true' }`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  return result.status === 0 && result.stdout.trim() === "true";
}

async function waitForPorts(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    // Poll only the HTTP listener. Opening and immediately closing the binary
    // game protocol port is logged by PMP+ as a malformed client session.
    if ((await portIsOpen(httpPort)) && (await portIsListening(gamePort))) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return false;
}

function persistentUserVariable(name) {
  if (process.platform !== "win32") return "";
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Environment]::GetEnvironmentVariable('${name}', 'User')`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  return result.status === 0 ? result.stdout.trim() : "";
}

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

function pmpEnvironment() {
  const environment = { ...process.env };
  loadProjectDotEnv(environment);
  // The Gateway may use a dedicated PMP token. PMP+ itself reads ADMIN_TOKEN.
  if (environment.PMP_ADMIN_TOKEN) environment.ADMIN_TOKEN = environment.PMP_ADMIN_TOKEN;
  if (!environment.HSN_SECRET_KEY) {
    environment.HSN_SECRET_KEY = persistentUserVariable("HSN_SECRET_KEY");
  }
  if (!environment.HSN_SECRET_KEY) {
    throw new Error("HSN_SECRET_KEY 未设置，拒绝以临时节点身份启动 PMP+");
  }
  return environment;
}

async function start() {
  const existingPid = readPid();
  if (existingPid && processExists(existingPid)) {
    if (await waitForPorts(5_000)) {
      console.log(`PMP+ 已在运行（PID ${existingPid}，TCP ${gamePort}，HTTP ${httpPort}）。`);
      return;
    }
    throw new Error(`PMP+ 进程 ${existingPid} 存在，但端口未就绪；请检查 ${errorLog}`);
  }
  if (existingPid) removePidFile();

  const gamePortOccupied = await portIsListening(gamePort);
  const httpPortOccupied = await portIsListening(httpPort);
  if (gamePortOccupied || httpPortOccupied) {
    if (gamePortOccupied && httpPortOccupied) {
      console.log(`PMP+ 端口已由外部进程监听（TCP ${gamePort}，HTTP ${httpPort}），跳过重复启动。`);
      return;
    }
    throw new Error(`PMP+ 端口状态不完整：TCP ${gamePort}=${gamePortOccupied}，HTTP ${httpPort}=${httpPortOccupied}`);
  }

  if (!fs.existsSync(pmpExecutable)) throw new Error(`找不到 PMP+ 可执行文件：${pmpExecutable}`);
  if (!fs.existsSync(pmpConfig)) throw new Error(`找不到 PMP+ 配置文件：${pmpConfig}`);

  fs.mkdirSync(path.dirname(outputLog), { recursive: true });
  const output = fs.openSync(outputLog, "a");
  const errors = fs.openSync(errorLog, "a");
  const child = spawn(pmpExecutable, ["--config", pmpConfig, "--no-cli"], {
    cwd: pmpRoot,
    detached: true,
    env: pmpEnvironment(),
    stdio: ["ignore", output, errors],
    windowsHide: true,
  });

  child.unref();
  fs.closeSync(output);
  fs.closeSync(errors);
  fs.writeFileSync(pidFile, `${child.pid}\n`, "utf8");

  if (!(await waitForPorts(20_000))) {
    if (!processExists(child.pid)) removePidFile();
    throw new Error(`PMP+ 未能在 20 秒内启动；请检查 ${errorLog} 和 ${outputLog}`);
  }

  console.log(`PMP+ 已启动（PID ${child.pid}，TCP ${gamePort}，HTTP ${httpPort}）。`);
  console.log(`PMP+ 日志：${outputLog}`);
}

async function startOptional() {
  try {
    await start();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.warn(`PMP+ 未启动：${message}`);
    console.warn("快速启动将继续启动网页管理服务；多人房间功能暂不可用。");
    console.warn("如需 PMP+，请按 README 编译 mp-server 并完成配置。");
  }
}

async function stop() {
  const pid = readPid();
  if (!pid) {
    console.log("没有由本项目托管的 PMP+ 进程。");
    return;
  }
  if (!processExists(pid)) {
    removePidFile();
    console.log(`已清理失效的 PMP+ PID 文件（PID ${pid}）。`);
    return;
  }

  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (processExists(pid)) throw new Error(`PMP+ 进程 ${pid} 未能在 15 秒内停止`);
  removePidFile();
  console.log(`PMP+ 已停止（PID ${pid}）。`);
}

async function status() {
  const pid = readPid();
  const processRunning = Boolean(pid && processExists(pid));
  const gamePortOpen = await portIsListening(gamePort);
  const httpPortOpen = await portIsListening(httpPort);
  console.log(`PMP+ 进程：${processRunning ? `运行中（PID ${pid}）` : "未运行或未由本项目托管"}`);
  console.log(`游戏 TCP ${gamePort}：${gamePortOpen ? "已监听" : "未监听"}`);
  console.log(`管理 HTTP ${httpPort}：${httpPortOpen ? "已监听" : "未监听"}`);
  if (!gamePortOpen || !httpPortOpen) process.exitCode = 1;
}

async function main() {
  const command = process.argv[2];
  if (command === "start") return start();
  if (command === "start-optional") return startOptional();
  if (command === "stop") return stop();
  if (command === "status") return status();
  throw new Error(`用法：node ${path.relative(process.cwd(), __filename)} <start|start-optional|stop|status>`);
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
