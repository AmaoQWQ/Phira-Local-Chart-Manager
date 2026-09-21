import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { AdminAccountStore, AdminError, checkAdminMutation, validBootstrapToken, type AdminIdentity } from "./admin-accounts";
import { can, canManageAccount, canViewAllRooms, instanceCapabilities, LEVELS, PERMISSIONS, type Permission } from "./admin-policy";
import { PhiraViewerResolver } from "./phira-viewer";
import http from "node:http";
import https from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, type Config } from "./config";
import { RequestLogger } from "./logger";
import {
  isPrivateChartId,
  isPrivateResourcePath,
  PrivateChartStore,
  getPrivateChartById,
  mergePrivateChartsIntoList,
  privateChartIdFromPath,
  privateResourceForPath,
  privateUploaderMetadata,
  PRIVATE_CHART_ID,
  PRIVATE_UPLOADER_ID,
} from "./private-chart";
import {
  privateUploadChartId,
  capturePrivateUploadToken,
  privateOpaqueUploadAcknowledgement,
  normalizePrivateRecordSummary,
} from "./private-record";
import { PrivateRecordSqliteStore as PrivateRecordStore } from "./private-record-sqlite";
import { loadRecordDecoderPlugin } from "./record-decoder-plugin";
import { MultiplayerServer } from "./multiplayer";
import { contentTypeForAsset, listMonitorAssets, MonitorChartCompiler, monitorAssetPath } from "./monitor-preview";
import { PmpRoomMonitor } from "./monitor-rooms";
import { PmpAdminClient, PmpAdminError } from "./pmp-admin";
import { adminUi } from "./admin-ui";
import { homepageUi } from "./homepage-ui";
import { documentPdfHtml } from "./doc-pdf";
import {
  ChartServiceInstanceRegistry,
  DEFAULT_INSTANCE_ID,
  instanceIdFromQuery,
  INSTANCE_ID_PATTERN,
  type ChartServiceInstanceRuntime,
} from "./instances";

const MAX_BODY_PREVIEW_BYTES = 4096;
const MAX_PROXY_BODY_BYTES = 16 * 1024 * 1024;
const MAX_ADMIN_BODY_BYTES = 768 * 1024 * 1024;
const PROFILE_CACHE_MS = 10 * 60 * 1000;
const DOC_FILES: Record<string, string> = {
  user: "USER.md",
  api: "docs/API.md",
  readme: "README.md",
};
function documentFilePath(config: Config, documentId: string): string {
  return documentId === "user"
    ? config.userGuidePath
    : path.resolve(process.cwd(), DOC_FILES[documentId]);
}
const DOC_PDF_TITLES: Record<string, string> = {
  user: "Phira 用户接入指南",
  api: "Phira API 文档",
  readme: "Phira 本地谱面管理系统",
};
const DOC_PDF_FILENAMES: Record<string, string> = {
  user: "phira-user-guide.pdf",
  api: "phira-api.pdf",
  readme: "phira-readme.pdf",
};
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function readBody(
  request: IncomingMessage,
  shouldPreview: boolean,
  previewLimit: number,
  maxBytes = MAX_PROXY_BODY_BYTES,
): Promise<{ size: number; data: Buffer; preview?: string }> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let tooLarge = false;

    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size <= maxBytes) chunks.push(buffer);
      else tooLarge = true;
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        return;
      }
      const data = Buffer.concat(chunks);
      resolve({
        size,
        data,
        preview: shouldPreview ? data.subarray(0, previewLimit).toString("utf8") : undefined,
      });
    });
    request.on("error", reject);
  });
}

function json(response: ServerResponse, payload: unknown, statusCode = 200): void {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function html(response: ServerResponse, body: string): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(body);
}

function hostMatches(value: string | string[] | undefined, expected: string): boolean {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  return entries.some((raw) => raw.split(",").some((item) => {
    const host = item.trim().toLocaleLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/:\d+$/, "")
      .replace(/\.$/, "");
    return host === expected;
  }));
}

function findPdfBrowser(): string | null {
  const candidates = [
    process.env.PDF_BROWSER_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Ignore invalid paths.
    }
  }
  return null;
}

async function renderPdfFromHtml(html: string): Promise<Buffer> {
  const browser = findPdfBrowser();
  if (!browser) throw new Error("此服务器未安装可用于生成 PDF 的无头浏览器");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phira-doc-pdf-"));
  try {
    const htmlPath = path.join(temporaryRoot, "document.html");
    const pdfPath = path.join(temporaryRoot, "document.pdf");
    const profilePath = path.join(temporaryRoot, "edge-profile");
    fs.mkdirSync(profilePath, { recursive: true });
    fs.writeFileSync(htmlPath, html, "utf8");
    const args = [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--hide-scrollbars",
      "--window-size=1280,1600",
      "--print-to-pdf-no-header",
      `--print-to-pdf=${pdfPath}`,
      `--user-data-dir=${profilePath}`,
      pathToFileURL(htmlPath).href,
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(browser, args, { windowsHide: true, stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("PDF 生成超时"));
      }, 60_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!fs.existsSync(pdfPath)) throw new Error("PDF 文件未生成");
    return fs.readFileSync(pdfPath);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

type MultipartPart = { value: string | Buffer; filename?: string };

function parseMultipart(body: Buffer, contentType: string): Map<string, MultipartPart> {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) throw new Error("multipart boundary is missing");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = new Map<string, MultipartPart>();
  let cursor = body.indexOf(boundary);
  while (cursor >= 0) {
    const start = cursor + boundary.length;
    if (body.subarray(start, start + 2).toString() === "--") break;
    const headerStart = start + (body.subarray(start, start + 2).toString() === "\r\n" ? 2 : 0);
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd < 0) break;
    const headers = body.subarray(headerStart, headerEnd).toString("utf8");
    const disposition = /content-disposition:\s*form-data;[^\r\n]*/i.test(headers);
    const nameMatch = /\bname="([^"]+)"/i.exec(headers);
    const filenameMatch = /\bfilename="([^"]*)"/i.exec(headers);
    if (!disposition || !nameMatch) { cursor = body.indexOf(boundary, headerEnd + 4); continue; }
    const dataStart = headerEnd + 4;
    const nextBoundary = body.indexOf(Buffer.from("\r\n"), dataStart);
    const boundaryAt = body.indexOf(boundary, nextBoundary >= 0 ? nextBoundary + 2 : dataStart);
    if (boundaryAt < 0) break;
    const dataEnd = boundaryAt;
    parts.set(nameMatch[1], {
      value: filenameMatch ? body.subarray(dataStart, dataEnd) : body.subarray(dataStart, dataEnd).toString("utf8"),
      ...(filenameMatch ? { filename: filenameMatch[1] } : {}),
    });
    cursor = boundaryAt;
  }
  return parts;
}

function decodeBase64(value: unknown, field: string): Buffer | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9+/\s=_-]+$/.test(value)) throw new Error(`${field} must be base64`);
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length === 0) throw new Error(`${field} is empty`);
  return decoded;
}

/**
 * Evaluates If-None-Match / If-Modified-Since. A conditional request is checked before
 * Range handling, matching RFC 7232 precedence.
 */
