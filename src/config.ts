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
  /** Optional external origin embedded in private chart resource URLs; otherwise follows the request Host. */
  publicBaseUrl: string | null;
  /** Optional dedicated hostname that serves the browser homepage. */
  homepageHost: string | null;
  /** Deployment-specific player guide; kept outside Git when it contains a real IP. */
  userGuidePath: string;
  privateChartsPath: string;
  instancesPath: string;
  privateChartListing: boolean;
  privateRecordsPath: string;
  privateRecordsDatabasePath: string;
  privateRecordVerificationKeyPath: string | null;
  /** Optional record decoder adapter; the gateway can run without it. */
  privateRecordDecoderPluginPath: string | null;
  privateTokenCapturePath: string | null;
  adminToken: string;
  /** Vendored phira-web-monitor renderer (`pkg/`, `bin/`, optional `respack/`). */
  monitorRendererPath: string;
  /** Compiled chart payloads awaiting reuse by the preview. */
  monitorCachePath: string;
  monitorCacheMaxBytes: number;
  /** Phira-mp+ HTTP/SSE base (its documented `http_port`, not the game port). */
  pmpBaseUrl: string;
  /** Opt-in: without it the gateway makes no background connections to PMP. */
  pmpMonitorEnabled: boolean;
  /** Plugin-registered route returning the room snapshot, if one is installed. */
  pmpRoomsSnapshotPath: string;
  /** Event stream path: PMP's `/api/events`, or the plugin's filtered `/api/rooms/listen`. */
  pmpEventsPath: string;
  pmpMonitorToken: string | null;
  /** PMP+ native room-management token; never sent to the browser. */
  pmpAdminToken: string;
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

/** Like the positive variant, but 0 is meaningful ("cap disabled") for cache limits. */
function nonNegativeIntegerFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
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
    // The in-process multiplayer server is a legacy test/fallback implementation.
    // Production multiplayer is provided by the separately installed PMP+ fork.
    multiplayerEnabled: booleanFromEnv("MULTIPLAYER_ENABLED", false),
    multiplayerHost: process.env.MULTIPLAYER_HOST || "0.0.0.0",
    multiplayerPort: positiveIntegerFromEnv("MULTIPLAYER_PORT", 12348),
    upstreamBaseUrl: process.env.UPSTREAM_BASE_URL || "https://phira.5wyxi.com",
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "") || null,
    homepageHost: (process.env.HOMEPAGE_HOST || "").trim().toLowerCase() || null,
    userGuidePath: resolveFromProjectRoot(process.env.USER_GUIDE_PATH || "USER.md"),
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
    privateRecordDecoderPluginPath: process.env.PRIVATE_RECORD_DECODER_PLUGIN
      ? resolveFromProjectRoot(process.env.PRIVATE_RECORD_DECODER_PLUGIN)
      : resolveFromProjectRoot("decoder/decoder-dist/private-upload-adapter.js"),
    privateTokenCapturePath: process.env.PRIVATE_TOKEN_CAPTURE_PATH
      ? resolveFromProjectRoot(process.env.PRIVATE_TOKEN_CAPTURE_PATH)
      : null,
    adminToken: process.env.ADMIN_TOKEN || "",
    monitorRendererPath: resolveFromProjectRoot(process.env.MONITOR_RENDERER_PATH || "vendor/renderer"),
    monitorCachePath: resolveFromProjectRoot(process.env.MONITOR_CACHE_PATH || "data/monitor-cache"),
    // A compiled payload embeds decoded PCM (~90 MB for four minutes of stereo audio).
    monitorCacheMaxBytes: nonNegativeIntegerFromEnv("MONITOR_CACHE_MAX_MB", 2048) * 1024 * 1024,
    // PMP's HTTP/SSE/WebSocket port is `http_port` in its config (the game port is separate).
    pmpBaseUrl: (process.env.PMP_BASE_URL || "http://127.0.0.1:12347").replace(/\/+$/, ""),
    // Off by default: nothing connects to PMP until it is actually deployed.
    pmpMonitorEnabled: booleanFromEnv("PMP_MONITOR_ENABLED", false),
    // Room snapshots have no built-in HTTP route; a plugin must serve this one. The
    // HSNPhira v2 plugin serves the gooophira-compatible list here (and `/api/rooms/info`).
    pmpRoomsSnapshotPath: process.env.PMP_ROOMS_SNAPSHOT_PATH || "/api/rooms",
    pmpEventsPath: process.env.PMP_EVENTS_PATH || "/api/events",
    pmpMonitorToken: process.env.PMP_MONITOR_TOKEN || null,
    // The colocated PMP+ inherits ADMIN_TOKEN by default. A separate token can be
    // supplied when the two services are managed independently.
    pmpAdminToken: process.env.PMP_ADMIN_TOKEN || process.env.ADMIN_TOKEN || "",
    certPath: resolveFromProjectRoot(process.env.TLS_CERT_PATH || "certs/server.crt"),
    keyPath: resolveFromProjectRoot(process.env.TLS_KEY_PATH || "certs/server.key"),
    logToFile: booleanFromEnv("LOG_TO_FILE", false),
    logFilePath: resolveFromProjectRoot(process.env.LOG_FILE_PATH || "logs/requests.log"),
    debugBody: booleanFromEnv("DEBUG_BODY", false),
    debugBodyMaxBytes: Math.min(positiveIntegerFromEnv("DEBUG_BODY_MAX_BYTES", 4096), 4096),
  };
}
