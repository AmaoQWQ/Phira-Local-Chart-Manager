import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";

const scrypt = promisify(crypto.scrypt);
const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
export type AdminPermission = "reviewUsers" | "manageInstances";
export interface RegistrationApplication { reason: string; useType: "personal" | "group"; organization: string; socialAccount: string; notes: string }
export interface AdminUser {
  id: number; username: string; role: "admin" | "user"; instanceLimit: number; disabled: boolean; created: string;
  approvalStatus: "pending" | "approved" | "rejected";
  permissions: Record<AdminPermission, boolean>;
  application: RegistrationApplication;
  applicationRevision: number;
  reviewNote: string; reviewedBy: number | null; reviewedAt: string;
}
export function hasAdminPermission(user: AdminUser, permission: AdminPermission): boolean {
  return !user.disabled && user.approvalStatus === "approved" && (user.role === "admin" || user.permissions[permission]);
}
export interface AdminIdentity { user: AdminUser; csrf: string; sessionHash?: string; legacy?: boolean }
export class AdminError extends Error { constructor(public status: number, message: string) { super(message); } }
function hash(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function equal(a: string, b: string): boolean { return crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))); }
function publicUser(row: Record<string, unknown>): AdminUser {
  return {
    id: Number(row.id), username: String(row.username), role: row.role as AdminUser["role"], instanceLimit: Number(row.instance_limit), disabled: Boolean(row.disabled), created: String(row.created),
    approvalStatus: (row.approval_status || "approved") as AdminUser["approvalStatus"],
    permissions: { reviewUsers: Boolean(row.can_review), manageInstances: Boolean(row.can_manage_instances) },
    application: { reason: String(row.registration_reason || ""), useType: row.use_type === "group" ? "group" : "personal", organization: String(row.organization || ""), socialAccount: String(row.social_account || ""), notes: String(row.application_notes || "") },
    reviewNote: String(row.review_note || ""), reviewedBy: row.reviewed_by == null ? null : Number(row.reviewed_by), reviewedAt: String(row.reviewed_at || ""),
    applicationRevision: Number(row.application_revision || 0),
  };
}
function applicationInput(value: unknown): RegistrationApplication {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminError(422, "请填写注册申请资料");
  const input = value as Record<string, unknown>;
  const field = (key: string, label: string, minimum: number, maximum: number) => {
    const value = typeof input[key] === "string" ? input[key].trim() : "";
    if (value.length < minimum || value.length > maximum) throw new AdminError(422, `${label}长度应为 ${minimum}–${maximum} 个字符`);
    return value;
  };
  if (input.useType !== "personal" && input.useType !== "group") throw new AdminError(422, "请选择个人用途或团体用途");
  return { reason: field("reason", "注册原因", 10, 2000), useType: input.useType,
    organization: input.useType === "group" ? field("organization", "团体名称", 2, 120) : "",
    socialAccount: field("socialAccount", "社交平台及账号", 2, 500), notes: field("notes", "补充说明", 0, 1000) };
}
function password(value: unknown): string {
  if (typeof value !== "string" || value.length < 10 || value.length > 128) throw new AdminError(422, "密码长度应为 10–128 个字符");
  return value;
}