function isNotModified(request: IncomingMessage, fileStat: fs.Stats, etag: string): boolean {
  const ifNoneMatch = request.headers["if-none-match"];
  if (typeof ifNoneMatch === "string") {
    return ifNoneMatch.split(",").some((part) => {
      const tag = part.trim().replace(/^W\//, "");
      return tag === "*" || tag === etag;
    });
  }
  const ifModifiedSince = request.headers["if-modified-since"];
  if (typeof ifModifiedSince !== "string") return false;
  const since = Date.parse(ifModifiedSince);
  // Last-Modified has one-second resolution, so compare at that resolution.
  return Number.isFinite(since) && Math.floor(fileStat.mtimeMs / 1000) * 1000 <= since;
}

function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  filePath: string,
  contentType: string,
  cacheControl = "private, no-store",
): void {
  let fileStat: fs.Stats;
  try {
    fileStat = fs.statSync(filePath);
  } catch {
    json(response, { code: "NOT_FOUND", error: "private resource not found" }, 404);
    return;
  }
  const fileSize = fileStat.size;

  // A chart resource never changes behind its id, so a validator lets clients skip
  // re-downloading files that are tens of megabytes.
  const etag = `"${fileSize.toString(16)}-${Math.floor(fileStat.mtimeMs).toString(16)}"`;
  response.setHeader("ETag", etag);
  response.setHeader("Last-Modified", fileStat.mtime.toUTCString());
  response.setHeader("Cache-Control", cacheControl);
  if (isNotModified(request, fileStat, etag)) {
    response.statusCode = 304;
    response.end();
    return;
  }

  let start = 0;
  let end = fileSize - 1;
  let statusCode = 200;
  const rangeHeader = request.headers.range;
  const range = typeof rangeHeader === "string" ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null;
  if (rangeHeader !== undefined) {
    if (!range || fileSize === 0) {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${fileSize}`);
      response.end();
      return;
    }
    const requestedStart = range[1] === "" ? undefined : Number(range[1]);
    const requestedEnd = range[2] === "" ? undefined : Number(range[2]);
    if (
      (requestedStart === undefined && requestedEnd === undefined) ||
      (requestedStart !== undefined && !Number.isSafeInteger(requestedStart)) ||
      (requestedEnd !== undefined && !Number.isSafeInteger(requestedEnd))
    ) {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${fileSize}`);
      response.end();
      return;
    }
    if (requestedStart === undefined) {
      const suffixLength = Math.min(requestedEnd as number, fileSize);
      start = fileSize - suffixLength;
    } else {
      start = requestedStart;
      end = requestedEnd === undefined ? fileSize - 1 : requestedEnd;
    }
    if (start < 0 || start >= fileSize || end < start) {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${fileSize}`);
      response.end();
      return;
    }
    end = Math.min(end, fileSize - 1);
    statusCode = 206;
  }

  const contentLength = end - start + 1;
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", contentLength);
  response.setHeader("Accept-Ranges", "bytes");
  if (statusCode === 206) {
    response.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  }
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = fs.createReadStream(filePath, { start, end });
  stream.on("error", () => {
    if (!response.headersSent) {
      json(response, { code: "NOT_FOUND", error: "private resource not found" }, 404);
    } else {
      response.destroy();
    }
  });
  stream.pipe(response);
}

function proxyHeaders(request: IncomingMessage, target: URL): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = name.toLowerCase() === "host" ? target.host : value;
  }
  return headers;
}

function isChartListPath(pathname: string): boolean {
  return pathname === "/chart" || pathname === "/chart/";
}

function privateRatingScore(body: Buffer): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const score = (parsed as Record<string, unknown>).score;
  return typeof score === "number" && Number.isSafeInteger(score) && score >= 0 && score <= 10 ? score : null;
}

async function fetchPublicUserProfile(
  config: Config,
  userId: number,
): Promise<{ name: string; avatar: string | null } | null> {
  try {
    const target = new URL(`/user/${userId}`, config.upstreamBaseUrl);
    const upstreamResponse = await fetch(target, {
      headers: { accept: "application/json", "accept-encoding": "identity" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!upstreamResponse.ok) return null;
    const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
    if (bytes.length > 256 * 1024) return null;
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!name) return null;
    const avatar = typeof parsed.avatar === "string" && parsed.avatar.trim() !== ""
      ? parsed.avatar.trim()
      : null;
    return { name, avatar };
  } catch {
    return null;
  }
}

function loadPrivateRecordVerificationKey(config: Config): Buffer | null {
  if (!config.privateRecordVerificationKeyPath) return null;
  try {
    const key = fs.readFileSync(config.privateRecordVerificationKeyPath);
    return key.length === 26 ? key : null;
  } catch {
    return null;
  }
}

function decodeResponseBody(body: Buffer, contentEncoding: string | undefined): Buffer {
  switch ((contentEncoding || "").toLowerCase().trim()) {
    case "gzip":
      return gunzipSync(body);
    case "deflate":
      return inflateSync(body);
    case "br":
      return brotliDecompressSync(body);
    default:
      return body;
  }
}

function copyResponseHeaders(
  response: ServerResponse,
  headers: Record<string, string | string[] | undefined>,
  omit: Set<string> = new Set(),
): void {
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(lowerName) || omit.has(lowerName)) continue;
    response.setHeader(name, value);
  }
}

function forwardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  target: URL,
  body: Buffer,
  listQuery?: URLSearchParams,
  listBaseUrl?: string,
  privateCharts?: Pick<PrivateChartStore, "list">,
  ratingSummaryProvider?: (chartId: number) => { rating: number | null; ratingCount: number },
): Promise<void> {
  const shouldMergeList = listQuery !== undefined && listBaseUrl !== undefined;
  return new Promise((resolve, reject) => {
    const headers = proxyHeaders(request, target);
    if (shouldMergeList) {
      // The list transformer needs decoded JSON. The response is sent back uncompressed;
      // normal proxy requests retain the client's original compression negotiation.
      delete headers["accept-encoding"];
      headers["accept-encoding"] = "identity";
      delete headers["if-none-match"];
      delete headers["if-modified-since"];
    }
    const upstream = https.request(
      target,
      {
        method: request.method,
        headers,
        servername: target.hostname,
        timeout: 15_000,
      },
      (upstreamResponse) => {
        if (!shouldMergeList) {
          response.statusCode = upstreamResponse.statusCode || 502;
          copyResponseHeaders(response, upstreamResponse.headers);
          upstreamResponse.on("end", resolve);
          upstreamResponse.on("error", reject);
          upstreamResponse.pipe(response);
          return;
        }

        const chunks: Buffer[] = [];
        upstreamResponse.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        upstreamResponse.on("error", reject);
        upstreamResponse.on("end", () => {
          const rawBody = Buffer.concat(chunks);
          const statusCode = upstreamResponse.statusCode || 502;
          const contentType = String(upstreamResponse.headers["content-type"] || "");
          let outputBody = rawBody;
          let merged = false;
          try {
            const decodedBody = decodeResponseBody(
              rawBody,
              typeof upstreamResponse.headers["content-encoding"] === "string"
                ? upstreamResponse.headers["content-encoding"]
                : undefined,
            );
            if (statusCode >= 200 && statusCode < 300 && contentType.toLowerCase().includes("json")) {
              const parsed = JSON.parse(decodedBody.toString("utf8")) as unknown;
              const next = mergePrivateChartsIntoList(parsed, listQuery!, listBaseUrl!, privateCharts, ratingSummaryProvider);
              merged = next !== parsed;
              if (merged) outputBody = Buffer.from(JSON.stringify(next), "utf8");
            }
          } catch {
            // Preserve the official body and headers if an upstream response is not safely transformable.
            merged = false;
            outputBody = rawBody;
          }

          response.statusCode = statusCode;
          if (merged) {
            copyResponseHeaders(response, upstreamResponse.headers, new Set(["content-length", "content-encoding", "etag"]));
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.setHeader("Content-Length", outputBody.length);
            response.setHeader("Cache-Control", "no-store");
          } else {
            copyResponseHeaders(response, upstreamResponse.headers);
          }
          response.removeHeader("ETag");
          response.setHeader("Cache-Control", "private, no-store");
          response.setHeader("Vary", [upstreamResponse.headers.vary, "Authorization"].filter(Boolean).join(", "));
          response.end(outputBody);
          resolve();
        });
      },
    );

    upstream.on("timeout", () => upstream.destroy(new Error("upstream request timed out")));
    upstream.on("error", reject);
    upstream.end(body);
  });
}

function makeRequestHandler(
  config: Config,
  logger: RequestLogger,
  fallbackPrivateCharts = new PrivateChartStore(config.privateChartsPath),
  publicGateway = true,
  instanceRegistry?: ChartServiceInstanceRegistry,
  accounts = new AdminAccountStore(path.join(path.dirname(config.instancesPath), "accounts.sqlite")),
  monitorCompiler = new MonitorChartCompiler({
    rendererPath: config.monitorRendererPath,
    cachePath: config.monitorCachePath,
    maxCacheBytes: config.monitorCacheMaxBytes,
  }),
  roomMonitor = new PmpRoomMonitor({
    baseUrl: config.pmpBaseUrl,
    snapshotPath: config.pmpRoomsSnapshotPath,
    eventsPath: config.pmpEventsPath,
    token: config.pmpMonitorToken,
    enabled: config.pmpMonitorEnabled,
  }),
) {
  // Opened only when no instance registry is supplied (embedded and test use), so a
  // normal start does not hold an extra unused SQLite connection.
  let fallbackPrivateRecords: PrivateRecordStore | null = null;
  const fallbackRecords = (): PrivateRecordStore => (fallbackPrivateRecords ??= new PrivateRecordStore(config.privateRecordsDatabasePath, config.privateRecordsPath));
  const privateRecordVerificationKey = loadPrivateRecordVerificationKey(config);
  const recordDecoderPlugin = loadRecordDecoderPlugin(config.privateRecordDecoderPluginPath);
  const viewerResolver = new PhiraViewerResolver(config.upstreamBaseUrl);
  const pmpAdmin = new PmpAdminClient(config.pmpBaseUrl, config.pmpAdminToken);
  const profileCache = new Map<number, { name: string; avatar: string | null; until: number }>();

  /** Chart storage of the instance named in a preview URL, without trusting a query. */
  const monitorTarget = (instanceId: string): { chartsPath: string; charts: PrivateChartStore } | null => {
    if (instanceRegistry) {
      if (!instanceRegistry.get(instanceId)) return null;
      const runtime = instanceRegistry.runtime(instanceId);
      return { chartsPath: runtime.definition.chartsPath, charts: runtime.charts };
    }
    return instanceId === DEFAULT_INSTANCE_ID ? { chartsPath: config.privateChartsPath, charts: fallbackPrivateCharts } : null;
  };

  /**
   * Which instance owns a chart, so a room can be attributed to an instance without
   * trusting anything the room itself reports. Rooms carry only a chart id.
   */
  const instanceForChart = (chartId: number | null): string | null => {
    if (chartId === null || !instanceRegistry) return null;
    for (const item of instanceRegistry.list()) {
      if (instanceRegistry.runtime(item.id).charts.get(chartId)) return item.id;
    }
    return null;
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let adminRequest = false;
    try {
      const requestUrl = new URL(request.url || "/", `https://${request.headers.host || "localhost"}`);
      const method = request.method || "UNKNOWN";
      const isAdminApi = requestUrl.pathname === "/api/admin" || requestUrl.pathname.startsWith("/api/admin/");
      const isAdminPage = method === "GET" && requestUrl.pathname === "/admin";
      const isHomepage =
        publicGateway &&
        Boolean(config.homepageHost) &&
        method === "GET" &&
        requestUrl.pathname === "/" &&
        (hostMatches(request.headers.host, config.homepageHost!) ||
          hostMatches(request.headers["x-forwarded-host"], config.homepageHost!)) &&
        String(request.headers.accept || "").includes("text/html");
      adminRequest = isAdminApi;
      if (isHomepage) {
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("X-Content-Type-Options", "nosniff");
        html(response, homepageUi());
        return;
      }
      if (isAdminPage) {
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("Referrer-Policy", "no-referrer");
        html(response, adminUi());
        return;
      }
      let identity: AdminIdentity | null = null;
      const authPath = requestUrl.pathname.startsWith("/api/admin/auth/");
      if (isAdminApi) {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        identity = accounts.identify(request, publicGateway, config.adminToken);
        const openAuth = ["/api/admin/auth/status", "/api/admin/auth/login", "/api/admin/auth/register", "/api/admin/auth/setup"].includes(requestUrl.pathname);
        if (!identity && !openAuth) throw new AdminError(401, "请先登录管理面板");
        if (!["GET", "HEAD"].includes(method)) checkAdminMutation(request, identity, publicGateway);
        if (authPath && method === "POST" && requestUrl.pathname !== "/api/admin/auth/logout") accounts.rate("auth:" + request.socket.remoteAddress);
      }
      const body = await readBody(request, false, 0, isAdminApi
        ? requestUrl.pathname === "/api/admin/charts" && method === "POST" ? MAX_ADMIN_BODY_BYTES : 64 * 1024
        : MAX_PROXY_BODY_BYTES);
      if (authPath) {
        const action = requestUrl.pathname.slice("/api/admin/auth/".length);
        if (method === "GET" && action === "status") { json(response, { setupRequired: !accounts.hasAdmin(), registrationEnabled: true, approvalRequired: true }); return; }
        if (method === "GET" && action === "me" && identity) { json(response, { user: identity.user, csrf: identity.csrf }); return; }
        if (method !== "POST") throw new AdminError(404, "账号接口不存在");
        const input = JSON.parse(body.data.toString("utf8") || "{}") as Record<string, unknown>;
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminError(422, "请求格式错误");
        if (["register", "login", "setup"].includes(action)) {
          if (action === "setup" && !validBootstrapToken(input.adminToken, config.adminToken)) throw new AdminError(403, "管理令牌不正确，无法初始化超级管理员");
          const user = action === "login" ? await accounts.login(input) : await accounts.create(input, action === "setup" ? "admin" : "user");
          if (identity) accounts.revoke(identity);
          const session = accounts.issue(user);
          accounts.setCookie(response, publicGateway, session.token);
          json(response, { user: session.identity.user, csrf: session.identity.csrf }, action === "login" ? 200 : 201);
          return;
        }
        if (action === "logout" && identity) { accounts.revoke(identity); accounts.setCookie(response, publicGateway, ""); json(response, { ok: true }); return; }
        if (action === "password" && identity) { await accounts.changePassword(identity, input); accounts.setCookie(response, publicGateway, ""); json(response, { ok: true }); return; }
        if (action === "application" && identity) { json(response, { user: accounts.submitApplication(identity.user.id, input.application) }); return; }
        throw new AdminError(404, "账号接口不存在");
      }
      // Authenticate before selecting/reading any tenant runtime. IDs supplied by the
      // browser never grant ownership, including omitted/default instance parameters.
      const permitted = (permission: Permission, id: string): boolean => {
        const item = instanceRegistry?.get(id);
        return Boolean(identity && item && can(identity.user, permission, item, item.ownerId ? accounts.get(item.ownerId) : null));
      };
      const owns = (id: string): boolean => permitted("instance.read", id);
      const instancesEndpoint = requestUrl.pathname === "/api/admin/instances" || requestUrl.pathname.startsWith("/api/admin/instances/");
      const usersEndpoint = requestUrl.pathname === "/api/admin/users" || requestUrl.pathname.startsWith("/api/admin/users/");
      if (isAdminApi && identity) {
        if (!identity.legacy) {
          const current = accounts.identify(request, publicGateway, config.adminToken);
          if (!current || current.user.id !== identity.user.id) throw new AdminError(401, "账号已失效，请重新登录");
          identity = current;
        }
        if (identity.user.approvalStatus !== "approved") throw new AdminError(403, "注册申请尚未通过审核，请在申请状态页查看进度");
        const docMatch = /^\/api\/admin\/docs\/(user|api|readme)$/.exec(requestUrl.pathname);
        if (docMatch && method === "GET") {
          const documentFile = documentFilePath(config, docMatch[1]);
          try {
            json(response, { id: docMatch[1], content: fs.readFileSync(documentFile, "utf8") });
          } catch {
            json(response, { error: "document not found" }, 404);
          }
          return;
        }
        const pdfMatch = /^\/api\/admin\/docs\/(user|api|readme)\/pdf$/.exec(requestUrl.pathname);
        if (pdfMatch && method === "GET") {
          const documentId = pdfMatch[1];
          const documentFile = documentFilePath(config, documentId);
          try {
            const markdown = fs.readFileSync(documentFile, "utf8");
            const pdf = await renderPdfFromHtml(documentPdfHtml({ title: DOC_PDF_TITLES[documentId], source: markdown }));
            const filename = DOC_PDF_FILENAMES[documentId];
            response.statusCode = 200;
            response.setHeader("Content-Type", "application/pdf");
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("X-Content-Type-Options", "nosniff");
            response.setHeader("Content-Length", pdf.length);
            response.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
            response.end(pdf);
          } catch (error) {
            if (!response.headersSent) {
              json(response, { ok: false, error: error instanceof Error ? error.message : "PDF generation failed" }, 500);
            } else {
              response.destroy();
            }
          }
          return;
        }
        if (requestUrl.pathname === "/api/admin/permission-catalog" && method === "GET") { json(response, { levels: LEVELS, permissions: PERMISSIONS }); return; }
        if (requestUrl.pathname === "/api/admin/audit" && method === "GET") {
          const cursor = Number(requestUrl.searchParams.get("before") || Number.MAX_SAFE_INTEGER);
          if (!Number.isSafeInteger(cursor) || cursor <= 0) throw new AdminError(422, "审计分页参数不正确");
          json(response, accounts.auditPage(identity.user, (id, owner) => (instanceRegistry?.get(id)?.ownerId ?? null) === owner && permitted("audit.read", id), cursor)); return;
        }
        if (usersEndpoint) {
          if (!can(identity.user, "user.read")) throw new AdminError(403, "用户管理仅开放给管理员和超级管理员");
          const reviewMatch = /^\/api\/admin\/users\/(\d+)\/review$/.exec(requestUrl.pathname);
          const permissionMatch = /^\/api\/admin\/users\/(\d+)\/permissions$/.exec(requestUrl.pathname);
          const historyMatch = /^\/api\/admin\/users\/(\d+)\/history$/.exec(requestUrl.pathname);
          if (method === "POST" && reviewMatch) { json(response, accounts.reviewUser(Number(reviewMatch[1]), JSON.parse(body.data.toString("utf8")), identity.user)); return; }
          if (method === "PATCH" && permissionMatch) {
            if (identity.user.role !== "admin") throw new AdminError(403, "只有超级管理员可以调整权限");
            const input = JSON.parse(body.data.toString("utf8"));
            const ids = [...(Array.isArray(input?.assignedInstances) ? input.assignedInstances : []), ...(Array.isArray(input?.grants) ? input.grants.flatMap((g: { instanceIds?: unknown }) => Array.isArray(g?.instanceIds) ? g.instanceIds : []) : [])];
            if (ids.some(id => typeof id !== "string" || !instanceRegistry?.get(id))) throw new AdminError(422, "授权列表包含不存在的实例");
            json(response, accounts.setPermissions(Number(permissionMatch[1]), input, identity.user)); return;
          }
          if (method === "GET" && historyMatch) {
            if (!can(identity.user, "application.read")) throw new AdminError(403, "无权查看申请记录");
            const target = accounts.get(Number(historyMatch[1]));
            if (!target || !canManageAccount(identity.user, target)) throw new AdminError(403, "无权查看此账号的申请记录");
            json(response, accounts.history(Number(historyMatch[1]))); return;
          }
          const logoutMatch = /^\/api\/admin\/users\/(\d+)\/logout$/.exec(requestUrl.pathname);
          if (method === "POST" && logoutMatch) { accounts.forceLogout(Number(logoutMatch[1]), identity.user, JSON.parse(body.data.toString("utf8")).reason); json(response, { ok: true }); return; }
          const match = /^\/api\/admin\/users\/(\d+)$/.exec(requestUrl.pathname);
          if (method === "GET" && requestUrl.pathname === "/api/admin/users") {
            json(response, accounts.list().filter(user => canManageAccount(identity!.user, user) || user.id === identity!.user.id).map(user => {
              const { application, applicationRevision, reviewNote, reviewedBy, reviewedAt, grants, assignedInstances, ...basic } = user;
              return { ...basic, ...(can(identity!.user, "application.read") ? { application, applicationRevision, reviewNote, reviewedBy, reviewedAt } : {}), ...(identity!.user.role === "admin" ? { grants, assignedInstances } : {}), instanceCount: instanceRegistry?.list().filter(i => i.ownerId === user.id).length || 0 };
            })); return;
          }
          if (method === "PATCH" && match) { json(response, accounts.updateUser(Number(match[1]), JSON.parse(body.data.toString("utf8")), identity.user)); return; }
          if (method === "DELETE" && match) {
            if (request.headers["x-admin-confirm"] !== "delete") throw new AdminError(422, "删除账号需要明确确认");
            let reason = "";
            try { reason = decodeURIComponent(String(request.headers["x-admin-reason"] || "")); }
            catch { throw new AdminError(422, "操作原因格式错误"); }
            const userId = Number(match[1]);
            const ownedInstances = instanceRegistry?.list().filter(item => item.ownerId === userId).map(item => item.id) || [];
            const deleted = accounts.deleteUser(userId, identity.user, reason, ownedInstances);
            const releasedInstances = instanceRegistry?.releaseOwner(userId) || [];
            json(response, { ok: true, id: deleted.id, username: deleted.username, instancesPreserved: releasedInstances }); return;
          }
          throw new AdminError(404, "用户接口不存在");
        }
        const target = instancesEndpoint ? requestUrl.pathname.split("/")[4] : instanceIdFromQuery(requestUrl.searchParams.get("instance"));
        // Rooms are global, not instance-scoped: the request carries no instance, so falling
        // back to the default one would reject members who only collaborate on their own.
        // Their visibility filter is applied by the monitor routes themselves.
        const globalRoute = /^\/api\/admin\/(?:monitor\/)?rooms(\/|$)/.test(requestUrl.pathname);
        if (!globalRoute && target && !owns(target)) throw new AdminError(403, "无权查看此实例");
      }
      const publicChartId = !isAdminApi ? method === "POST" && requestUrl.pathname === "/play/upload"
        ? privateUploadChartId(body.data)
        : privateChartIdFromPath(requestUrl.pathname) ?? (() => { const match = /^\/(?:private-charts|private-files)\/(-?\d+)(?:\.pez|\/)/.exec(requestUrl.pathname); return match ? Number(match[1]) : null; })() : null;
      const runtime: ChartServiceInstanceRuntime = instanceRegistry
          ? (isAdminApi
          ? instanceRegistry.runtime(instancesEndpoint ? DEFAULT_INSTANCE_ID : instanceIdFromQuery(requestUrl.searchParams.get("instance")))
          : publicChartId !== null ? instanceRegistry.resolveForChart(publicChartId, request.headers.host) : instanceRegistry.resolveForHost(request.headers.host))
        : { definition: {
            id: DEFAULT_INSTANCE_ID,
            name: "默认实例",
            hosts: [],
            enabled: true,
            chartsPath: config.privateChartsPath,
            recordsPath: config.privateRecordsPath,
            recordsDatabasePath: config.privateRecordsDatabasePath,
            tokenCapturePath: config.privateTokenCapturePath,
            created: "",
            updated: "",
          }, charts: fallbackPrivateCharts, records: fallbackRecords() };
      const privateCharts = runtime.charts;
      const privateRecords = runtime.records;
      const privateTokenCapturePath = runtime.definition.tokenCapturePath;
      adminRequest = isAdminApi;

      logger.write({
        timestamp: new Date().toISOString(),
        remoteIp: request.socket.remoteAddress || "-",
        method,
        host: request.headers.host || "-",
        path: requestUrl.pathname,
        query: requestUrl.search,
        contentType: request.headers["content-type"] || "-",
        bodySize: body.size,
        userAgent: request.headers["user-agent"] || "-",
        httpVersion: request.httpVersion,
        headers: request.headers,
        bodyPreview: body.preview,
      });

      if (publicGateway && !isAdminApi && !runtime.definition.enabled) {
        json(response, { error: "chart service instance is disabled" }, 503);
        return;
      }

      if (isAdminPage) {
        html(response, adminUi());
        return;
      }

      if (isAdminApi) {
        if (!identity) throw new AdminError(401, "请先登录");
        const isSuper = identity.user.role === "admin";
        const adminBaseUrl = `https://${request.headers.host || "localhost"}`;
        const safeInstance = (item: import("./instances").ChartServiceInstanceDefinition) => ({ id: item.id, name: item.name, hosts: isSuper ? item.hosts : [], enabled: item.enabled, visibility: item.visibility ?? null, capabilities: instanceCapabilities(identity!.user, item, item.ownerId ? accounts.get(item.ownerId) : null), listingEnabled: config.privateChartListing, ownerId: item.ownerId ?? null, created: item.created, updated: item.updated });
        const targetId = instancesEndpoint ? requestUrl.pathname.split("/")[4] : runtime.definition.id;
        const route = requestUrl.pathname, write = !["GET", "HEAD"].includes(method);
        const parsedInput = write && !String(request.headers["content-type"]).startsWith("multipart/form-data") ? JSON.parse(body.data.toString("utf8") || "{}") : {};
        if (!parsedInput || typeof parsedInput !== "object" || Array.isArray(parsedInput)) throw new AdminError(422, "请求格式错误");
        const requirePermission = (p: Permission) => { if (!permitted(p, targetId)) throw new AdminError(403, "缺少权限：" + PERMISSIONS.find(item => item[0] === p)?.[1]); };
        const operations: Permission[] = [];
        if (route.startsWith("/api/admin/download/")) operations.push("chart.download");
        else if (route === "/api/admin/charts") operations.push(write ? "chart.upload" : "chart.read");
        else if (route === "/api/admin/charts/batch-delete") operations.push("chart.purge");
        else if (route === "/api/admin/charts/batch-tags") operations.push("chart.tags");
        else if (/^\/api\/admin\/charts\/-?\d+$/.test(route)) {
          if (method === "DELETE") operations.push("chart.delete");
          else if (method === "PATCH" || method === "PUT") {
            if (!Object.keys(parsedInput).length) throw new AdminError(422, "请至少指定一个要修改的谱面字段");
            if (Object.keys(parsedInput).some(k => !["name", "level", "difficulty", "charter", "composer", "illustrator", "description", "tags", "listed"].includes(k))) throw new AdminError(422, "谱面修改字段不支持");
            if (Object.keys(parsedInput).some(k => !["listed", "tags"].includes(k))) operations.push("chart.edit");
            if (parsedInput.tags !== undefined) operations.push("chart.tags");
            if (parsedInput.listed !== undefined) { if (typeof parsedInput.listed !== "boolean") throw new AdminError(422, "上架状态必须是布尔值"); operations.push(parsedInput.listed ? "chart.publish" : "chart.hide"); }
          }
        } else if (route === "/api/admin/records") operations.push(write ? "record.create" : "record.read");
        else if (route.startsWith("/api/admin/records/")) operations.push("record.delete");
        else if (route.startsWith("/api/admin/leaderboard/")) operations.push("record.read");
        else if (instancesEndpoint && targetId) {
          if (method === "DELETE") operations.push("instance.delete");
          else if (write) {
            if (!Object.keys(parsedInput).length) throw new AdminError(422, "请至少指定一个要修改的实例字段");
            if (Object.keys(parsedInput).some(k => !["name", "hosts", "enabled", "visibility"].includes(k))) throw new AdminError(422, "实例修改字段不支持");
            if (parsedInput.name !== undefined) operations.push("instance.rename");
            if (parsedInput.visibility !== undefined) operations.push("instance.visibility");
            if (parsedInput.enabled !== undefined) { if (typeof parsedInput.enabled !== "boolean") throw new AdminError(422, "实例启用状态格式错误"); operations.push(parsedInput.enabled ? "instance.enable" : "instance.disable"); }
          }
        }
        operations.forEach(requirePermission);

        // PMP+ managed-room operations are deliberately proxied by the Gateway. The
        // browser is authenticated with its normal account session and never sees the
        // PMP x-admin-token. Senior members and managers may manage definitions they
        // created; the super administrator may manage every definition.
        const managedRoot = route === "/api/admin/rooms" ? "/admin/rooms"
          : route === "/api/admin/rooms/hosted" ? "/admin/rooms/hosted"
          : route === "/api/admin/rooms/precreate" ? "/admin/rooms/precreate"
          : null;
        const managedMatch = /^\/api\/admin\/rooms\/([A-Za-z0-9_-]{1,64})\/(hosted|max-users|disband|chat|chart-pool)$/.exec(route);
        if (managedRoot || managedMatch) {
          const canManageRooms = identity.user.role === "admin"
            || identity.user.level === "senior"
            || identity.user.level === "manager";
          if (!canManageRooms) throw new AdminError(403, "只有高级成员、管理员或超级管理员可以管理房间");
          let upstream = managedRoot;
          if (managedMatch) {
            const suffix = ({ "max-users": "max_users", "chart-pool": "chart_pool" } as Record<string, string>)[managedMatch[2]] || managedMatch[2];
            upstream = `/admin/rooms/${encodeURIComponent(managedMatch[1])}/${suffix}`;
          }
          const allowed = upstream === "/admin/rooms" ? method === "GET"
            : upstream === "/admin/rooms/hosted" || upstream === "/admin/rooms/precreate" ? method === "POST"
            : upstream?.endsWith("/hosted") ? method === "GET" || method === "PATCH"
            : upstream?.endsWith("/chart_pool") ? method === "GET" || method === "PUT"
            : method === "POST";
          if (!allowed) throw new AdminError(405, "房间管理方法不支持");
          let reason = "";
          if (write) {
            try { reason = decodeURIComponent(String(request.headers["x-admin-reason"] || "")); }
            catch { throw new AdminError(422, "操作原因格式错误"); }
            reason = accounts.reason(reason);
          }
          const roomId = managedMatch?.[1] || String((parsedInput as Record<string, unknown>).roomId || "");
          const accountOwnerId = identity.user.id > 0 ? identity.user.id : null;
          let auditOwner = managedRoot === "/admin/rooms/hosted" || managedRoot === "/admin/rooms/precreate"
            ? accountOwnerId
            : null;
          try {
            if (managedMatch) {
              const existing = (await pmpAdmin.list()).rooms.find(room => room.roomid === managedMatch[1]);
              if (!existing || (identity.user.role !== "admin" && existing.owner_id !== identity.user.id)) {
                throw new AdminError(404, "未找到房间");
              }
              auditOwner = existing.owner_id;
            }
            const upstreamBody = write ? { ...parsedInput } : undefined;
            if (upstreamBody && (managedRoot === "/admin/rooms/hosted" || managedRoot === "/admin/rooms/precreate")) {
              // Never trust an owner supplied by the browser.
              upstreamBody.ownerId = accountOwnerId;
            }
            let result = await pmpAdmin.request(upstream!, method, upstreamBody);
            if (upstream === "/admin/rooms" && method === "GET" && result && typeof result === "object") {
              const object = result as { rooms?: Array<Record<string, unknown>>; total_rooms?: number };
              const visibleRooms = (object.rooms || []).filter(room => identity.user.role === "admin" || room.owner_id === identity.user.id);
              const rooms = visibleRooms.map(room => {
                const chart = room.chart && typeof room.chart === "object" ? room.chart as Record<string, unknown> : null;
                const chartId = typeof chart?.id === "number" ? chart.id : null;
                return { ...room, instanceId: instanceForChart(chartId) };
              });
              result = { ...object, total_rooms: rooms.length, rooms };
            }
            if (write) accounts.audit(identity.user.id, null, auditOwner, `room.${managedMatch?.[2] || route.split("/").at(-1)}`, roomId, reason, {}, result);
            const created = Boolean((result as Record<string, unknown> | null)?.created);
            json(response, result, created ? 201 : 200);
          } catch (error) {
            if (write) accounts.audit(identity.user.id, null, auditOwner, `room.${managedMatch?.[2] || route.split("/").at(-1)}`, roomId, reason, {}, { error: error instanceof Error ? error.message : String(error) }, "failed");
            if (error instanceof AdminError) throw error;
            if (error instanceof PmpAdminError) throw new AdminError(error.statusCode >= 500 ? 502 : error.statusCode, error.message);
            throw error;
          }
          return;
        }

        // Chart preview: the vendored phira-web-monitor renderer (MIT) re-uses the very
        // parser the upstream monitor server uses, so previews cannot disagree with what
        // players see. Its WASM player fetches the payload itself and therefore cannot
        // send an admin token header, which is why these routes authenticate through the
        // same-origin admin session cookie like any other browser request. The instance is
        // part of the path because the player appends "/chart/<id>" to the base it is given.
        if (route === "/api/admin/monitor/status" && method === "GET") {
          json(response, {
            available: monitorCompiler.available,
            buildCommand: "npm run build:renderer",
            version: monitorCompiler.assetVersion(),
            pkg: listMonitorAssets(monitorCompiler.pkgPath),
            respack: listMonitorAssets(monitorCompiler.respackPath),
            cache: monitorCompiler.stats(),
          });
          return;
        }
        // The optional path segment is a cache key for the immutable renderer build; the
        // file served always comes from the current vendored copy.
        const monitorAssetMatch = /^\/api\/admin\/monitor\/(pkg|respack)\/(?:[a-f0-9]{6,32}\/)?([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(route);
        if (monitorAssetMatch && method === "GET") {
          const directory = monitorAssetMatch[1] === "pkg" ? monitorCompiler.pkgPath : monitorCompiler.respackPath;
          const asset = monitorAssetPath(directory, monitorAssetMatch[2]);
          if (!asset || !fs.existsSync(asset)) throw new AdminError(404, "渲染器资源不存在");
          sendFile(request, response, asset, contentTypeForAsset(monitorAssetMatch[2]), "private, max-age=3600");
          return;
        }
        const roomDetailMatch = /^\/api\/admin\/monitor\/rooms\/([A-Za-z0-9_-]{1,64})$/.exec(route);
        if ((route === "/api/admin/monitor/rooms" || roomDetailMatch) && method === "GET") {
          // Rooms are global on the PMP side, so the filter is ownership: an unrestricted
          // view needs an `all` scope grant (or the super administrator), otherwise only
          // rooms whose chart lives in an instance the actor may monitor are returned.
          const unrestricted = canViewAllRooms(identity.user);
          const canViewRooms = unrestricted || Boolean(instanceRegistry?.list().some(item => permitted("monitor.view", item.id)));
          if (!canViewRooms) throw new AdminError(403, "缺少权限：查看房间");
          // The UI's refresh button asks for a fresh snapshot; without it the list is fed by
          // events plus the monitor's own periodic refresh.
          if (requestUrl.searchParams.get("refresh") === "1") await roomMonitor.refreshSnapshot();
          const visible = roomMonitor.list().flatMap((room) => {
            const instanceId = instanceForChart(room.chartId);
            if (!unrestricted && (instanceId === null || !permitted("monitor.view", instanceId))) return [];
            return [{ ...room, instanceId }];
          });
          if (roomDetailMatch) {
            const room = visible.find(item => item.id === roomDetailMatch[1]);
            // Invisible rooms are reported as missing rather than forbidden: a member must
            // not be able to probe which room ids exist.
            if (!room) throw new AdminError(404, "房间不存在");
            json(response, room);
            return;
          }
          json(response, { status: roomMonitor.status(), unrestricted, rooms: visible });
          return;
        }
        const monitorChartMatch = /^\/api\/admin\/monitor\/i\/([a-z0-9][a-z0-9_-]{0,47})\/chart\/(-?\d+)$/.exec(route);
        if (monitorChartMatch && method === "GET") {
          const instanceId = monitorChartMatch[1];
          if (!permitted("chart.read", instanceId)) throw new AdminError(403, "缺少权限：谱面预览");
          const chartId = Number(monitorChartMatch[2]);
          const target = monitorTarget(instanceId);
          if (!target || !target.charts.get(chartId)) throw new AdminError(404, "谱面不存在");
          const packagePath = path.join(target.chartsPath, String(chartId), "chart-package.pez");
          if (!fs.existsSync(packagePath)) throw new AdminError(404, "谱面包不存在");
          if (!monitorCompiler.available) throw new AdminError(503, "谱面渲染器尚未构建，请先运行 npm run build:renderer");
          let compiled: Awaited<ReturnType<typeof monitorCompiler.payload>>;
          try {
            compiled = await monitorCompiler.payload(chartId, packagePath);
          } catch (error) {
            throw new AdminError(500, "谱面编译失败：" + (error instanceof Error ? error.message : String(error)));
          }
          // The payload is immutable per revision, so a validator keeps repeat previews
          // cheap while still picking up a re-uploaded package.
          sendFile(request, response, compiled.filePath, "application/octet-stream", "private, max-age=0, must-revalidate");
          return;
        }
        // Summary of an already compiled payload: duration and note counts for the
        // preview controls. It never triggers a compilation of its own.
        const monitorMetaMatch = /^\/api\/admin\/monitor\/i\/([a-z0-9][a-z0-9_-]{0,47})\/meta\/(-?\d+)$/.exec(route);
        if (monitorMetaMatch && method === "GET") {
          const instanceId = monitorMetaMatch[1];
          if (!permitted("chart.read", instanceId)) throw new AdminError(403, "缺少权限：谱面预览");
          const chartId = Number(monitorMetaMatch[2]);
          const target = monitorTarget(instanceId);
          if (!target || !target.charts.get(chartId)) throw new AdminError(404, "谱面不存在");
          const packagePath = path.join(target.chartsPath, String(chartId), "chart-package.pez");
          const meta = monitorCompiler.metaFor(chartId, packagePath);
          if (!meta) throw new AdminError(404, "谱面尚未编译");
          // The revision makes the illustration URL immutable, so it can be cached hard.
          json(response, { ...meta, revision: monitorCompiler.revisionFor(chartId, packagePath) });
          return;
        }
        // The chart illustration, drawn behind the playfield exactly as the reference
        // player does (see prpr's draw_background: cover-cropped, blurred, dimmed).
        const monitorBackgroundMatch = /^\/api\/admin\/monitor\/i\/([a-z0-9][a-z0-9_-]{0,47})\/background\/(-?\d+)$/.exec(route);
        if (monitorBackgroundMatch && method === "GET") {
          const instanceId = monitorBackgroundMatch[1];
          if (!permitted("chart.read", instanceId)) throw new AdminError(403, "缺少权限：谱面预览");
          const chartId = Number(monitorBackgroundMatch[2]);
          const target = monitorTarget(instanceId);
          if (!target || !target.charts.get(chartId)) throw new AdminError(404, "谱面不存在");
          const background = monitorCompiler.backgroundFor(chartId, path.join(target.chartsPath, String(chartId), "chart-package.pez"));
          if (!background) throw new AdminError(404, "该谱面没有可用作背景的图片");
          sendFile(request, response, background.filePath, background.contentType, "private, max-age=3600");
          return;
        }
        if (write) {
          let reason = "";
          try { reason = decodeURIComponent(String(request.headers["x-admin-reason"] || "")); } catch { throw new AdminError(422, "操作原因格式错误"); }
          const target = instanceRegistry?.get(targetId);
          const highRisk = operations.some(p => ["高", "极高"].includes(PERMISSIONS.find(item => item[0] === p)![2]));
          if (target && target.ownerId !== identity.user.id && highRisk) reason = accounts.reason(reason);
          if (operations.includes("instance.delete") && request.headers["x-admin-confirm"] !== targetId || operations.includes("chart.purge") && request.headers["x-admin-confirm"] !== "delete") throw new AdminError(422, "请确认删除范围后再提交");
          const auditId = targetId || String(parsedInput.id || "");
          const initial = instanceRegistry?.get(auditId) ? instanceRegistry.runtime(auditId) : null;
          const initialChartIds = new Set(initial?.charts.list().map(c => c.id));
          // Record ids are assigned in increasing order, so the highest id before the
          // request identifies everything the request creates without reading the table.
          const initialRecordId = initial ? initial.records.maxRecordId() : 0;
          const snapshot = () => {
            const item = instanceRegistry?.get(auditId); if (!item) return null;
            const rt = instanceRegistry!.runtime(auditId), charts = rt.charts.list();
            const chartMatch = /^\/api\/admin\/charts\/(-?\d+)$/.exec(route), recordMatch = /^\/api\/admin\/records\/(-?\d+)$/.exec(route);
            const relevantCharts = chartMatch ? charts.filter(c => c.id === Number(chartMatch[1])) : route === "/api/admin/charts" && method === "POST" ? charts.filter(c => !initialChartIds.has(c.id)) : charts;
            // Audit details stay bounded: totals come from COUNT and at most 501 rows are
            // read, which keeps detailsTruncated accurate without a full table scan.
            const single = recordMatch ? rt.records.recordById(Number(recordMatch[1])) : null;
            const relevantRecords = recordMatch ? (single ? [single] : [])
              : route === "/api/admin/records" && method === "POST" ? rt.records.recordsAfter(initialRecordId, 501)
              : chartMatch ? rt.records.recentRecords({ chart: Number(chartMatch[1]) }, 501)
              : rt.records.recentRecords({}, 501);
            return { instance: { id: item.id, name: item.name, enabled: item.enabled, visibility: item.visibility, hosts: item.hosts }, chartCount: charts.length, recordCount: rt.records.countRecords(),
              detailsTruncated: relevantCharts.length > 500 || relevantRecords.length > 500,
              charts: relevantCharts.slice(0, 500).map(c => ({ id: c.id, name: c.name, level: c.level, difficulty: c.difficulty, charter: c.charter, composer: c.composer, illustrator: c.illustrator, description: c.description, tags: c.tags, listed: c.listed })), records: relevantRecords.slice(0, 500).map(r => ({ id: r.id, chart: r.chart, player: r.player, score: r.score, accuracy: r.accuracy })) };
          };
          const before = snapshot(), actor = identity.user.id, owner = target?.ownerId ?? actor;
          const end = response.end.bind(response);
          response.end = ((...args: Parameters<typeof response.end>) => {
            response.end = end;
            accounts.audit(actor, auditId, owner, method + " " + route, route, reason, before, snapshot(), response.statusCode < 400 ? "success" : "failed");
            return end(...args);
          }) as typeof response.end;
        }
        const downloadMatch = /^\/api\/admin\/download\/(-?\d+)$/.exec(requestUrl.pathname);
        if (downloadMatch && method === "GET") {
          const resource = privateResourceForPath(`/private-charts/${downloadMatch[1]}.pez`, runtime.definition.chartsPath, privateCharts);
          if (!resource) throw new AdminError(404, "谱面文件不存在");
          accounts.audit(identity.user.id, runtime.definition.id, runtime.definition.ownerId ?? null, "chart.download", downloadMatch[1], "", {}, { chartId: Number(downloadMatch[1]) });
          // An authenticated download must not be stored by shared caches.
          sendFile(request, response, resource.filePath, resource.contentType, "private, no-store"); return;
        }
        if (method === "GET" && requestUrl.pathname === "/api/admin/instances") {
          json(response, instanceRegistry
            ? instanceRegistry.list().filter(item => owns(item.id)).map((item) => {
                const itemRuntime = instanceRegistry.runtime(item.id);
                return {
                  ...safeInstance(item),
                  chartCount: itemRuntime.charts.list().length,
                  recordCount: itemRuntime.records.countRecords(),
                };
              })
            : []);
          return;
        }
        if (method === "POST" && requestUrl.pathname === "/api/admin/instances") {
          if (!instanceRegistry) {
            json(response, { error: "instance management is unavailable" }, 503);
            return;
          }
          const parsed = JSON.parse(body.data.toString("utf8")) as Record<string, unknown>;
          const newId = String(parsed.id ?? "").trim().toLowerCase();
          if (!INSTANCE_ID_PATTERN.test(newId)) throw new AdminError(422, "实例 ID 格式不正确");
          if (instanceRegistry.get(newId)) throw new AdminError(409, "实例 ID 已被使用，请换一个");
          if (!isSuper) {
            const user = accounts.get(identity.user.id)!;
            if (instanceRegistry.list().filter(i => i.ownerId === user.id).length >= user.instanceLimit) throw new AdminError(409, "已达到实例配额，请联系超级管理员调整");
            if (Array.isArray(parsed.hosts) && parsed.hosts.length || typeof parsed.hosts === "string" && parsed.hosts.trim()) throw new AdminError(403, "域名绑定由超级管理员管理");
            parsed.hosts = [];
          }
          const created = instanceRegistry.create(parsed, identity.user.id || null);
          json(response, safeInstance(created), 201);
          return;
        }
        const instanceAdminMatch = /^\/api\/admin\/instances\/([a-z0-9][a-z0-9_-]{0,47})$/.exec(requestUrl.pathname);
        if (instanceAdminMatch && instanceRegistry && (method === "PUT" || method === "PATCH")) {
          const parsed = JSON.parse(body.data.toString("utf8")) as { name?: unknown; hosts?: unknown; enabled?: unknown; visibility?: unknown };
          if (!isSuper && parsed.hosts !== undefined) throw new AdminError(403, "域名绑定由超级管理员管理");
          const updated = instanceRegistry.update(instanceAdminMatch[1], parsed);
          if (!updated) {
            json(response, { error: "chart service instance not found" }, 404);
            return;
          }
          json(response, safeInstance(updated));
          return;
        }
        if (instanceAdminMatch && instanceRegistry && method === "DELETE") {
          try {
            if (!await instanceRegistry.delete(instanceAdminMatch[1])) {
              json(response, { error: "chart service instance not found" }, 404);
              return;
            }
            accounts.removeInstanceGrants(instanceAdminMatch[1]);
            json(response, { ok: true, id: instanceAdminMatch[1] });
          } catch (error) {
            json(response, { error: error instanceof Error ? error.message : String(error) }, 422);
          }
          return;
        }
        if (method === "GET" && requestUrl.pathname === "/api/admin/dashboard") {
          json(response, {
            instance: safeInstance(runtime.definition),
            charts: permitted("chart.read", runtime.definition.id) ? privateCharts.list().map((chart) => ({
              ...chart,
              ...getPrivateChartById(chart.id, adminBaseUrl, privateCharts),
            })) : [],
            records: permitted("record.read", runtime.definition.id) ? privateRecords.adminRecords() : [],
            players: permitted("record.read", runtime.definition.id) ? privateRecords.adminPlayers() : [],
          });
          return;
        }
        if (method === "GET" && requestUrl.pathname === "/api/admin/charts") {
          json(response, privateCharts.list().map((chart) => ({ ...chart, ...getPrivateChartById(chart.id, adminBaseUrl, privateCharts) })));
          return;
        }
        const chartAdminMatch = /^\/api\/admin\/charts\/(\-?\d+)$/.exec(requestUrl.pathname);
        if (method === "POST" && requestUrl.pathname === "/api/admin/charts/batch-delete") {
          const parsed = JSON.parse(body.data.toString("utf8")) as Record<string, unknown>;
          const selectedIds = Array.isArray(parsed.ids)
            ? parsed.ids.map(Number).filter((id) => Number.isSafeInteger(id))
            : [];
          const tagValues = Array.isArray(parsed.tags)
            ? parsed.tags.map(String)
            : typeof parsed.tag === "string" ? parsed.tag.split(",") : [];
          const tags = tagValues.map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean);
          if (parsed.all !== true && selectedIds.length === 0 && tags.length === 0) {
            json(response, { error: "provide ids, tags, or all=true" }, 422);
            return;
          }
          const tagIds = privateCharts.list()
            .filter((chart) => tags.length > 0 && tags.some((tag) => chart.tags.some((item) => item.toLocaleLowerCase() === tag)))
            .map((chart) => chart.id);
          const ids = parsed.all === true ? privateCharts.list().map((chart) => chart.id) : [...new Set([...selectedIds, ...tagIds])];
          const deletedIds = await privateCharts.deleteMany(ids);
          const recordsDeleted = deletedIds.reduce((total, id) => total + privateRecords.deleteChartRecords(id), 0);
          json(response, { ok: true, deletedIds, recordsDeleted });
          return;
        }
        if (method === "POST" && requestUrl.pathname === "/api/admin/charts/batch-tags") {
          const parsed = JSON.parse(body.data.toString("utf8")) as Record<string, unknown>;
          const selectedIds = Array.isArray(parsed.ids)
            ? parsed.ids.map(Number).filter((id) => Number.isSafeInteger(id))
            : [];
          const filterValues = Array.isArray(parsed.matchTags)
            ? parsed.matchTags.map(String)
            : typeof parsed.matchTag === "string" ? parsed.matchTag.split(",") : [];
          const matchTags = filterValues.map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean);
          const hasTags = Array.isArray(parsed.tags) || typeof parsed.tags === "string";
          const tagValues = Array.isArray(parsed.tags)
            ? parsed.tags.map(String)
            : typeof parsed.tags === "string" ? parsed.tags.split(",") : [];
          const tags = tagValues.map((tag) => tag.trim()).filter(Boolean);
          const mode = parsed.mode === undefined ? "replace" : String(parsed.mode);
          if (!["replace", "add", "remove"].includes(mode)) {
            json(response, { error: "mode must be replace, add, or remove" }, 422);
            return;
          }
          if (!hasTags || (parsed.all !== true && selectedIds.length === 0 && matchTags.length === 0)) {
            json(response, { error: "provide tags and ids, matchTags, or all=true" }, 422);
            return;
          }
          const matchingIds = privateCharts.list()
            .filter((chart) => matchTags.length > 0 && matchTags.every((tag) => chart.tags.some((item) => item.toLocaleLowerCase() === tag)))
            .map((chart) => chart.id);
          const ids = parsed.all === true ? privateCharts.list().map((chart) => chart.id) : [...new Set([...selectedIds, ...matchingIds])];
          const updated = privateCharts.updateManyTags(ids, tags, mode as "replace" | "add" | "remove");
          json(response, { ok: true, mode, updated: updated.map((chart) => ({ ...chart, ...getPrivateChartById(chart.id, adminBaseUrl, privateCharts) })) });
          return;
        }
        if (chartAdminMatch && method === "DELETE") {
          const id = Number(chartAdminMatch[1]);
          if (!await privateCharts.delete(id)) {
            json(response, { error: "private chart not found" }, 404);
            return;
          }
          const recordsDeleted = privateRecords.deleteChartRecords(id);
          json(response, { ok: true, id, recordsDeleted });
          return;
        }
        if (chartAdminMatch && (method === "PUT" || method === "PATCH")) {
          const id = Number(chartAdminMatch[1]);
          const parsed = JSON.parse(body.data.toString("utf8")) as Partial<import("./private-chart").PrivateChartDefinition>;
          const chart = privateCharts.update(id, parsed);
          if (!chart) {
            json(response, { error: "private chart not found" }, 404);
            return;
          }
          json(response, { ...chart, ...getPrivateChartById(id, adminBaseUrl, privateCharts) });
          return;
        }
        if (method === "POST" && requestUrl.pathname === "/api/admin/charts") {
          let fields = new Map<string, MultipartPart>();
          const contentType = String(request.headers["content-type"] || "");
          if (contentType.toLowerCase().startsWith("multipart/form-data")) {
            fields = parseMultipart(body.data, contentType);
          } else {
            const parsed = JSON.parse(body.data.toString("utf8")) as Record<string, unknown>;
            for (const [key, value] of Object.entries(parsed)) fields.set(key, { value: typeof value === "string" ? value : JSON.stringify(value) });
          }
          const textField = (name: string): string | undefined => {
            const value = fields.get(name)?.value;
            return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
          };
          const fileField = (name: string): Buffer | undefined => {
            const value = fields.get(name)?.value;
            return Buffer.isBuffer(value) ? value : decodeBase64(value, name);
          };
          const tagsText = textField("tags");
          const tags = tagsText ? (tagsText.startsWith("[") ? JSON.parse(tagsText) : tagsText.split(",").map((tag) => tag.trim()).filter(Boolean)) : [];
          const packageFile = fileField("package") || fileField("packageBase64");
          if (!packageFile) throw new Error("chart package is required");
          const collection = privateCharts.importCollection(packageFile);
          if (collection) {
            if (!permitted("chart.publish", runtime.definition.id)) for (const item of collection.created) { privateCharts.update(item.id, { listed: false }); item.listed = false; }
            json(response, {
              collection: true,
              created: collection.created.map((item) => ({ ...item, ...getPrivateChartById(item.id, adminBaseUrl, privateCharts) })),
              skipped: collection.skipped,
            }, 201);
            return;
          }
          const requestedChartId = textField("id");
          if (requestedChartId && instanceRegistry?.list().some(item => item.id !== runtime.definition.id && instanceRegistry.runtime(item.id).charts.get(Number(requestedChartId)))) throw new AdminError(409, "该谱面 ID 已被其他实例使用，请更换 ID 或留空自动分配");
          const chart = privateCharts.create({
            listed: permitted("chart.publish", runtime.definition.id),
            id: textField("id") ? Number(textField("id")) : undefined,
            name: textField("name"), level: textField("level"), difficulty: textField("difficulty") ? Number(textField("difficulty")) : 0,
            charter: textField("charter"), composer: textField("composer"), illustrator: textField("illustrator"), description: textField("description"), tags,
          }, { packageFile, illustration: fileField("illustration") || fileField("illustrationBase64"), music: fileField("music") || fileField("musicBase64"), preview: fileField("preview") || fileField("previewBase64") });
          json(response, { ...chart, ...getPrivateChartById(chart.id, adminBaseUrl, privateCharts) }, 201);
          return;
        }
        if (method === "GET" && requestUrl.pathname === "/api/admin/records") {
          const chart = requestUrl.searchParams.get("chart");
          const player = requestUrl.searchParams.get("player");
          json(response, privateRecords.adminRecords({ chart: chart ? Number(chart) : undefined, player: player ? Number(player) : undefined }));
          return;
        }
        const leaderboardAdminMatch = /^\/api\/admin\/leaderboard\/(\-?\d+)$/.exec(requestUrl.pathname);
        if (leaderboardAdminMatch && method === "GET") {
          const id = Number(leaderboardAdminMatch[1]);
          if (!privateCharts.get(id)) {
            json(response, { error: "private chart not found" }, 404);
            return;
          }
          json(response, privateRecords.leaderboard(id, requestUrl.searchParams.get("std") === "true"));
          return;
        }
        if (method === "POST" && requestUrl.pathname === "/api/admin/records") {
          const parsed = JSON.parse(body.data.toString("utf8")) as Record<string, unknown>;
          const player = Number(parsed.player);
          const chart = Number(parsed.chart);
          if (!Number.isSafeInteger(player) || !Number.isSafeInteger(chart) || !isPrivateChartId(chart) || !privateCharts.get(chart)) {
            json(response, { error: "player or private chart is invalid" }, 422);
            return;
          }
          const summary = normalizePrivateRecordSummary(parsed);
          if (!summary) {
            json(response, { error: "invalid score summary" }, 422);
            return;
          }
          json(response, privateRecords.adminUpload(player, chart, summary), 201);
          return;
        }
        const recordAdminMatch = /^\/api\/admin\/records\/(\-?\d+)$/.exec(requestUrl.pathname);
        if (recordAdminMatch && method === "DELETE") {
          const id = Number(recordAdminMatch[1]);
          if (!privateRecords.deleteRecord(id)) {
            json(response, { error: "record not found" }, 404);
            return;
          }
          json(response, { ok: true, id });
          return;
        }
        json(response, { error: "admin endpoint not found" }, 404);
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/health") {
        json(response, { ok: true });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/play/upload") {
        const uploadChart = privateUploadChartId(body.data);
        if (uploadChart !== null) {
          capturePrivateUploadToken(body.data, privateTokenCapturePath);
          let parsedUpload: unknown;
          try {
            parsedUpload = JSON.parse(body.data.toString("utf8")) as unknown;
          } catch {
            parsedUpload = null;
          }
          const isRegisteredPrivateChart = uploadChart === PRIVATE_CHART_ID || Boolean(privateCharts.get(uploadChart));
          const decoder = recordDecoderPlugin;
          if (isRegisteredPrivateChart && (!privateRecordVerificationKey || !decoder)) {
            // Development/deployment fallback: a checkout without the private key or
            // decoder plugin must remain runnable. Do not persist unverified data; only
            // return the legacy-shaped success acknowledgement expected by the client.
            json(response, privateOpaqueUploadAcknowledgement(), 200);
            return;
          }
          if (!privateRecordVerificationKey || !decoder) {
            const upstreamBase = new URL(config.upstreamBaseUrl);
            if (upstreamBase.protocol !== "https:") throw new Error("UPSTREAM_BASE_URL must use https");
            await forwardRequest(request, response, new URL(`${requestUrl.pathname}${requestUrl.search}`, upstreamBase), body.data);
            return;
          }
          const preliminary = parsedUpload && typeof parsedUpload === "object" && !Array.isArray(parsedUpload)
            && typeof (parsedUpload as Record<string, unknown>).token === "string"
            ? decoder.decodePhiraRecordToken((parsedUpload as Record<string, unknown>).token as string, { key: privateRecordVerificationKey, expectedChartId: uploadChart })
            : null;
          const authenticatedUserId = preliminary?.valid
            ? privateRecords.bindAuthorizationToUser(request.headers.authorization, preliminary.record.userId)
            : null;
          const upstreamBase = new URL(config.upstreamBaseUrl);
          const result = await decoder!.handlePrivateUpload(parsedUpload, {
            verificationKey: privateRecordVerificationKey || Buffer.alloc(0),
            isRegisteredPrivateChart: async (chartId: number) => chartId === PRIVATE_CHART_ID || Boolean(privateCharts.get(chartId)),
            forwardOriginal: async () => {
              if (upstreamBase.protocol !== "https:") throw new Error("UPSTREAM_BASE_URL must use https");
              await forwardRequest(request, response, new URL(`${requestUrl.pathname}${requestUrl.search}`, upstreamBase), body.data);
              return undefined;
            },
            authenticatedUserId: async () => authenticatedUserId || 0,
            storePrivateRecord: async (decoded: any) => privateRecords.upload(
              decoded.record.userId,
              decoded.record.chartId,
              {
                score: decoded.record.score,
                accuracy: decoded.record.accuracy,
                fullCombo: decoded.record.fullCombo,
                perfect: decoded.record.perfect,
                good: decoded.record.good,
                bad: decoded.record.bad,
                miss: decoded.record.miss,
                maxCombo: decoded.record.maxCombo,
                speed: decoded.extra.speedPercent / 100,
                mods: decoded.extra.modsRaw,
              },
              decoded.payloadSha256,
            ),
            reply: async (status: number, payload: unknown) => {
              json(response, payload, status);
              return undefined;
            },
          });
          void result;
          return;
        }
      }

      if (method === "GET" && requestUrl.pathname === `/user/${PRIVATE_UPLOADER_ID}`) {
        json(response, privateUploaderMetadata());
        return;
      }

      const userMatch = /^\/user\/(\d+)$/.exec(requestUrl.pathname);
      if (method === "GET" && userMatch) {
        const userId = Number(userMatch[1]);
        let user = privateRecords.userMetadata(userId);
        if (user) {
          const cached = profileCache.get(userId);
          let profile = cached && cached.until > Date.now() ? cached : null;
          if (!profile) {
            const fetched = await fetchPublicUserProfile(config, userId);
            if (fetched) {
              if (profileCache.size >= 2000) profileCache.clear();
              profile = { ...fetched, until: Date.now() + PROFILE_CACHE_MS };
              profileCache.set(userId, profile);
            }
          }
          if (profile) {
            privateRecords.updatePlayerProfile(userId, profile.name, profile.avatar);
            user = privateRecords.userMetadata(userId);
          }
          json(response, user);
          return;
        }
      }

      if (method === "GET" && requestUrl.pathname === "/record") {
        const requestedPlayer = requestUrl.searchParams.get("player");
        const playerId = requestedPlayer === "0" || requestedPlayer === null ?
          privateRecords.playerIdForAuthorization(request.headers.authorization) : Number(requestedPlayer);
        if (privateRecords.hasPlayer(playerId)) {
          json(response, privateRecords.playerRecords(playerId));
          return;
        }
      }

      // PMP fetches the authoritative score by record id after a player reports
      // Played. A miss must continue to the official upstream because official
      // records share the same public route.
      const privateRecordMatch = /^\/record\/(\d+)$/.exec(requestUrl.pathname);
      if (method === "GET" && privateRecordMatch) {
        const recordId = Number(privateRecordMatch[1]);
        if (Number.isSafeInteger(recordId) && recordId > 0) {
          const record = instanceRegistry
            ? instanceRegistry.recordById(recordId, request.headers.host)
            : privateRecords.recordById(recordId);
          if (record) {
            // PMP deserializes these two fields as non-null f32 values. Newly
            // stored private records have no standard-deviation calculation yet.
            json(response, {
              ...record,
              std: typeof record.std === "number" ? record.std : 0,
              std_score: typeof record.std_score === "number" ? record.std_score : 0,
            });
            return;
          }
        }
      }

      const privateId = privateChartIdFromPath(requestUrl.pathname);
      const isRegisteredPrivateChart = privateId !== null && isPrivateChartId(privateId)
        && (privateId === PRIVATE_CHART_ID || Boolean(privateCharts.get(privateId)));
      if (isRegisteredPrivateChart && privateId !== null) {
        if (requestUrl.pathname === `/chart/${privateId}/rate`) {
          if (method === "GET") {
            json(response, { score: privateRecords.ratingForAuthorization(request.headers.authorization, privateId) });
            return;
          }
          const authorization = request.headers.authorization;
          if (method === "POST" || method === "PUT") {
            if (!authorization || (Array.isArray(authorization) && authorization.length === 0)) {
              json(response, { error: "authentication required" }, 401);
              return;
            }
            const score = privateRatingScore(body.data);
            if (score === null) {
              json(response, { error: "score must be an integer from 0 to 10" }, 422);
              return;
            }
            json(response, { score: privateRecords.rateForAuthorization(authorization, privateId, score) });
            return;
          }
          if (method === "DELETE") {
            if (!authorization || (Array.isArray(authorization) && authorization.length === 0)) {
              json(response, { error: "authentication required" }, 401);
              return;
            }
            json(response, { score: privateRecords.rateForAuthorization(authorization, privateId, 0) });
            return;
          }
          json(response, { code: "METHOD_NOT_ALLOWED", error: "private chart rating method not allowed" }, 405);
          return;
        }
      if (method === "GET" && requestUrl.pathname === `/chart/${privateId}`) {
          const chart = getPrivateChartById(
            privateId,
            config.publicBaseUrl || `https://${request.headers.host || "phira.5wyxi.com"}`,
            privateCharts,
            privateRecords.ratingSummary(privateId),
          );
          if (!chart) {
            json(response, { code: "NOT_FOUND", error: "private chart not found" }, 404);
            return;
          }
          json(response, chart);
          return;
        }
        if (method === "GET" && requestUrl.pathname === `/record/best/${privateId}`) {
          const player = privateRecords.playerIdForAuthorization(request.headers.authorization);
          json(response, privateRecords.bestSummary(player, privateId));
          return;
        }
        if (method === "GET" && requestUrl.pathname === `/record/list15/${privateId}`) {
          json(
            response,
            privateRecords.leaderboard(privateId, requestUrl.searchParams.get("std") === "true"),
          );
          return;
        }
        json(response, { code: "NOT_FOUND", error: "private chart endpoint not found" }, 404);
        return;
      }

      const privateResource = privateResourceForPath(requestUrl.pathname, runtime.definition.chartsPath, privateCharts);
      if (privateResource) {
        if (method !== "GET" && method !== "HEAD") {
          json(response, { code: "METHOD_NOT_ALLOWED", error: "private resource is read-only" }, 405);
          return;
        }
        sendFile(request, response, privateResource.filePath, privateResource.contentType, "private, max-age=86400");
        return;
      }

      if (isPrivateResourcePath(requestUrl.pathname)) {
        json(response, { code: "NOT_FOUND", error: "private resource not found" }, 404);
        return;
      }

      const upstreamBase = new URL(config.upstreamBaseUrl);
      if (upstreamBase.protocol !== "https:") {
        throw new Error("UPSTREAM_BASE_URL must use https");
      }
      const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, upstreamBase);
      const listBaseUrl = config.publicBaseUrl || `https://${request.headers.host || "phira.5wyxi.com"}`;
      const mergeListing = config.privateChartListing && method === "GET" && isChartListPath(requestUrl.pathname);
      const viewerId = mergeListing && instanceRegistry?.needsViewer() ? await viewerResolver.resolve(request.headers.authorization) : null;
      const listingCharts = mergeListing && instanceRegistry ? { list: () => instanceRegistry.visibleCharts(viewerId, request.headers.host) } : privateCharts;
      await forwardRequest(
        request,
        response,
        upstreamUrl,
        body.data,
        config.privateChartListing && method === "GET" && isChartListPath(requestUrl.pathname)
          ? requestUrl.searchParams
          : undefined,
        config.privateChartListing && method === "GET" && isChartListPath(requestUrl.pathname)
        ? listBaseUrl
          : undefined,
        listingCharts,
        chartId => instanceRegistry ? instanceRegistry.resolveForChart(chartId, request.headers.host).records.ratingSummary(chartId) : privateRecords.ratingSummary(chartId),
      );
    } catch (error) {
      if (error instanceof AdminError) {
        if (!response.headersSent) json(response, { error: error.message }, error.status);
        else response.destroy();
        return;
      }
      // Parser errors may contain submitted passwords or tokens; do not log their text.
      process.stderr.write(adminRequest ? "Admin request failed\n" : "Request handling failed\n");
      if (!response.headersSent) {
        const tooLarge = error instanceof Error && error.message.startsWith("request body exceeds");
        const statusCode = tooLarge ? 413 : adminRequest ? 400 : 502;
        json(response, { ok: false, error: adminRequest ? "invalid admin request" : "upstream request failed" }, statusCode);
      } else {
        response.destroy();
      }
    }
  };
}

