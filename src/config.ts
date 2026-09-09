import fs from "node:fs";
import path from "node:path";

export interface Config {
  host: string;
  port: number;
  adminPort: number;
  multiplayerEnabled: boolean;
  multiplayerHost: string;
  multiplayerPort: number;
  upstreamBaseUrl: string;
  privateChartsPath: string;
  instancesPath: string;
  privateChartListing: boolean;
  privateRecordsPath: string;
  privateRecordsDatabasePath: string;
  privateRecordVerificationKeyPath: string | null;
  privateTokenCapturePath: string | null;
  adminToken: string;
  certPath: string;
  keyPath: string;
  logToFile: boolean;
  logFilePath: string;
  debugBody: boolean;
  debugBodyMaxBytes: number;
}

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function resolveFromProjectRoot(value: string): string {
  return path.resolve(process.cwd(), value);
}

function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

export function loadConfig(): Config {
  loadDotEnv();
  return {
    host: process.env.HOST || "0.0.0.0",
    port: positiveIntegerFromEnv("PORT", 443),
    adminPort: positiveIntegerFromEnv("ADMIN_PORT", 9000),
    multiplayerEnabled: booleanFromEnv("MULTIPLAYER_ENABLED", true),
    multiplayerHost: process.env.MULTIPLAYER_HOST || "0.0.0.0",
    multiplayerPort: positiveIntegerFromEnv("MULTIPLAYER_PORT", 12348),
    upstreamBaseUrl: process.env.UPSTREAM_BASE_URL || "https://phira.5wyxi.com",
    privateChartsPath: resolveFromProjectRoot(process.env.PRIVATE_CHARTS_PATH || "data/private-charts"),
    instancesPath: resolveFromProjectRoot(process.env.INSTANCE_REGISTRY_PATH || "data/instances/instances.json"),
    // No chart assets are bundled in the public template. Enable listing only
    // after configuring a locally owned chart package and its metadata.
    privateChartListing: booleanFromEnv("PRIVATE_CHART_LISTING", false),
    privateRecordsPath: resolveFromProjectRoot(process.env.PRIVATE_RECORDS_PATH || "data/private-records/records.json"),
    privateRecordsDatabasePath: resolveFromProjectRoot(process.env.PRIVATE_RECORDS_DB_PATH || "data/private-records/records.sqlite"),
    privateRecordVerificationKeyPath: process.env.PRIVATE_RECORD_VERIFICATION_KEY_PATH
      ? resolveFromProjectRoot(process.env.PRIVATE_RECORD_VERIFICATION_KEY_PATH)
      : resolveFromProjectRoot("decoder/record-verification-key.bin"),
    privateTokenCapturePath: process.env.PRIVATE_TOKEN_CAPTURE_PATH
      ? resolveFromProjectRoot(process.env.PRIVATE_TOKEN_CAPTURE_PATH)
      : null,
    adminToken: process.env.ADMIN_TOKEN || "",
    certPath: resolveFromProjectRoot(process.env.TLS_CERT_PATH || "certs/server.crt"),
    keyPath: resolveFromProjectRoot(process.env.TLS_KEY_PATH || "certs/server.key"),
    logToFile: booleanFromEnv("LOG_TO_FILE", false),
    logFilePath: resolveFromProjectRoot(process.env.LOG_FILE_PATH || "logs/requests.log"),
    debugBody: booleanFromEnv("DEBUG_BODY", false),
    debugBodyMaxBytes: Math.min(positiveIntegerFromEnv("DEBUG_BODY_MAX_BYTES", 4096), 4096),
  };
}