export class AdminAccountStore {
  private db: DatabaseSync;
  private limits = new Map<string, { count: number; until: number }>();
  private hashing = 0;
  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')),
        instance_limit INTEGER NOT NULL DEFAULT 2 CHECK(instance_limit >= 0), disabled INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_sessions (
        hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS admin_sessions_user ON admin_sessions(user_id);`);
    // Existing users are grandfathered in; only new registrations require approval.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set(this.db.prepare("PRAGMA table_info(admin_users)").all().map(row => row.name));
      const additions: Record<string, string> = {
        approval_status: "TEXT NOT NULL DEFAULT 'approved'", can_review: "INTEGER NOT NULL DEFAULT 0", can_manage_instances: "INTEGER NOT NULL DEFAULT 0",
        registration_reason: "TEXT NOT NULL DEFAULT ''", use_type: "TEXT NOT NULL DEFAULT 'personal'", organization: "TEXT NOT NULL DEFAULT ''",
        social_account: "TEXT NOT NULL DEFAULT ''", application_notes: "TEXT NOT NULL DEFAULT ''", review_note: "TEXT NOT NULL DEFAULT ''", reviewed_by: "INTEGER", reviewed_at: "TEXT NOT NULL DEFAULT ''", application_revision: "INTEGER NOT NULL DEFAULT 0",
      };
      for (const [name, definition] of Object.entries(additions)) if (!columns.has(name)) this.db.exec(`ALTER TABLE admin_users ADD COLUMN ${name} ${definition}`);
      this.db.exec("CREATE TABLE IF NOT EXISTS admin_review_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, actor_id INTEGER NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL, created TEXT NOT NULL)");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  hasAdmin(): boolean { return Boolean(this.db.prepare("SELECT id FROM admin_users WHERE role='admin' LIMIT 1").get()); }
  list(): AdminUser[] { return this.db.prepare("SELECT * FROM admin_users ORDER BY id").all().map(publicUser); }
  get(id: number): AdminUser | null { const row = this.db.prepare("SELECT * FROM admin_users WHERE id=?").get(id); return row ? publicUser(row) : null; }
  rate(key: string, maximum = 20): void {
    const now = Date.now();
    for (const [id, value] of this.limits) if (value.until <= now) this.limits.delete(id);
    let value = this.limits.get(key);
    if (!value) {
      if (this.limits.size >= 10000) throw new AdminError(429, "请求繁忙，请稍后再试");
      value = { count: 0, until: now + 15 * 60 * 1000 }; this.limits.set(key, value);
    }
    if (++value.count > maximum) throw new AdminError(429, "尝试次数过多，请 15 分钟后再试");
  }
  private async derive(value: string, salt: string): Promise<string> {
    if (this.hashing >= 4) throw new AdminError(429, "登录服务繁忙，请稍后重试");
    this.hashing++;
    try { return ((await scrypt(value, salt, 64)) as Buffer).toString("hex"); }
    finally { this.hashing--; }
  }
  async create(input: Record<string, unknown>, role: "admin" | "user"): Promise<AdminUser> {
    const application = role === "user" ? applicationInput(input.application) : { reason: "", useType: "personal", organization: "", socialAccount: "", notes: "" };
    const username = typeof input.username === "string" ? input.username.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(username)) throw new AdminError(422, "用户名需为 3–32 位小写字母、数字、下划线或连字符");
    const value = password(input.password), salt = crypto.randomBytes(16).toString("hex");
    const derived = await this.derive(value, salt);
    // No await between uniqueness/bootstrap checks and insert: concurrent registrations
    // cannot claim the administrator role or race the singleton administrator setup.
    if (role === "admin" && this.hasAdmin()) throw new AdminError(409, "超级管理员已初始化，请登录");
    if (this.db.prepare("SELECT id FROM admin_users WHERE username=?").get(username)) throw new AdminError(409, "用户名已被使用");
    const result = this.db.prepare("INSERT INTO admin_users(username,password_hash,salt,role,instance_limit,created,approval_status,registration_reason,use_type,organization,social_account,application_notes,application_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(username, derived, salt, role, 2, new Date().toISOString(), role === "admin" ? "approved" : "pending", application.reason, application.useType, application.organization, application.socialAccount, application.notes, role === "admin" ? 0 : 1);
    return this.get(Number(result.lastInsertRowid))!;
  }
  async login(input: Record<string, unknown>): Promise<AdminUser> {
    const username = typeof input.username === "string" ? input.username.trim().toLowerCase().slice(0, 32) : "";
    const value = typeof input.password === "string" && input.password.length <= 128 ? input.password : "";
    const row = this.db.prepare("SELECT * FROM admin_users WHERE username=?").get(username);
    const derived = await this.derive(value, String(row?.salt || "nonexistent-account-salt"));
    if (!row || !equal(derived, String(row.password_hash)) || row.disabled) throw new AdminError(401, "用户名或密码错误，或账号已被停用");
    const current = this.db.prepare("SELECT * FROM admin_users WHERE id=?").get(Number(row.id));
    if (!current || current.disabled || current.password_hash !== row.password_hash) throw new AdminError(401, "账号状态已变化，请重新登录");
    return publicUser(current);
  }
  issue(user: AdminUser): { token: string; identity: AdminIdentity } {
    this.db.prepare("DELETE FROM admin_sessions WHERE expires < ?").run(Date.now());
    const token = crypto.randomBytes(32).toString("base64url"), csrf = crypto.randomBytes(24).toString("base64url"), sessionHash = hash(token);
    this.db.prepare("INSERT INTO admin_sessions(hash,user_id,csrf,expires) VALUES(?,?,?,?)").run(sessionHash, user.id, csrf, Date.now() + SESSION_AGE);
    return { token, identity: { user, csrf, sessionHash } };
  }
  identify(request: IncomingMessage, publicGateway: boolean, adminToken: string): AdminIdentity | null {
    // Compatibility token is restricted to the loopback admin listener, never public HTTPS.
    const authorization = typeof request.headers.authorization === "string" ? /^Bearer\s+(.+)$/i.exec(request.headers.authorization)?.[1] : undefined;
    const legacyToken = authorization || request.headers["x-admin-token"];
    if (!publicGateway && adminToken && typeof legacyToken === "string" && equal(legacyToken, adminToken)) {
      return { user: publicUser({ id: 0, username: "server-admin", role: "admin", instance_limit: 0, disabled: false, created: "" }), csrf: "", legacy: true };
    }
    const cookie = request.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(this.cookieName(publicGateway) + "="));
    if (!cookie) return null;
    const token = cookie.slice(cookie.indexOf("=") + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const sessionHash = hash(token);
    const row = this.db.prepare("SELECT u.*,s.csrf FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>? AND u.disabled=0").get(sessionHash, Date.now());
    return row ? { user: publicUser(row), csrf: String(row.csrf), sessionHash } : null;
  }
  cookieName(secure: boolean): string { return secure ? "phira_admin_session" : "phira_admin_local_session"; }
  setCookie(response: ServerResponse, secure: boolean, token: string): void {
    response.setHeader("Set-Cookie", `${this.cookieName(secure)}=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${token ? SESSION_AGE / 1000 : 0}${secure ? "; Secure" : ""}`);
  }
  revoke(identity: AdminIdentity): void { if (identity.sessionHash) this.db.prepare("DELETE FROM admin_sessions WHERE hash=?").run(identity.sessionHash); }
  submitApplication(id: number, value: unknown): AdminUser {
    const application = applicationInput(value), user = this.get(id);
    if (!user || user.disabled) throw new AdminError(403, "账号不可用");
    if (user.approvalStatus === "approved") throw new AdminError(409, "账号已通过审核，无需重新申请");
    this.db.prepare("UPDATE admin_users SET registration_reason=?,use_type=?,organization=?,social_account=?,application_notes=?,approval_status='pending',review_note='',reviewed_by=NULL,reviewed_at='',application_revision=application_revision+1 WHERE id=?")
      .run(application.reason, application.useType, application.organization, application.socialAccount, application.notes, id);
    this.event(id, id, "resubmit", "申请资料已重新提交");
    return this.get(id)!;
  }
  reviewUser(id: number, input: Record<string, unknown>, actor: AdminUser): AdminUser {
    if (!hasAdminPermission(actor, "reviewUsers")) throw new AdminError(403, "需要注册审核权限");
    if (id === actor.id) throw new AdminError(403, "不能审核自己的申请");
    const user = this.get(id); if (!user) throw new AdminError(404, "申请人不存在");
    if (user.role === "admin" || user.disabled || user.approvalStatus !== "pending") throw new AdminError(409, "申请状态已变化，请刷新后操作");
    if (input.revision !== user.applicationRevision) throw new AdminError(409, "申请资料已更新，请刷新并查看最新资料后再审核");
    if (input.decision !== "approved" && input.decision !== "rejected") throw new AdminError(422, "请选择通过或拒绝");
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (note.length > 1000 || input.decision === "rejected" && !note) throw new AdminError(422, "拒绝时必须填写原因，审核意见最多 1000 字");
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare("UPDATE admin_users SET approval_status=?,review_note=?,reviewed_by=?,reviewed_at=? WHERE id=? AND approval_status='pending' AND disabled=0 AND application_revision=?")
        .run(input.decision, note, actor.id, now, id, user.applicationRevision);
      if (Number(changed.changes) !== 1) throw new AdminError(409, "申请已由其他审核员处理");
      this.event(id, actor.id, input.decision, note);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id)!;
  }
  setPermissions(id: number, value: unknown, actor: AdminUser): AdminUser {
    if (actor.role !== "admin") throw new AdminError(403, "只有超级管理员可以授予或收回权限");
    const user = this.get(id); if (!user) throw new AdminError(404, "用户不存在");
    if (user.role === "admin") throw new AdminError(422, "超级管理员始终拥有全部权限");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminError(422, "权限格式错误");
    const p = value as Record<string, unknown>;
    if (Object.keys(p).some(key => !["reviewUsers", "manageInstances"].includes(key)) || typeof p.reviewUsers !== "boolean" || typeof p.manageInstances !== "boolean") throw new AdminError(422, "请明确指定审核与实例管理权限");
    if ((p.reviewUsers || p.manageInstances) && (user.disabled || user.approvalStatus !== "approved")) throw new AdminError(422, "只能向已审核通过且正常的账号授权");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE admin_users SET can_review=?,can_manage_instances=? WHERE id=?").run(p.reviewUsers ? 1 : 0, p.manageInstances ? 1 : 0, id);
      this.event(id, actor.id, "permissions", `审核注册申请：${p.reviewUsers ? "开启" : "关闭"}；管理所有实例：${p.manageInstances ? "开启" : "关闭"}`);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id)!;
  }
  history(id: number): Record<string, unknown>[] { return this.db.prepare("SELECT actor_id AS actorId,action,note,created FROM admin_review_events WHERE user_id=? ORDER BY id DESC LIMIT 50").all(id); }
  private event(id: number, actor: number, action: string, note: string): void {
    this.db.prepare("INSERT INTO admin_review_events(user_id,actor_id,action,note,created) VALUES(?,?,?,?,?)").run(id, actor, action, note, new Date().toISOString());
  }
  updateUser(id: number, input: Record<string, unknown>, actor: AdminUser): AdminUser {
    if (actor.role !== "admin") throw new AdminError(403, "需要超级管理员权限");
    const user = this.get(id); if (!user) throw new AdminError(404, "用户不存在");
    const limit = input.instanceLimit === undefined ? user.instanceLimit : input.instanceLimit;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0 || limit > 10000) throw new AdminError(422, "实例配额必须是 0–10000 的整数");
    if (input.disabled !== undefined && typeof input.disabled !== "boolean") throw new AdminError(422, "账号状态格式不正确");
    if (user.role === "admin" && input.disabled === true) throw new AdminError(422, "不能停用超级管理员");
    const disabled = input.disabled === undefined ? user.disabled : input.disabled;
    this.db.prepare("UPDATE admin_users SET instance_limit=?,disabled=? WHERE id=?").run(limit, disabled ? 1 : 0, id);
    if (disabled) this.db.prepare("DELETE FROM admin_sessions WHERE user_id=?").run(id);
    return this.get(id)!;
  }
  async changePassword(identity: AdminIdentity, input: Record<string, unknown>): Promise<void> {
    const row = this.db.prepare("SELECT * FROM admin_users WHERE id=?").get(identity.user.id);
    if (!row) throw new AdminError(403, "请使用注册账号登录后修改密码");
    const old = typeof input.currentPassword === "string" ? input.currentPassword : "";
    if (old.length > 128 || !equal(await this.derive(old, String(row.salt)), String(row.password_hash))) throw new AdminError(422, "当前密码错误");
    const value = password(input.password), salt = crypto.randomBytes(16).toString("hex"), derived = await this.derive(value, salt);
    // A concurrent password change or account suspension invalidates this operation.
    const current = this.db.prepare("SELECT password_hash,disabled FROM admin_users WHERE id=?").get(identity.user.id);
    if (!current || current.disabled || current.password_hash !== row.password_hash) throw new AdminError(409, "账号状态已变化，请重新登录");
    this.db.prepare("UPDATE admin_users SET password_hash=?,salt=? WHERE id=?").run(derived, salt, identity.user.id);
    this.db.prepare("DELETE FROM admin_sessions WHERE user_id=?").run(identity.user.id);
  }
}

export function checkAdminMutation(request: IncomingMessage, identity: AdminIdentity | null, secure: boolean): void {
  if (identity?.legacy) return;
  const expected = `${secure ? "https" : "http"}://${request.headers.host}`;
  if (request.headers.origin && request.headers.origin !== expected) throw new AdminError(403, "不允许跨站管理请求");
  if (request.headers["x-admin-request"] !== "1") throw new AdminError(403, "缺少管理请求标识");
  if (identity && (typeof request.headers["x-csrf-token"] !== "string" || !equal(request.headers["x-csrf-token"], identity.csrf))) throw new AdminError(403, "会话校验失败，请刷新页面");
}

export function validBootstrapToken(value: unknown, configured: string): boolean {
  return Boolean(configured && typeof value === "string" && equal(value, configured));
}