async function start(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(config.certPath) || !fs.existsSync(config.keyPath)) {
    process.stderr.write(
      `TLS certificate or key not found. Run npm run cert:generate, or set TLS_CERT_PATH and TLS_KEY_PATH.\n` +
      `Certificate: ${config.certPath}\nKey: ${config.keyPath}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const logger = new RequestLogger(config.logToFile, config.logFilePath);
  const instanceRegistry = new ChartServiceInstanceRegistry(config);
  const accounts = new AdminAccountStore(path.join(path.dirname(config.instancesPath), "accounts.sqlite"));
  const defaultRuntime = instanceRegistry.defaultRuntime();
  // One shared pair per process: the two HTTP servers must not each compile charts or open
  // their own event stream to PMP.
  const monitorCompiler = new MonitorChartCompiler({
    rendererPath: config.monitorRendererPath,
    cachePath: config.monitorCachePath,
    maxCacheBytes: config.monitorCacheMaxBytes,
  });
  const roomMonitor = new PmpRoomMonitor({
    baseUrl: config.pmpBaseUrl,
    snapshotPath: config.pmpRoomsSnapshotPath,
    eventsPath: config.pmpEventsPath,
    token: config.pmpMonitorToken,
    enabled: config.pmpMonitorEnabled,
  });
  roomMonitor.start();
  const multiplayer = config.multiplayerEnabled
    ? new MultiplayerServer({
        host: config.multiplayerHost,
        port: config.multiplayerPort,
        upstreamBaseUrl: config.upstreamBaseUrl,
        privateChartBaseUrl: `https://${config.host}:${config.port}`,
        privateChartStore: defaultRuntime.charts,
      })
    : null;

  if (multiplayer) {
    try {
      await multiplayer.listen();
      const address = multiplayer.address();
      process.stdout.write(`Phira multiplayer listening on ${address.address}:${address.port} (Phira-MP v1 TCP)\n`);
    } catch (error) {
      process.stderr.write(`Multiplayer server error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const server = https.createServer(
    { cert: fs.readFileSync(config.certPath), key: fs.readFileSync(config.keyPath) },
    makeRequestHandler(config, logger, defaultRuntime.charts, true, instanceRegistry, accounts, monitorCompiler, roomMonitor),
  );
  const adminServer = http.createServer(
    makeRequestHandler(config, logger, defaultRuntime.charts, false, instanceRegistry, accounts, monitorCompiler, roomMonitor),
  );

  server.on("error", (error) => {
    process.stderr.write(`HTTPS server error: ${error.message}\n`);
    process.exitCode = 1;
    adminServer.close();
    void multiplayer?.close();
  });
  adminServer.on("error", (error) => {
    process.stderr.write(`Local admin server error: ${error.message}\n`);
    process.exitCode = 1;
    server.close();
    void multiplayer?.close();
  });

  const shutdown = (): void => {
    roomMonitor.stop();
    server.close();
    adminServer.close();
    void multiplayer?.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  server.listen(config.port, config.host, () => {
    process.stdout.write(`Phira 本地谱面管理系统正在监听 https://${config.host}:${config.port}\n`);
    process.stdout.write(`Certificate: ${config.certPath}\n`);
    process.stdout.write(`Private key: ${config.keyPath}\n`);
    process.stdout.write(`File logging: ${config.logToFile ? config.logFilePath : "disabled"}\n`);
  });
  adminServer.listen(config.adminPort, "127.0.0.1", () => {
    process.stdout.write(`Local admin console listening on http://127.0.0.1:${config.adminPort}/admin\n`);
  });
}

void start();
