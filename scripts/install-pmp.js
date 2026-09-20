const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repository = "AmaoQWQ/Phira-mp-plus";
const version = "v1.0.49";
const projectRoot = path.resolve(__dirname, "..");
const runtimeRoot = path.join(projectRoot, "pmp-runtime");
const binRoot = path.join(runtimeRoot, "bin");
const configPath = path.join(runtimeRoot, "server_config.yml");
const configExample = path.join(projectRoot, "config", "pmp-server.example.yml");
const legacyConfig = path.join(projectRoot, "mp-server", "server_config.yml");

function releaseAsset() {
  if (process.platform === "win32" && process.arch === "x64") {
    return {
      name: "phira-mp-plus-server-windows-x86_64",
      executable: "phira-mp-plus-server.exe",
    };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return {
      name: "phira-mp-plus-server-linux-musl",
      executable: "phira-mp-plus-server",
    };
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return {
      name: "phira-mp-plus-server-linux-arm64-musl",
      executable: "phira-mp-plus-server",
    };
  }
  throw new Error(`PMP+ ${version} 没有适用于 ${process.platform}/${process.arch} 的预编译包；请按 README 从源码编译。`);
}

async function download(name) {
  const url = `https://github.com/${repository}/releases/download/${version}/${name}`;
  const response = await fetch(url, {
    headers: { "user-agent": "phira-local-chart-manager-pmp-installer" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`下载 ${url} 失败：HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function expectedChecksum(checksums, assetName) {
  const line = checksums
    .toString("utf8")
    .split(/\r?\n/)
    .find((entry) => entry.trim().endsWith(`  ${assetName}`));
  const match = line && /^([a-fA-F0-9]{64})\s+/.exec(line);
  if (!match) throw new Error(`SHA256SUMS 中找不到 ${assetName}`);
  return match[1].toLowerCase();
}

async function main() {
  const asset = releaseAsset();
  console.log(`正在安装 ${repository} ${version}（${asset.name}）...`);
  const [binary, checksums] = await Promise.all([download(asset.name), download("SHA256SUMS")]);
  const expected = expectedChecksum(checksums, asset.name);
  const actual = crypto.createHash("sha256").update(binary).digest("hex");
  if (actual !== expected) throw new Error(`校验失败：期望 ${expected}，实际 ${actual}`);

  fs.mkdirSync(binRoot, { recursive: true });
  const executablePath = path.join(binRoot, asset.executable);
  const temporaryPath = `${executablePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, binary, { mode: 0o755 });
    if (fs.existsSync(executablePath)) fs.rmSync(executablePath);
    fs.renameSync(temporaryPath, executablePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath);
  }

  let configSource = "existing";
  if (!fs.existsSync(configPath)) {
    const source = fs.existsSync(legacyConfig) ? legacyConfig : configExample;
    fs.copyFileSync(source, configPath);
    configSource = source === legacyConfig ? "legacy" : "example";
  }
  fs.writeFileSync(path.join(runtimeRoot, "VERSION"), `${version}\n`, "utf8");

  console.log(`PMP+ 已安装到 ${path.relative(projectRoot, executablePath)}`);
  console.log(`SHA-256 校验通过：${actual}`);
  if (configSource === "legacy") {
    console.log("已迁移旧 mp-server/server_config.yml，请核对配置后启动。");
  } else if (configSource === "example") {
    console.log(`已生成 ${path.relative(projectRoot, configPath)}；启动前请填写 database_url。`);
  } else {
    console.log(`保留现有配置：${path.relative(projectRoot, configPath)}`);
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
