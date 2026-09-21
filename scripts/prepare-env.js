const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const minimumNode = [22, 13, 0];
const currentNode = process.versions.node.split(".").map(Number);
let nodeIsSupported = true;
for (let index = 0; index < minimumNode.length; index++) {
  if (currentNode[index] > minimumNode[index]) break;
  if (currentNode[index] < minimumNode[index]) {
    nodeIsSupported = false;
    break;
  }
}

if (!nodeIsSupported) {
  console.error(`[ERROR] Node.js ${process.versions.node} is too old. Install Node.js 22.13 or newer.`);
  process.exitCode = 1;
  return;
}

const projectRoot = path.resolve(__dirname, "..");
const envPath = path.join(projectRoot, ".env");
const examplePath = path.join(projectRoot, ".env.example");
const placeholderAdminTokens = new Set(["", "replace-with-a-long-random-admin-token", "请替换为一串足够长的随机字符"]);

function readValue(source, name) {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, "m").exec(source);
  if (!match) return "";
  const value = match[1];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function replaceValue(source, name, value) {
  const pattern = new RegExp(`^${name}=.*$`, "m");
  if (!pattern.test(source)) throw new Error(`${name} is missing from .env.example`);
  return source.replace(pattern, `${name}=${value}`);
}

if (fs.existsSync(envPath)) {
  const existing = fs.readFileSync(envPath, "utf8");
  if (placeholderAdminTokens.has(readValue(existing, "ADMIN_TOKEN"))) {
    console.error("[ERROR] .env exists, but ADMIN_TOKEN is empty or still uses the example value.");
    console.error("        Replace ADMIN_TOKEN with a long random value, then start again.");
    process.exitCode = 1;
    return;
  }
  console.log("Using existing .env configuration.");
  return;
}

if (!fs.existsSync(examplePath)) {
  console.error("[ERROR] .env.example was not found; cannot create the first-run configuration.");
  process.exitCode = 1;
  return;
}

try {
  let configured = fs.readFileSync(examplePath, "utf8");
  configured = replaceValue(configured, "ADMIN_TOKEN", crypto.randomBytes(32).toString("base64url"));
  configured = replaceValue(configured, "PMP_ADMIN_TOKEN", crypto.randomBytes(32).toString("base64url"));
  configured = replaceValue(configured, "HSN_SECRET_KEY", crypto.randomBytes(32).toString("base64url"));
  fs.writeFileSync(envPath, configured, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log("Created .env with unique ADMIN_TOKEN, PMP_ADMIN_TOKEN, and HSN_SECRET_KEY values.");
  console.log("Open .env to view ADMIN_TOKEN before initializing the first administrator.");
} catch (error) {
  console.error(`[ERROR] Could not create .env: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
}
