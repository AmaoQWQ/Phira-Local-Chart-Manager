export function usersMarkup(): string {
  return String.raw`<section data-page="users" hidden><div class="heading"><div><h1>用户与注册审核</h1><p class="muted">审核申请；超级管理员还可修改配额、账号状态和权限。</p></div></div><div class="panel"><div class="toolbar"><select id="approvalFilter" aria-label="审核状态筛选"><option value="">全部用户</option><option value="pending">待审核</option><option value="rejected">已拒绝</option><option value="approved">已通过</option></select><input type="search" id="userSearch" class="search user-search" placeholder="搜索用户名或用户 ID" aria-label="搜索用户"></div><div class="table-scroll"><table><thead><tr><th>用户</th><th>角色</th><th>已用实例</th><th>实例配额</th><th>状态</th><th>操作</th></tr></thead><tbody id="users"></tbody></table></div></div></section>
`;
}
