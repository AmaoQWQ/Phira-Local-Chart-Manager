# Phira Gateway API 文档

本文对应项目当前的五级权限实现。示例账号、域名、UID、谱面 ID 和日期均为演示数据，不包含服务器的实际凭据。

## 目录

- [1. 地址、认证与请求约定](#1-地址认证与请求约定)
- [2. 成员快速开始](#2-成员快速开始)
- [3. 登录、注册与申请状态](#3-登录注册与申请状态)
- [4. 等级、权限和返回对象](#4-等级权限和返回对象)
- [5. 实例管理](#5-实例管理)
- [6. 谱面管理](#6-谱面管理)
- [7. 私有成绩](#7-私有成绩)
- [8. 用户、审核和授权](#8-用户审核和授权)
- [9. 观战与实时监控](#9-观战与实时监控)
- [10. 操作审计](#10-操作审计)
- [11. Phira 客户端接口](#11-phira-客户端接口)
- [12. 错误码与重试](#12-错误码与重试)
- [13. 接口索引](#13-接口索引)

## 1. 地址、认证与请求约定

### 1.1 管理 API 和客户端 API

| 用途 | 地址示例 | 认证身份 |
| --- | --- | --- |
| 成员、管理员管理 API | `https://charts.example.com/api/admin/...` | 本项目的面板账号 |
| Phira 在线列表、下载、游玩成绩 | `https://charts.example.com/chart` 等 | Phira 客户端身份；部分读取无需登录 |
| 服务器本机管理接口 | `http://127.0.0.1:9000/api/admin/...` | 本机面板会话，或服务器维护令牌 |

使用管理面板实际访问地址的**同一域名、协议和端口**，去掉末尾 `/admin` 即为示例中的 `BASE_URL`。直接连接当前 Gateway 的 HTTPS 监听端口时须包含 `:8443`；已有反向代理提供标准 HTTPS 时则使用其实际入口。成员不需要访问服务器的 9000 端口。

面板账号 ID、Phira UID、实例 ID、谱面 ID 是四类不同标识：

- 面板账号 ID：用户管理接口中的数字 `id`。
- Phira UID：实例可见名单中的 `userIds`，来自玩家 Phira 个人资料。
- 实例 ID：如 `my-server`，用于管理接口的 `instance` 参数。
- 谱面 ID：非零有符号 32 位整数，可以是负数；新谱面须跨实例唯一。

### 1.2 成员认证

1. `POST /api/admin/auth/login` 返回会话 Cookie，以及 JSON 中的 `csrf`。
2. 保存 Cookie；后续请求发送至同一入口。
3. 已登录写请求必须同时带 `X-Admin-Request: 1` 和 `X-CSRF-Token: <csrf>`。
4. Cookie 过期或失效后重新登录；`GET /api/admin/auth/me` 可确认身份并获取该会话的 CSRF 值。

```http
Cookie: phira_admin_session=<登录响应设置的会话值>
X-Admin-Request: 1
X-CSRF-Token: <登录响应中的 csrf>
Content-Type: application/json; charset=utf-8
```

公网 HTTPS Cookie 名为 `phira_admin_session`，包含 `HttpOnly; SameSite=Strict; Secure; Path=/api/admin`；本机 HTTP 会话使用不同的 `phira_admin_local_session` Cookie。请让 HTTP 客户端自动管理 Cookie，不要混用两个入口的会话。

普通 GET 读取只需要会话 Cookie；统一带上两个管理请求头也可以。注册、登录、首次初始化不需要已有 Cookie/CSRF，但仍必须带 `X-Admin-Request: 1`。如果请求携带 `Origin`，必须与服务器接收到的入口协议和 Host 一致；未提供跨站 CORS 接入方式，浏览器集成应使用同源请求。

会话固定有效期最长 7 天，不因每次访问自动续期。退出撤销当前会话；改密码、停用账号或强制退出会撤销该用户相应会话。权限修改不要求重新登录，服务端在每次管理请求中读取当前权限和到期时间。

**目前没有成员长期 API Key、Bearer 登录令牌或 refresh-token 接口。**登录响应的 `csrf` 不是独立认证凭据，必须与同一会话 Cookie 一起使用。

### 1.3 本机维护令牌

原有 `Authorization: Bearer <ADMIN_TOKEN>` 或 `X-Admin-Token: <ADMIN_TOKEN>` 只在本机管理监听入口兼容，具有服务器维护权限；不适用于公网成员请求。公网 `auth/setup` 请求体中的 `adminToken` 仅用于一次性的超级管理员初始化。

### 1.4 请求和响应

- 除谱面 multipart 上传外，写请求采用 UTF-8 JSON 对象。
- 成功通常返回 `200`；注册、初始化、创建实例、上传谱面/成绩返回 `201`。
- 没有统一的 `{data: ...}` 包装：列表通常直接返回数组，登录返回 `{user, csrf}`。
- 管理响应使用 `Cache-Control: no-store`。不要把旧的 `capabilities` 当成永久授权。
- 常规管理请求体上限 **64 KiB**；`POST /api/admin/charts` 上限 **768 MiB**，包含 multipart 或 JSON 编码后的完整请求体。Base64 通常比原文件增加约三分之一体积。
- `/api/admin/charts`、`/records`、`/users`、`/instances` 当前没有服务端分页或通用搜索参数；管理面板在浏览器中筛选。成绩接口仅支持其专用 `chart`、`player` 筛选，审计接口支持游标分页。
- 服务端不会按 `Idempotency-Key` 去重管理写请求。超时后先查询当前状态，不要盲目重复创建、上传或录入成绩。

### 1.5 实例选择、操作原因和删除确认

谱面、成绩、下载和 dashboard 接口使用 `?instance=<实例ID>`。省略或空值会选择 `default`，普通成员通常无权访问它。实例设置接口通过路径 `/instances/<实例ID>` 定位，不能用 query 参数改写目标。

管理**他人实例**的可见范围、启停、上下架、删除、手动成绩等高风险操作，需要 3–1000 字的原因，通过 URL 编码后的请求头传递：

```http
X-Admin-Reason: Content%20maintenance
```

中文原因请使用 JavaScript `encodeURIComponent()` 或 PowerShell `[Uri]::EscapeDataString()`。修改自己实例的这些操作不强制要求原因，但可以填写。超级管理员操作别人或服务器所有的实例时也适用此规则。

账号状态、配额、权限、强制退出接口改用 JSON `reason` 字段；注册审核使用 JSON `note` 字段。不要把 `reason` 混入谱面或实例 PATCH 对象，这些接口会拒绝未知字段。

| 删除操作 | 必须提供的额外确认 |
| --- | --- |
| 删除整个实例 | `X-Admin-Confirm: <目标实例ID>` |
| `/charts/batch-delete`，即使仅传一个 ID | `X-Admin-Confirm: delete` |
| 删除账号 | `X-Admin-Confirm: delete` |
| 删除单张谱面、单条成绩 | 无此确认头要求；权限和他人实例操作原因仍须满足 |

## 2. 成员快速开始

先在管理面板注册并通过审核，然后在 Windows PowerShell 5.1 或 PowerShell 7 中使用 [示例客户端](../examples/member-api.ps1)。该文件仅定义函数，加载时不会自动请求服务器。

```powershell
# 在项目根目录运行；BaseUrl 改成实际入口，需要时加 :8443。
. .\examples\member-api.ps1
$connection = Connect-PhiraGateway `
    -BaseUrl 'https://charts.example.com' `
    -Credential (Get-Credential)

# 确认自己的等级和审批状态。
$me = Invoke-PhiraAdmin $connection '/api/admin/auth/me'
$me.user | Select-Object username, level, approvalStatus, instanceLimit

# 列出有权限访问的实例。
$instances = Invoke-PhiraAdmin $connection '/api/admin/instances'
$instances | Select-Object id, name, capabilities

# 首次使用时创建自己的实例；若 ID 已存在或达到配额，接口返回 409。
$instance = Invoke-PhiraAdmin $connection '/api/admin/instances' -Method POST -Body @{
    id = 'my-server'
    name = '我的本地谱面库'
}

# 上传单张谱面或合集，留空 ChartId 自动分配。
$chart = Send-PhiraChart $connection -Instance 'my-server' -File 'C:\Charts\example.pez'

# 新实例默认隐藏。按需允许自己的 Phira UID 看到在线列表。
Invoke-PhiraAdmin $connection '/api/admin/instances/my-server' -Method PATCH -Body @{
    visibility = @{ mode = 'users'; userIds = @(12345) }
}

# 查看谱面列表。
Invoke-PhiraAdmin $connection '/api/admin/charts?instance=my-server'

# 退出当前会话。
Invoke-PhiraAdmin $connection '/api/admin/auth/logout' -Method POST -Body @{}
```

`$connection` 保存会话，只保存在当前 PowerShell 内存中，不要把它打印到共享日志。示例未关闭 TLS 校验，服务器入口需要使用客户端信任的证书。如果 Windows 阻止加载脚本，可打开一个仅对当前进程放行的会话，再加载已检查的示例文件：`powershell.exe -NoProfile -ExecutionPolicy Bypass`；无需改变系统的永久执行策略。

删除自己的实例示例（会删除其中全部资源与成绩）：

```powershell
Invoke-PhiraAdmin $connection '/api/admin/instances/my-server' `
    -Method DELETE -Confirm 'my-server'
```

调用前应重新建立有效会话；前面的快速开始最后一步已经退出。`-Reason` 参数设置实例操作原因头；用户管理接口仍需在 `-Body` 中填写 `reason`。

浏览器同源接入示例：

```javascript
async function adminRequest(path, { method = 'GET', body, csrf } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'X-Admin-Request': '1',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

// username/password 从登录表单读取；浏览器自动接收 HttpOnly Cookie。
const session = await adminRequest('/api/admin/auth/login', {
  method: 'POST', body: { username, password },
});
const instances = await adminRequest('/api/admin/instances');
// 之后的写请求传 session.csrf；不需要也不能用 JS 读取 HttpOnly Cookie。
```

## 3. 登录、注册与申请状态

以下路径统一加前缀 `/api/admin/auth`。

| 方法与路径 | 登录要求 | 请求体 | 成功响应 |
| --- | --- | --- | --- |
| `GET /status` | 无 | 无 | `{setupRequired, registrationEnabled, approvalRequired}` |
| `POST /register` | 无 | `username, password, application` | `201 {user, csrf}`，同时设置会话 Cookie |
| `POST /login` | 无 | `username, password` | `200 {user, csrf}`，同时设置会话 Cookie |
| `GET /me` | 有效会话 | 无 | `200 {user, csrf}` |
| `POST /logout` | 有效会话 | `{}` | `200 {ok:true}`，撤销当前会话 |
| `POST /password` | 有效会话 | `currentPassword, password` | `200 {ok:true}`，随后全部会话失效 |
| `POST /application` | 有效会话、未通过审核 | `application` | `200 {user}`，状态变为 pending |
| `POST /setup` | 无，仅首次初始化 | `username, password, adminToken` | `201 {user, csrf}`；已有超级管理员时为 `409` |

### 3.1 注册字段

```json
{
  "username": "example-member",
  "password": "example-password-change-me",
  "application": {
    "reason": "用于整理自己的节奏游戏练习谱面。",
    "useType": "personal",
    "organization": "",
    "socialAccount": "社交平台：example-member",
    "notes": "仅用于个人练习。"
  }
}
```

| 字段 | 规则 |
| --- | --- |
| `username` | 3–32 位，按小写保存；首字符是字母或数字，其余允许字母、数字、`_`、`-` |
| `password` | 10–128 个字符；API 不使用 `confirmPassword` |
| `application.reason` | 必填，去除首尾空白后 10–2000 个字符 |
| `application.useType` | `personal` 或 `group` |
| `application.organization` | 团体用途必填，2–120 个字符；个人用途存为空字符串 |
| `application.socialAccount` | 必填，2–500 个字符 |
| `application.notes` | 可省略，最多 1000 个字符 |

注册只创建 `ordinary` 普通成员，状态为 `pending`，实例配额为 2。请求不能指定自己的等级、权限、通过状态或配额。注册成功返回会话不代表审核通过。

`pending`、`rejected` 用户可以登录、查看自己的状态、改密码、退出、补充资料；其他管理接口返回 `403`。补充申请必须提交完整的 `application` 对象，申请版本 `applicationRevision` 加一，旧拒绝意见清空。已通过用户不能重新提交申请。

### 3.2 会话响应

以下是节选，不是完整字段列表：

```json
{
  "user": {
    "id": 12,
    "username": "example-member",
    "role": "user",
    "level": "ordinary",
    "approvalStatus": "approved",
    "instanceLimit": 2,
    "disabled": false,
    "globalCapabilities": [],
    "assignedInstances": [],
    "grants": [],
    "permissionRevision": 0,
    "applicationRevision": 1
  },
  "csrf": "<此会话的CSRF值>"
}
```

`GET /auth/me` 还包含本人申请资料、审核状态与时间。`role` 是旧的存储分类：**只有超级管理员的 `role` 为 `admin`；普通管理员仍为 `role:user, level:manager`**。展示成员等级请使用 `level`，授权判断应读取当前 capabilities 并以服务端结果为准。

## 4. 等级、权限和返回对象

### 4.1 五级制度

| `level` | 名称 | 默认能力 |
| --- | --- | --- |
| `ordinary` | 普通成员 | 管理自己实例 |
| `advanced` | 进阶成员 | 自己实例，加 `assignedInstances` 指定的谱面协作、成绩及审计读取 |
| `senior` | 高级成员 | 默认协作能力同进阶成员，可由超级管理员补充启停等授权；无申请资料权限 |
| `manager` | 管理员 | 管辖普通/进阶/高级成员的账号和实例，审核注册；默认不含手动成绩、批量清空、整实例删除 |
| `super` | 超级管理员 | 全平台权限；不可通过普通权限接口授予 |

每次检查先判断停用和审批状态。自己的实例管理是已通过成员的基础能力；对于其他范围，有效的禁止规则优先于额外允许和等级默认能力。指定授权必须匹配实例，过期授权不生效。

管理员默认不管理其他管理员、超级管理员或服务器所有的实例，需要超级管理员明确授权实例范围。账号操作始终不能针对自己、同级管理员或超级管理员。等级提高不会自动增加实例配额。

### 4.2 权限目录

`GET /api/admin/permission-catalog`：所有已通过成员可读取，返回：

```json
{
  "levels": {
    "ordinary": "普通成员",
    "advanced": "进阶成员",
    "senior": "高级成员",
    "manager": "管理员",
    "super": "超级管理员"
  },
  "permissions": [
    ["instance.read", "查看实例和统计", "低"],
    ["chart.download", "下载谱面", "中"]
  ]
}
```

示例 `permissions` 仅列两项；实际返回以下全部 26 项三元数组。

| 权限标识 | 操作 | 风险 |
| --- | --- | --- |
| `instance.read` | 查看实例和统计 | 低 |
| `instance.rename` | 修改实例名称 | 低 |
| `instance.visibility` | 修改可见范围和 UID 名单 | 高 |
| `instance.enable` | 启用实例 | 高 |
| `instance.disable` | 停用实例 | 高 |
| `instance.delete` | 删除整个实例 | 极高 |
| `chart.read` | 查看谱面信息 | 低 |
| `chart.download` | 下载谱面 | 中 |
| `chart.upload` | 上传谱面及合集 | 中 |
| `chart.edit` | 编辑谱面信息 | 中 |
| `chart.tags` | 修改和批量修改标签 | 中 |
| `chart.publish` | 上架谱面 | 高 |
| `chart.hide` | 下架谱面 | 高 |
| `chart.delete` | 删除单张谱面 | 高 |
| `chart.purge` | 批量删除或清空谱面 | 极高 |
| `record.read` | 查看本地成绩 | 中 |
| `record.create` | 手动录入本地成绩 | 高 |
| `record.delete` | 删除本地成绩 | 高 |
| `audit.read` | 查看操作审计 | 中 |
| `user.read` | 查看用户基本信息 | 低 |
| `application.read` | 查看注册申请资料 | 中 |
| `review.approve` | 通过注册申请 | 中 |
| `review.reject` | 拒绝注册申请 | 中 |
| `user.suspend` | 停用成员账号 | 高 |
| `user.restore` | 恢复成员账号 | 高 |
| `user.logout` | 强制成员退出登录 | 高 |

访问某实例内的管理接口，通常需要该实例的 `instance.read` **以及**对应操作权限。例如只有 `chart.download` 而没有 `instance.read` 仍不能调用管理下载接口。

`user.*`、`application.*`、`review.*` 只允许管理员等级和超级管理员使用，不能用额外授权赋予低等级成员。用户接口的共同前提是 `user.read`；审核还需要 `application.read` 和具体的通过/拒绝权限。
改配额、调整等级/授权、域名绑定是超级管理员保留操作，不在可分配权限目录中。响应中的旧 `permissions.reviewUsers/manageInstances` 仅为兼容字段，不代表完整的新授权体系。

### 4.3 实例对象

`GET /api/admin/instances` 返回可读取实例的数组。单个元素示例：

```json
{
  "id": "my-server",
  "name": "我的本地谱面库",
  "hosts": [],
  "enabled": true,
  "visibility": {"mode": "users", "userIds": [12345, 67890]},
  "capabilities": ["instance.read", "chart.read", "chart.upload"],
  "listingEnabled": true,
  "ownerId": 12,
  "chartCount": 3,
  "recordCount": 20,
  "created": "2026-09-09T00:00:00.000Z",
  "updated": "2026-09-09T00:00:00.000Z"
}
```

`capabilities` 为当前账号在此实例的有效权限，上例只展示部分项。`hosts` 对非超级管理员返回空数组。`ownerId:null` 表示服务器所有；旧实例的 `visibility:null` 表示保留原有域名入口显示行为。创建、修改响应和 dashboard 内的实例对象不包含列表专属的 `chartCount/recordCount`。

## 5. 实例管理

### 5.1 列表与 dashboard

```http
GET /api/admin/instances
GET /api/admin/dashboard?instance=my-server
```

dashboard 返回 `{instance, charts, records, players}`。没有 `chart.read` 时 `charts` 为空；没有 `record.read` 时 `records` 和 `players` 为空。空数组不一定意味着实例没有数据。

### 5.2 创建实例

```http
POST /api/admin/instances
```

```json
{
  "id": "my-server",
  "name": "我的本地谱面库",
  "enabled": true,
  "visibility": {"mode": "none", "userIds": []}
}
```

- `id` 必填：1–48 位，保存前转为小写；正则 `[a-z0-9][a-z0-9_-]{0,47}`，全平台唯一，创建后不可修改。
- `name` 可省略，默认实例 ID；`enabled` 默认 `true`。
- `visibility` 可省略，新实例默认 `none`。
- `hosts` 仅超级管理员可设置；成员创建时请省略。
- 归属由登录身份决定，不接受客户端指定所有者；非超级管理员受当前账号实例配额限制。
- 成功 `201` 返回实例对象；ID 冲突或达到配额为 `409`。

### 5.3 修改实例

```http
PATCH /api/admin/instances/my-server
```

`PUT` 也兼容，但行为同部分更新，不是全量替换。允许字段：

| 字段 | 类型 | 需要的权限 |
| --- | --- | --- |
| `name` | string | `instance.rename` |
| `enabled:true` | boolean | `instance.enable` |
| `enabled:false` | boolean | `instance.disable` |
| `visibility` | 下述对象 | `instance.visibility` |
| `hosts` | string[]，也兼容逗号分隔字符串 | 仅超级管理员 |

至少提交一个字段，未知字段返回 `422`。同一个请求包含多个字段时，必须满足每项权限；任意一项缺权限都会拒绝整个请求。

可见范围的三种完整示例：

```json
{"visibility":{"mode":"all","userIds":[]}}
```

```json
{"visibility":{"mode":"users","userIds":[12345,67890]}}
```

```json
{"visibility":{"mode":"none","userIds":[]}}
```

`users` 模式需要 1–1000 个数字类型的正整数 UID，最大 `2147483647`；重复项会去重。字符串 `"12345"` 不接受。`all/none` 会清空名单。不要发送 `visibility:null`；要保留旧行为应省略此字段。

此设置只影响经 Gateway 返回的 Phira 在线列表和搜索，不是下载访问控制，也不修改面板权限。显示还要求实例启用、谱面 `listed:true`、服务器 `PRIVATE_CHART_LISTING=true`。指定 UID 由 Phira 客户端登录身份在官方上游验证，不能靠 query 参数自报。

### 5.4 删除实例

```http
DELETE /api/admin/instances/my-server
X-Admin-Confirm: my-server
```

需要 `instance.delete`。操作他人实例还需原因头。成功 `200 {"ok":true,"id":"my-server"}`，删除实例目录、谱面、成绩及指向该实例的指定授权。默认实例 `default` 不可删除，返回 `422`。

## 6. 谱面管理

本节所有接口都应明确携带 `?instance=my-server`。

### 6.1 列表与下载

```http
GET /api/admin/charts?instance=my-server
GET /api/admin/download/-101?instance=my-server
```

列表需要 `chart.read`，返回谱面对象数组；不支持管理 API 的 `search/page` 分页筛选。下载需要 `chart.download`，直接返回二进制 PEZ，不能调用 `.json()` 解析。

```powershell
Invoke-PhiraAdmin $connection '/api/admin/download/-101?instance=my-server' `
    -OutFile 'C:\Charts\downloaded.pez'
```

谱面响应包含 `id,name,level,difficulty,charter,composer,illustrator,description,tags,listed,created,updated,chartUpdated` 等元数据，以及 `file,illustration,preview` 资源 URL。这些资源 URL 属于客户端接口；通过本机 HTTP 管理端口调用时，应使用管理下载接口，不要假定返回的 HTTPS 资源 URL 可直接使用本机 9000 端口。

### 6.2 上传单张谱面或合集

```http
POST /api/admin/charts?instance=my-server
```

需要 `chart.upload`。支持以下两种编码：

| 内容 | multipart/form-data 字段 | JSON 字段 |
| --- | --- | --- |
| 必填的谱面或合集文件 | `package`，文件字段 | `packageBase64`，标准 Base64 字符串 |
| 可选独立曲绘 | `illustration`，文件字段 | `illustrationBase64` |
| 可选独立音频 | `music`，文件字段 | `musicBase64` |
| 可选独立预览 | `preview`，文件字段 | `previewBase64` |
| 可选谱面 ID | `id`，整数文本 | `id`，整数 |
| 可选元数据 | `name,level,difficulty,charter,composer,illustrator,description,tags` | 同名字段 |

JSON 的 `tags` 建议使用字符串数组；multipart 的 `tags` 可以是逗号分隔文本或 JSON 数组文本。未填写的可识别元数据从包内 `info.yml/info.yaml/info.txt` 读取。使用 `FormData` 时让客户端自动设置带 boundary 的 Content-Type。

```javascript
// session 来自登录响应；file 来自 <input type="file">。
const form = new FormData();
form.set('package', file);
const response = await fetch('/api/admin/charts?instance=my-server', {
  method: 'POST', credentials: 'same-origin',
  headers: { 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrf },
  body: form,
});
const result = await response.json();
if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
```

单张上传成功 `201` 返回谱面对象。省略 `id` 会自动分配全平台未使用的 ID；ID 不能为 0。与其他实例冲突时返回 `409`；同实例重复等上传解析错误目前可能返回通用 `400`。不要依靠本地重复上传自动覆盖谱面。

没有 `chart.publish` 权限时，新上传内容自动 `listed:false`；有该权限时默认上架。上传接口不提供任意修改已有谱面的能力，更新请用 PATCH。

合集为外层 ZIP，其中各文件名为 `#<谱面ID>_<名称>.pez` 或 `.zip`。以包内 ID 和元数据为准；外层上传的单张元数据字段不逐项覆盖合集。支持部分成功：

```json
{
  "collection": true,
  "created": [{"id":-101,"name":"Example","listed":true}],
  "skipped": [{"file":"#-102_duplicate.zip","reason":"Chart ID is already used by another instance"}]
}
```

上例谱面对象为节选。HTTP `201` 不代表所有条目都成功，必须检查 `skipped`。外层 ZIP 的文件命名及内部资源结构详见 [README 谱面包格式](../README.md#谱面包格式)。

### 6.3 修改元数据、标签和上下架

```http
PATCH /api/admin/charts/-101?instance=my-server
```

```json
{"name":"Updated Chart","difficulty":15,"tags":["practice"],"listed":false}
```

也支持同语义 `PUT`。至少一个字段，允许字段及权限如下：

| 字段 | 权限 |
| --- | --- |
| `name,level,difficulty,charter,composer,illustrator,description` | `chart.edit` |
| `tags`，字符串数组 | `chart.tags` |
| `listed:true` | `chart.publish` |
| `listed:false` | `chart.hide` |

未知字段（包括 `id`、资源文件路径）不允许修改。混合字段必须全部通过权限检查；含 `listed` 的他人实例修改需要原因头，即使同时修改了名称。成功返回更新后的谱面对象。

### 6.4 批量标签

```http
POST /api/admin/charts/batch-tags?instance=my-server
```

```json
{"ids":[-101,-102],"mode":"add","tags":["practice"]}
```

需要 `chart.tags`。`mode` 为 `replace`（默认）、`add`、`remove`。目标可以是：

- `ids:[...]`：指定 ID。
- `matchTags:[...]`：现有标签须包含全部指定标签；匹配忽略大小写。
- `all:true`：当前实例全部谱面。
- 同时传 `ids` 和 `matchTags` 时取并集；`all:true` 优先。

兼容逗号分隔 `matchTag` 字符串。`tags` 必须存在；`replace` 加空数组可清空标签。响应为 `{ok:true, mode, updated:[更新后的谱面对象...]}`。

### 6.5 单张删除与批量删除

```http
DELETE /api/admin/charts/-101?instance=my-server
```

需要 `chart.delete`，响应为 `{ok:true,id:-101,recordsDeleted:3}`。同时删除谱面资源、关联成绩和评分。

```http
POST /api/admin/charts/batch-delete?instance=my-server
X-Admin-Confirm: delete
```

需要独立的 `chart.purge` 权限。三种选择方式：

```json
{"ids":[-101,-102]}
```

```json
{"tags":["obsolete","test"]}
```

```json
{"all":true}
```

标签删除匹配**任意一个**标签，忽略大小写；这与批量标签接口 `matchTags` 的“全部匹配”不同。兼容逗号分隔 `tag` 字符串。`ids` 与标签目标取并集，`all:true` 优先。响应为 `{ok:true,deletedIds:[...],recordsDeleted:数量}`；缺失 ID 不会计入实际删除列表。

## 7. 私有成绩

### 7.1 查询

```http
GET /api/admin/records?instance=my-server
GET /api/admin/records?instance=my-server&chart=-101&player=12345
GET /api/admin/leaderboard/-101?instance=my-server
```

均需 `record.read`。成绩数组按时间倒序返回，`chart` 和 `player` 可分别使用或组合使用。排行榜返回该谱面的私有排行数组；当前 SQLite 实现接受 `std` query 但不提供独立的 std 排序模式。

成绩响应字段使用客户端兼容形式，包括 `id,player,chart,score,accuracy,full_combo,max_combo,time,best` 等；不要假定响应字段名与手动录入的 `fullCombo/maxCombo` 完全相同。

### 7.2 手动录入

```http
POST /api/admin/records?instance=my-server
```

```json
{
  "player":12345,
  "chart":-101,
  "score":985000,
  "accuracy":0.985,
  "perfect":950,
  "good":20,
  "bad":3,
  "miss":2,
  "maxCombo":800,
  "fullCombo":false
}
```

需要 `record.create`，他人实例还需原因头。`chart` 必须已存在于所选实例；`player` 是玩家 ID，不是面板账号 ID。`score` 使用数字，范围 0–1000000；`accuracy` 推荐 0–1，兼容大于 1 且不超过 100 的百分比值。`accuracy:1` 表示 100%，要表示 1% 应传 `0.01`。判定数、连击字段建议传非负整数，`fullCombo` 传布尔值；其他兼容字段包括 `speed`（默认 1）、`mods`（默认 0）。

成功 `201` 返回创建的私有成绩对象。此接口不增加官方经验、官方 RKS 或官方排行，不替代客户端的 `/play/upload` token 验证流程。不要在请求超时后未经查询就重复录入。

### 7.3 删除成绩

```http
DELETE /api/admin/records/1600000001?instance=my-server
```

需要 `record.delete`，响应 `{ok:true,id:1600000001}`；删除后重新计算该玩家对应谱面的本地最佳成绩。没有提供批量删除成绩或直接 PATCH 成绩的管理接口。

## 8. 用户、审核和授权

所有 `/api/admin/users...` 接口首先要求 `user.read`。普通、进阶、高级成员不能访问别人的注册申请，不能通过请求参数给自己或他人提权。

### 8.1 用户列表

```http
GET /api/admin/users
```

返回可管理账号及自己的账号数组。管理员不会得到其他管理员和超级管理员的用户行；超级管理员看到全部。

基础字段包含 `id,username,role,level,disabled,approvalStatus,instanceLimit,instanceCount,created,permissionRevision,globalCapabilities`。列表仅在有 `application.read` 时包含 `application,applicationRevision,reviewNote,reviewedBy,reviewedAt`；仅超级管理员的列表包含他人的 `grants,assignedInstances`。自行筛选 `approvalStatus === 'pending'` 可得到待审核申请。

### 8.2 审核申请

```http
POST /api/admin/users/12/review
```

```json
{"revision":2,"decision":"approved","note":"用途说明完整，审核通过。"}
```

```json
{"revision":2,"decision":"rejected","note":"请补充团体名称和预计使用人数。"}
```

需要 `application.read`，以及 `review.approve` 或 `review.reject`。不能审核自己、同级/更高管理员、停用账号或非 pending 申请。

- `revision` 必须是最新用户对象的 **`applicationRevision`**，不是权限版本号。
- `decision` 只能是 `approved/rejected`。
- `note` 最多 1000 字；拒绝必须填写非空原因，通过时可省略。
- 成功返回更新后的用户对象；申请已变化、资料版本过旧或并发审核冲突返回 `409`。刷新并阅读新资料后再决定，不能自动替换 revision 重试审核。

### 8.3 申请历史

```http
GET /api/admin/users/12/history
```

需要 `application.read` 且可以管理目标账号，返回最近 50 条记录的数组：`actorId,action,note,created`，按时间对应的记录 ID 倒序排列。动作包括 `resubmit,approved,rejected,permissions`。此接口无分页；全量管理操作使用审计接口。

### 8.4 配额、停用与恢复

```http
PATCH /api/admin/users/12
```

```json
{"instanceLimit":5,"reason":"已确认需要维护五个独立谱面集合。"}
```

```json
{"disabled":true,"reason":"暂停该账号的管理访问以处理异常操作。"}
```

- `instanceLimit` 为 0–10000 的整数，**只有超级管理员能修改**。
- `disabled:true/false` 分别需要 `user.suspend/user.restore`；管理员只能操作低于管理员等级的其他账号。
- `reason` 必填，3–1000 字；其他字段不接受。
- 成功返回更新后的用户对象。停用撤销会话，恢复不会恢复旧会话；降低配额保留已有实例，配额为 0 禁止继续创建。

### 8.5 强制退出

```http
POST /api/admin/users/12/logout
```

```json
{"reason":"结束该成员所有设备上的旧会话。"}
```

需要 `user.logout`，成功 `{ok:true}`。目标账号仍可重新登录；要禁止重新登录应使用停用账号。管理员不能对自己、同级或超级管理员使用此接口。

### 8.6 删除账号

```http
DELETE /api/admin/users/12
X-Admin-Reason: 清理已确认不再使用的账号
X-Admin-Confirm: delete
```

**仅超级管理员可调用。**不能删除当前登录账号或超级管理员。成功返回
`{ok:true,id,username,instancesPreserved}`。账号、密码哈希、权限和所有登录会话会永久删除；
申请与审计历史继续保留。账号拥有的服务实例及其谱面、成绩不会删除，而是转为服务器所有。
该账号创建的 PMP+ 房间不会随账号删除，之后只允许超级管理员继续管理或解散。

### 8.7 等级与额外授权

```http
PATCH /api/admin/users/12/permissions
```

**仅超级管理员可调用。**示例：分配高级成员协作范围，并禁止下载该协作实例的谱面。

```json
{
  "level":"senior",
  "revision":3,
  "assignedInstances":["community"],
  "grants":[
    {
      "permission":"chart.download",
      "effect":"deny",
      "scope":"selected",
      "instanceIds":["community"],
      "expiresAt":null
    }
  ],
  "reason":"安排内容维护，暂不开放管理下载功能。"
}
```

这是**替换该用户整个等级/协作范围/额外授权配置**，不是逐条合并 grant 的 PATCH。成功返回更新后的用户对象，并增加 `permissionRevision`。规则如下：

| 字段 | 要求 |
| --- | --- |
| `level` | 必填：`ordinary/advanced/senior/manager`；不能提交 `super` |
| `revision` | 必填：当前用户对象的 **`permissionRevision`**；不匹配返回 `409` |
| `assignedInstances` | 可省略，默认 `[]`；最多 1000 个已存在实例 ID，作为进阶/高级成员的默认协作范围 |
| `grants` | 可省略，默认 `[]`；最多 200 条完整规则 |
| `reason` | 必填，3–1000 字 |

每条 grant：

| 字段 | 要求 |
| --- | --- |
| `permission` | 权限目录中的标识 |
| `effect` | `allow` 或 `deny` |
| `scope` | `selected`、`all`；API 也兼容 `own`，但不能撤销个人实例的基础能力 |
| `instanceIds` | 必填数组；selected 模式须非空、最多 1000 个已存在实例 ID；其他模式请传 `[]` |
| `expiresAt` | 必填：`null` 表示长期，或未来的 ISO 8601 时间，例如由客户端生成的 UTC 时间 |

为避免静态日期过期，可在调用时生成到期时间：

```powershell
$expiresAt = [DateTime]::UtcNow.AddDays(7).ToString('o')
```

拒绝规则到期后，相应默认权限或允许规则可能恢复；允许规则到期后，仅撤销该条额外允许，不会自动撤销等级默认能力。一次保存时不要把已过期 grant 原样回传，应该移除它或明确续期。

`user.* / application.* / review.*` 规则只允许 `level:manager, scope:all`，低等级显式授权仍返回 `422`。管理员默认权限不包括删除整个实例、批量清空、手动录入/删除他人成绩，需超级管理员按需要额外授予。

降级示例（清除协作范围和额外授权，保留配额）：

```json
{"level":"ordinary","revision":4,"reason":"结束临时协作，恢复普通成员权限。"}
```

因为省略 `assignedInstances/grants` 等同于清空，修改等级时要保留的规则必须明确回传。审批未通过或停用账号不能获得新权限；已有超级管理员账号不能通过该接口修改。

## 9. 多人房间监控与管理

房间列表接口使用管理会话，不接受浏览器提交的 `instanceId` 作为授权依据。服务端会先从 PMP 快照解析房间，再根据房间当前谱面反查实例；无权房间统一返回 `404`。

```http
GET /api/admin/monitor/rooms
GET /api/admin/monitor/rooms/{roomId}
```

网页多人观战功能已移除；上述接口保留只读房间列表、房间详情和 PMP 连接状态。

高级成员和管理员可以通过网关创建并管理自己拥有的 PMP+ 房间；超级管理员可以管理全部房间。
网页房间所有者由网关根据当前登录账号写入 `owner_id`，不能由浏览器指定，并且与 Phira
协议房主 `host_id` 相互独立。PMP 的 `x-admin-token` 只由网关服务端从 `PMP_ADMIN_TOKEN`
（未设置时使用 `ADMIN_TOKEN`）读取，不会返回给浏览器：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/admin/rooms` | 列出可管理的托管房和预约白名单房；超级管理员列出全部 |
| `POST /api/admin/rooms/hosted` | 创建或幂等取得长期托管房 |
| `POST /api/admin/rooms/precreate` | 创建一次性预约白名单房 |
| `GET/PATCH /api/admin/rooms/{roomId}/hosted` | 查询或更新托管房 |
| `POST /api/admin/rooms/{roomId}/max-users` | 修改容量 |
| `GET/PUT /api/admin/rooms/{roomId}/chart-pool` | 查询或替换本地随机谱池 |
| `POST /api/admin/rooms/{roomId}/chat` | 发送房间系统公告 |
| `POST /api/admin/rooms/{roomId}/disband` | 解散房间并删除托管定义 |

所有房间写操作都要求 `X-Admin-Reason`。托管房的 `allowedUserIds` 可以是空数组；为空时
该房间允许所有 Phira 玩家进入。预约白名单房仍必须包含至少一名玩家。`HOST_SELECT` 创建时
允许省略 `chart` 或传 `null`；`POOL_RANDOM` 需要至少一张 `chartPool` 谱面。谱面 ID 支持
非零正数及私有谱面使用的负数 ID。

```json
{
  "roomId": "practice-1",
  "allowedUserIds": [],
  "maxUsers": 4,
  "hostId": null,
  "chart": null,
  "chartMode": "HOST_SELECT",
  "chartPool": []
}
```

## 10. 操作审计

```http
GET /api/admin/audit
GET /api/admin/audit?before=420
```

```json
{
  "events":[
    {
      "id":421,
      "actorId":12,
      "instanceId":"my-server",
      "action":"PATCH /api/admin/charts/-101",
      "target":"/api/admin/charts/-101",
      "reason":"更新谱面信息。",
      "before":{},
      "after":{},
      "outcome":"success",
      "created":"2026-09-09T00:00:00.000Z"
    }
  ],
  "nextCursor":421
}
```

示例省略了实际 before/after 信息。下一页直接传响应的 `nextCursor`：例如 `?before=421`；不要用页码替代游标。

- `before` query 必须是正的安全整数，返回 ID 严格小于该值的记录，按 ID 倒序。
- 每页最多 50 条；权限过滤可能导致较少甚至空数组，但仍返回非空 `nextCursor`，此时可以继续翻页。`nextCursor:null` 才表示结束。
- 超级管理员查看全部。普通成员可查看自己实例的记录，包括已删除实例历史；协作者需对记录所属实例有 `audit.read`。管理员查看管辖范围内的记录。
- 注册、申请和权限变更记录不会通过此接口开放给低等级成员。实例被其他所有者以同名 ID 重建时，不会向新所有者开放旧所有者的历史。
- `instanceId:null` 表示账号类操作。`action` 包括 HTTP 方法与路径形式，也包括 `permissions.update,user.update,user.logout,registration.review,application.resubmit,account.create,account.password,chart.download`。
- `before/after` 是审计快照，不是稳定的业务对象 Schema。大批量详情最多保留 500 条，`detailsTruncated:true` 表示明细截断；总数仍保留。删除实例的 `after` 可以为 `null`。
- `outcome` 当前有 `success/failed`。日志覆盖已接入的管理写操作与管理下载，不等于记录了所有读取、未认证请求或每次权限拒绝。
- 没有删除或修改审计记录的管理 API。审计不包含密码、Cookie、完整上传包或成绩 token，也不用于恢复被删除的资源。

## 11. Phira 客户端接口

以下接口不在 `/api/admin` 下，**不要使用成员 Cookie/CSRF 替代 Phira 登录身份**。实例 query 参数不会给客户端授予权限或切换管理实例。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health` | 健康检查，`{ok:true}` |
| `GET /chart` | 代理官方列表，按可见范围合并符合条件的本地谱面 |
| `GET /chart/<谱面ID>` | 私有谱面详情 |
| `GET /private-charts/<谱面ID>.pez` | 私有谱面文件 |
| `GET /private-files/<谱面ID>/illustration.jpg` | 曲绘，实际扩展名也可能为 jpeg/png |
| `GET /private-files/<谱面ID>/music.mp3` | 音频，实际扩展名也可能为 ogg/wav |
| `GET /private-files/<谱面ID>/preview.mp3` | 预览音频，实际扩展名也可能为 ogg/wav |
| `POST /play/upload` | 客户端游玩后上传成绩 token；已注册私有谱面在本地处理 |
| `GET /record/best/<谱面ID>` | 当前玩家该谱面的私有最佳成绩 |
| `GET /record/list15/<谱面ID>` | 私有成绩排行 |
| `GET /record` | 客户端成绩查询，私有与官方分流由现有代理逻辑处理 |
| `GET /record/<成绩ID>` | 按成绩 ID 返回完整成绩；供 PMP 在游戏结束阶段校验玩家上报的成绩 |
| `GET /chart/<谱面ID>/rate` | 当前身份对私有谱面的评分 |
| `POST /chart/<谱面ID>/rate` | 私有评分，JSON `{"score":8}`，整数 0–10；PUT 也兼容 |
| `DELETE /chart/<谱面ID>/rate` | 删除当前身份的私有评分；提交 score 0 也可删除 |

资源支持读取及 HEAD，音频支持 Range，具体以返回的资源 URL 为准。明确禁用的实例会阻止对应客户端请求并返回 `503`；仅设置可见范围为 none 不会阻止直接详情和下载。

私有谱面详情和列表中的资源 URL 优先使用 `PUBLIC_BASE_URL`。当 PMP 通过 `http://127.0.0.1:9000` 回源时必须设置该值，否则资源地址会被错误生成为 `https://127.0.0.1:9000/...`。当前部署使用 `https://phira.5wyxi.com`。

`GET /chart` 的 `search` 搜索名称、等级、谱师、作曲、曲绘作者和标签；`tags` 要求全部匹配。本地谱面加入第一页，后续页不重复加入，count 会按符合条件的本地谱面调整。官方专用筛选条件可能排除本地谱面；不要把管理 API 的未分页列表与此客户端分页接口混用。

指定用户可见使用 Phira 登录请求中的 `Authorization` 向配置的官方上游 `/me` 验证 UID。验证成功短时缓存 60 秒，失败缓存 10 秒；可见范围每次请求重新读取。身份无法验证时不显示指定用户的实例，正常官方列表与所有人可见实例仍可显示。列表响应使用 `Cache-Control: private, no-store` 和 `Vary: Authorization`。

客户端 `/play/upload` 的 token 应由兼容的 Phira 客户端生成。面板手动录入接口不需要该 token；不要把两种成绩接口混为一谈。已注册的私有成绩请求不转发给官方，其余受现有透明代理逻辑处理。多人房间使用独立 TCP 服务，不属于本 HTTP API 文档。

`GET /record/<成绩ID>` 会先查当前域名对应实例，再查其他实例；命中后返回记录中的 `player`、`chart`、`score`、`accuracy`、判定统计及 `time` 等字段。尚未计算标准差的新成绩会把 `std/std_score` 输出为 `0`，以满足 PMP 的非空数值契约。网关不会根据请求头改写 `player`，PMP 会用该字段核对提交成绩的玩家。未命中的 ID 继续转发官方 API。

## 12. 错误码与重试

多数错误返回：

```json
{"error":"缺少权限：下载谱面"}
```

部分通用解析错误返回：

```json
{"ok":false,"error":"invalid admin request"}
```

错误消息不是稳定的机器错误编号。请先按 HTTP 状态码处理，并保留服务端 `error` 作为用户提示，不要只判断 JSON 中是否有 `ok`。

| 状态 | 常见原因 | 处理方式 |
| --- | --- | --- |
| `400` | 无效 JSON、包解析失败、缺少上传文件、部分重复 ID 等通用错误 | 核对请求体、文件编码和字段类型 |
| `401` | 未登录、会话失效、登录失败或账号停用 | 重新登录或联系管理员；不要用 CSRF 代替 Cookie |
| `403` | 未审核、无权限、选错实例、跨站 Origin、缺 CSRF/管理请求头 | 检查审批状态、入口、会话和 capabilities |
| `404` | 管理路径、谱面、成绩等对象不存在 | 检查路径、ID、实例；有些实例访问会先因权限返回 403 |
| `409` | 实例 ID 冲突、配额满、审核/权限版本过旧、重复初始化等 | 查询最新状态；涉及审核须人工重新查看资料 |
| `413` | 请求体超过上限 | 减小请求或改用 multipart；同时检查代理上传限制 |
| `422` | 字段校验失败、无操作原因、缺删除确认、禁止删除默认实例 | 按接口规则修正后重试 |
| `429` | 认证接口请求频率或密码计算并发限制 | 停止密集重试，稍后再试；频率窗口当前为 15 分钟 |
| `502` | 客户端代理请求的上游故障 | 检查上游连接，避免立即重复写请求 |
| `503` | 实例停用、私有成绩解码器未配置等 | 检查实例或服务器配置 |

认证限流按来源地址累计，当前每 15 分钟最多 20 次相关认证 POST 请求（退出除外），密码计算另有并发上限；注册、初始化、修改密码、补交申请等也可能计入。401/403 不应无限自动重试。

### 常见问题

- **登录成功，调用 dashboard 仍然 403？** 检查是否仍待审核，以及是否省略了 `?instance=自己的实例ID`。
- **拿到 csrf 但仍然 401？** HTTP 客户端没有保存/发送对应 Cookie，或协议、域名、端口入口发生变化。
- **高级成员怎么拿审核权限？** 不能单独授予，须由超级管理员调整为管理员等级。
- **上传成功却不出现在 Phira？** 检查实例启用、可见名单中的 Phira UID、谱面 listed、全局 listingEnabled；上传者无 publish 权限时自动下架。
- **普通管理员为什么不能改配额？** 配额、等级、授权和域名是超级管理员保留权限。
- **只有单张删除权限，调用 batch-delete 传一个 ID 为什么也不行？** 批量接口始终需要独立的 chart.purge 权限。
- **修改权限为什么丢失旧授权？** 该接口替换整个配置；省略 grants/assignedInstances 就是清空，保留时必须明确提交。
- **下载权限关闭后，已有公共资源 URL 还能下载？** 可以。管理下载权限和列表可见性都不是资源 URL 的访问控制。

## 13. 接口索引

| 方法 | 管理路径（统一 `/api/admin` 前缀） | 主要用途 |
| --- | --- | --- |
| GET | `/auth/status` | 初始化与注册状态 |
| POST | `/auth/register` | 提交注册申请 |
| POST | `/auth/login` | 登录 |
| POST | `/auth/setup` | 首次超级管理员初始化 |
| GET | `/auth/me` | 当前身份和 CSRF |
| POST | `/auth/logout` | 退出当前会话 |
| POST | `/auth/password` | 修改自己的密码 |
| POST | `/auth/application` | 补充并重交申请 |
| GET | `/permission-catalog` | 五级名称与 26 项权限目录 |
| GET | `/instances` | 可访问实例及有效权限 |
| POST | `/instances` | 创建自己的实例 |
| PATCH / PUT | `/instances/{id}` | 修改实例 |
| DELETE | `/instances/{id}` | 删除实例 |
| GET | `/dashboard?instance=...` | 实例概况和可读取的数据 |
| GET | `/charts?instance=...` | 谱面列表 |
| POST | `/charts?instance=...` | 上传单张谱面或合集 |
| PATCH / PUT | `/charts/{id}?instance=...` | 修改谱面、标签和上下架 |
| DELETE | `/charts/{id}?instance=...` | 删除单张谱面 |
| POST | `/charts/batch-tags?instance=...` | 批量标签 |
| POST | `/charts/batch-delete?instance=...` | 批量删除 |
| GET | `/download/{id}?instance=...` | 二进制谱面下载 |
| GET | `/records?instance=...` | 查询私有成绩 |
| POST | `/records?instance=...` | 手动录入私有成绩 |
| DELETE | `/records/{id}?instance=...` | 删除私有成绩 |
| GET | `/leaderboard/{chartId}?instance=...` | 私有谱面排行 |
| GET | `/users` | 管辖范围内用户列表 |
| PATCH | `/users/{id}` | 配额与账号状态 |
| DELETE | `/users/{id}` | 超级管理员永久删除账号并保留其实例 |
| POST | `/users/{id}/review` | 注册审核 |
| GET | `/users/{id}/history` | 申请与授权历史 |
| PATCH | `/users/{id}/permissions` | 等级与细分授权 |
| POST | `/users/{id}/logout` | 强制用户退出 |
| GET | `/audit?before=...` | 有权限范围内的操作记录 |
| GET | `/monitor/rooms` | 有权限房间列表与监控状态 |
| GET | `/monitor/rooms/{roomId}` | 房间详情 |

实现入口：[请求路由](../src/index.ts)、[账号与会话](../src/admin-accounts.ts)、[权限模型](../src/admin-policy.ts)、[实例存储](../src/instances.ts)。功能回归见 [权限测试](../scripts/test-admin-policy.js)、[账号测试](../scripts/test-admin-accounts.js)、[可见范围测试](../scripts/test-instance-visibility.js)。
