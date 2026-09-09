import fs from "node:fs";
import path from "node:path";
import { AdminAccountStore, AdminError, checkAdminMutation, validBootstrapToken, hasAdminPermission, type AdminIdentity } from "./admin-accounts";
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
  normalizePrivateRecordSummary,
} from "./private-record";
import { PrivateRecordSqliteStore as PrivateRecordStore } from "./private-record-sqlite";
import { MultiplayerServer } from "./multiplayer";
import { adminUi } from "./admin-ui";
import {
  ChartServiceInstanceRegistry,
  DEFAULT_INSTANCE_ID,
  instanceIdFromQuery,
  INSTANCE_ID_PATTERN,
  type ChartServiceInstanceRuntime,
} from "./instances";

const { handlePrivateUpload } = require("../decoder/decoder-dist/private-upload-adapter.js") as {
  handlePrivateUpload: (body: unknown, dependencies: Record<string, unknown>) => Promise<unknown>;
};
const { decodePhiraRecordToken } = require("../decoder/decoder-dist/phira-record-decoder.js") as {
  decodePhiraRecordToken: (token: string, options: { key: Buffer; expectedChartId?: number; expectedUserId?: number }) => any;
};

const MAX_BODY_PREVIEW_BYTES = 4096;
const MAX_PROXY_BODY_BYTES = 16 * 1024 * 1024;
const MAX_ADMIN_BODY_BYTES = 768 * 1024 * 1024;
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

