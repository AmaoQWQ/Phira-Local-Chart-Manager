import type { AdminUser } from "./admin-accounts";

export const LEVELS = { ordinary: "普通成员", advanced: "进阶成员", senior: "高级成员", manager: "管理员", super: "超级管理员" } as const;
export type MemberLevel = keyof typeof LEVELS;
export const PERMISSIONS = [
  ["instance.read", "查看实例和统计", "低"], ["instance.rename", "修改实例名称", "低"],
  ["instance.visibility", "修改可见范围和 UID 名单", "高"], ["instance.enable", "启用实例", "高"], ["instance.disable", "停用实例", "高"], ["instance.delete", "删除整个实例", "极高"],
  ["chart.read", "查看谱面信息", "低"], ["chart.download", "下载谱面", "中"], ["chart.upload", "上传谱面及合集", "中"], ["chart.edit", "编辑谱面信息", "中"], ["chart.tags", "修改和批量修改标签", "中"], ["chart.publish", "上架谱面", "高"], ["chart.hide", "下架谱面", "高"], ["chart.delete", "删除单张谱面", "高"], ["chart.purge", "批量删除或清空谱面", "极高"],
  ["record.read", "查看本地成绩", "中"], ["record.create", "手动录入本地成绩", "高"], ["record.delete", "删除本地成绩", "高"], ["audit.read", "查看操作审计", "中"],
  // Rooms are global on the PMP side; these are checked per instance against the room's
  // chart ownership, and the unrestricted list additionally requires an `all` scope grant.
  ["monitor.view", "查看房间列表与详情", "中"],
  ["user.read", "查看用户基本信息", "低"], ["application.read", "查看注册申请资料", "中"], ["review.approve", "通过注册申请", "中"], ["review.reject", "拒绝注册申请", "中"], ["user.suspend", "停用成员账号", "高"], ["user.restore", "恢复成员账号", "高"], ["user.logout", "强制成员退出登录", "高"],
] as const;
export type Permission = typeof PERMISSIONS[number][0];
export interface PermissionGrant { permission: Permission; effect: "allow" | "deny"; scope: "own" | "selected" | "all"; instanceIds: string[]; expiresAt: string | null }
export interface PolicyInstance { id: string; ownerId?: number | null }
const collaboration: Permission[] = ["instance.read", "chart.read", "chart.download", "chart.upload", "chart.edit", "chart.tags", "chart.publish", "chart.hide", "record.read", "audit.read", "monitor.view"];
export const MANAGER_DEFAULTS: Permission[] = [...collaboration, "instance.rename", "instance.visibility", "instance.enable", "instance.disable", "chart.delete", "user.read", "application.read", "review.approve", "review.reject", "user.suspend", "user.restore", "user.logout"];
export function isAccountPermission(p: Permission): boolean { return p.startsWith("user.") || p.startsWith("application.") || p.startsWith("review."); }
export function effectiveLevel(user: Pick<AdminUser, "role" | "level">): MemberLevel { return user.role === "admin" ? "super" : user.level; }
export function can(user: AdminUser, permission: Permission, instance?: PolicyInstance, owner?: AdminUser | null): boolean {
  if (user.disabled || user.approvalStatus !== "approved") return false;
  if (user.role === "admin") return true;
  const account = isAccountPermission(permission);
  // These ceilings apply before explicit grants, including grants left over after a downgrade.
  if (account && user.level !== "manager") return false;
  if (!account && !instance) return false;
  const own = Boolean(instance && instance.ownerId === user.id);
  // Personal instance management remains a member's baseline capability.
  if (own) return true;
  const active = user.grants.filter(g => g.permission === permission && (!g.expiresAt || Date.parse(g.expiresAt) > Date.now()) &&
    (account ? g.scope === "all" : g.scope === "all" || g.scope === "own" && own || g.scope === "selected" && g.instanceIds.includes(instance!.id)));
  if (active.some(g => g.effect === "deny")) return false;
  if (active.some(g => g.effect === "allow")) return true;
  if (user.level === "manager") {
    // Domain/default/server-owned instances and peer administrator instances need an explicit grant.
    const protectedOwner = !owner || owner.role === "admin" || owner.level === "manager";
    return MANAGER_DEFAULTS.includes(permission) && (account || !protectedOwner);
  }
  return (user.level === "advanced" || user.level === "senior") && user.assignedInstances.includes(instance!.id) && collaboration.includes(permission);
}
export function instanceCapabilities(user: AdminUser, instance: PolicyInstance, owner?: AdminUser | null): Permission[] {
  return PERMISSIONS.map(p => p[0]).filter(p => !isAccountPermission(p) && can(user, p, instance, owner));
}
/**
 * Whether the actor may see every room rather than only the ones whose chart belongs to an
 * instance they manage or collaborate on. Deliberately narrower than `can()`: an
 * instance-scoped allow must not widen the list, so only an explicit `all` scope (or the
 * super administrator) counts.
 */
export function canViewAllRooms(user: AdminUser): boolean {
  if (user.disabled || user.approvalStatus !== "approved") return false;
  if (user.role === "admin") return true;
  return user.grants.some(grant => grant.permission === "monitor.view" && grant.effect === "allow" && grant.scope === "all" &&
    (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now()));
}
export function canManageAccount(actor: AdminUser, target: AdminUser): boolean {
  return actor.role === "admin" || actor.level === "manager" && target.role !== "admin" && target.level !== "manager" && target.id !== actor.id;
}