function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  filePath: string,
  contentType: string,
): void {
  let fileSize: number;
  try {
    fileSize = fs.statSync(filePath).size;
  } catch {
    json(response, { code: "NOT_FOUND", error: "private resource not found" }, 404);
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
) {
  const fallbackPrivateRecords = new PrivateRecordStore(config.privateRecordsDatabasePath, config.privateRecordsPath);
  const privateRecordVerificationKey = loadPrivateRecordVerificationKey(config);
  const viewerResolver = new PhiraViewerResolver(config.upstreamBaseUrl);

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let adminRequest = false;
    try {
      const requestUrl = new URL(request.url || "/", `https://${request.headers.host || "localhost"}`);
      const method = request.method || "UNKNOWN";
      const isAdminApi = requestUrl.pathname === "/api/admin" || requestUrl.pathname.startsWith("/api/admin/");
      const isAdminPage = method === "GET" && requestUrl.pathname === "/admin";
      adminRequest = isAdminApi;
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
      const owns = (id: string): boolean => Boolean(identity && (hasAdminPermission(identity.user, "manageInstances") || instanceRegistry?.get(id)?.ownerId === identity.user.id));
      const instancesEndpoint = requestUrl.pathname === "/api/admin/instances" || requestUrl.pathname.startsWith("/api/admin/instances/");
      const usersEndpoint = requestUrl.pathname === "/api/admin/users" || requestUrl.pathname.startsWith("/api/admin/users/");
      if (isAdminApi && identity) {
        if (!identity.legacy) {
          const current = accounts.identify(request, publicGateway, config.adminToken);
          if (!current || current.user.id !== identity.user.id) throw new AdminError(401, "账号已失效，请重新登录");
          identity = current;
        }
        if (identity.user.approvalStatus !== "approved") throw new AdminError(403, "注册申请尚未通过审核，请在申请状态页查看进度");
        if (usersEndpoint) {
          if (!hasAdminPermission(identity.user, "reviewUsers")) throw new AdminError(403, "需要注册审核权限");
          const reviewMatch = /^\/api\/admin\/users\/(\d+)\/review$/.exec(requestUrl.pathname);
          const permissionMatch = /^\/api\/admin\/users\/(\d+)\/permissions$/.exec(requestUrl.pathname);
          const historyMatch = /^\/api\/admin\/users\/(\d+)\/history$/.exec(requestUrl.pathname);
          if (method === "POST" && reviewMatch) { json(response, accounts.reviewUser(Number(reviewMatch[1]), JSON.parse(body.data.toString("utf8")), identity.user)); return; }
          if (method === "PATCH" && permissionMatch) { json(response, accounts.setPermissions(Number(permissionMatch[1]), JSON.parse(body.data.toString("utf8")), identity.user)); return; }
          if (method === "GET" && historyMatch) { json(response, accounts.history(Number(historyMatch[1]))); return; }
          const match = /^\/api\/admin\/users\/(\d+)$/.exec(requestUrl.pathname);
          if (method === "GET" && requestUrl.pathname === "/api/admin/users") {
            json(response, accounts.list().map(user => ({ ...user, instanceCount: instanceRegistry?.list().filter(i => i.ownerId === user.id).length || 0 }))); return;
          }
          if (method === "PATCH" && match) { json(response, accounts.updateUser(Number(match[1]), JSON.parse(body.data.toString("utf8")), identity.user)); return; }
          throw new AdminError(404, "用户接口不存在");
        }
        const target = instancesEndpoint ? requestUrl.pathname.split("/")[4] : instanceIdFromQuery(requestUrl.searchParams.get("instance"));
        if (target && !owns(target)) throw new AdminError(403, "无权管理此实例");
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
          }, charts: fallbackPrivateCharts, records: fallbackPrivateRecords };
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
        const safeInstance = (item: import("./instances").ChartServiceInstanceDefinition) => ({ id: item.id, name: item.name, hosts: isSuper ? item.hosts : [], enabled: item.enabled, visibility: item.visibility ?? null, listingEnabled: config.privateChartListing, ownerId: item.ownerId ?? null, created: item.created, updated: item.updated });
        const downloadMatch = /^\/api\/admin\/download\/(-?\d+)$/.exec(requestUrl.pathname);
        if (downloadMatch && method === "GET") {
          const resource = privateResourceForPath(`/private-charts/${downloadMatch[1]}.pez`, runtime.definition.chartsPath, privateCharts);
          if (!resource) throw new AdminError(404, "谱面文件不存在");
          sendFile(request, response, resource.filePath, resource.contentType); return;
        }
        if (method === "GET" && requestUrl.pathname === "/api/admin/instances") {
          json(response, instanceRegistry
            ? instanceRegistry.list().filter(item => owns(item.id)).map((item) => {
                const itemRuntime = instanceRegistry.runtime(item.id);
                return {
                  ...safeInstance(item),
                  chartCount: itemRuntime.charts.list().length,
                  recordCount: itemRuntime.records.adminRecords().length,
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
            if (!instanceRegistry.delete(instanceAdminMatch[1])) {
              json(response, { error: "chart service instance not found" }, 404);
              return;
            }
            json(response, { ok: true, id: instanceAdminMatch[1] });
          } catch (error) {
            json(response, { error: error instanceof Error ? error.message : String(error) }, 422);
          }
          return;
        }
        if (method === "GET" && requestUrl.pathname === "/api/admin/dashboard") {
          json(response, {
            instance: safeInstance(runtime.definition),
            charts: privateCharts.list().map((chart) => ({
              ...chart,
              ...getPrivateChartById(chart.id, adminBaseUrl, privateCharts),
            })),
            records: privateRecords.adminRecords(),
            players: privateRecords.adminPlayers(),
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
          const deletedIds = privateCharts.deleteMany(ids);
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
          if (!privateCharts.delete(id)) {
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
          if (isRegisteredPrivateChart && !privateRecordVerificationKey) {
            json(response, { error: "Private score decoder is not configured" }, 503);
            return;
          }
          const preliminary = privateRecordVerificationKey && parsedUpload && typeof parsedUpload === "object" && !Array.isArray(parsedUpload)
            && typeof (parsedUpload as Record<string, unknown>).token === "string"
            ? decodePhiraRecordToken((parsedUpload as Record<string, unknown>).token as string, { key: privateRecordVerificationKey, expectedChartId: uploadChart })
            : null;
          const authenticatedUserId = preliminary?.valid
            ? privateRecords.bindAuthorizationToUser(request.headers.authorization, preliminary.record.userId)
            : null;
          const upstreamBase = new URL(config.upstreamBaseUrl);
          const result = await handlePrivateUpload(parsedUpload, {
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
          const profile = await fetchPublicUserProfile(config, userId);
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
            `https://${request.headers.host || "phira.5wyxi.com"}`,
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
        sendFile(request, response, privateResource.filePath, privateResource.contentType);
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
      const listBaseUrl = `https://${request.headers.host || "phira.5wyxi.com"}`;
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
    makeRequestHandler(config, logger, defaultRuntime.charts, true, instanceRegistry, accounts),
  );
  const adminServer = http.createServer(
    makeRequestHandler(config, logger, defaultRuntime.charts, false, instanceRegistry, accounts),
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
    server.close();
    adminServer.close();
    void multiplayer?.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  server.listen(config.port, config.host, () => {
    process.stdout.write(`Phira API Probe listening on https://${config.host}:${config.port}\n`);
    process.stdout.write(`Certificate: ${config.certPath}\n`);
    process.stdout.write(`Private key: ${config.keyPath}\n`);
    process.stdout.write(`File logging: ${config.logToFile ? config.logFilePath : "disabled"}\n`);
  });
  adminServer.listen(config.adminPort, "127.0.0.1", () => {
    process.stdout.write(`Local admin console listening on http://127.0.0.1:${config.adminPort}/admin\n`);
  });
}

void start();
