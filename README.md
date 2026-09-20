# Phira 本地谱面管理系统

一个面向原版 Phira 客户端的本地谱面管理系统，提供谱面管理与分发、本地成绩和多人房间服务。

项目与 Phira 客户端/API 有关。

## 特性

- 透明转发官方 Phira API 请求
- 提供本地 Chart metadata 和谱面资源
- 通过管理页面上传 `.pez` 或 `.zip` 谱面包
- 自动读取 `info.yml`、`info.yaml` 或 `info.txt` 中的谱面信息和谱师信息
- 自动提取曲绘、音乐和预览音频
- 本地成绩上传、删除和排行榜查询
- 本地谱面注入在线列表和搜索结果
- 多人房间和本地谱面选谱
- 支持 Windows、Linux 和 macOS

## 架构

```text
Phira 客户端
      |
      | HTTPS
      v
Node.js Gateway
   |          |
   |          +--> 本地 Chart metadata 和本地资源
   |
   +--------------> 官方 Phira API

Phira 客户端 -- TCP:12356 --> mp-server/PMP+
```

普通请求继续转发到官方 API，私有 chart ID 由 Gateway 本地处理。

## 安装

需要 Node.js 22.5 或更高版本（使用内置 SQLite 支持）。

```bash
git clone https://github.com/AmaoQWQ/phira-private-chart.git
cd phira-private-chart
npm install
npm run build
```

## 启动

### Windows

```powershell
.\start-probe.cmd
```

也可以直接运行：

```powershell
npm.cmd run start:quick
```

停止服务：

```powershell
.\stop-probe.cmd
```

### Linux / macOS

```bash
npm run build
npm start
```

默认 HTTPS 端口为 443。443 已被占用时，Windows 启动脚本会自动使用 8443。多人游戏仅由 `mp-server/PMP+` 提供，默认监听 TCP 12356；网关内置多人实现默认关闭，仅保留协议回归测试。

## 配置

配置通过项目根目录的 `.env` 文件或环境变量设置，变量示例见 [.env.example](.env.example)。程序启动时会自动读取 `.env`；如果同时设置了系统环境变量，系统环境变量优先。

常用配置：

```text
HOST=0.0.0.0
PORT=443
ADMIN_PORT=9000
UPSTREAM_BASE_URL=https://phira.5wyxi.com
PUBLIC_BASE_URL=https://your-phira-api.example.com
PRIVATE_CHARTS_PATH=data/private-charts
INSTANCE_REGISTRY_PATH=data/instances/instances.json
PRIVATE_CHART_LISTING=true
PRIVATE_RECORDS_PATH=data/private-records/records.json
PRIVATE_RECORDS_DB_PATH=data/private-records/records.sqlite
PRIVATE_RECORD_VERIFICATION_KEY_PATH=decoder/record-verification-key.bin
PRIVATE_RECORD_DECODER_PLUGIN=decoder/decoder-dist/private-upload-adapter.js
ADMIN_TOKEN=your-admin-token
MULTIPLAYER_ENABLED=false
MULTIPLAYER_HOST=0.0.0.0
MULTIPLAYER_PORT=12348
PMP_MONITOR_ENABLED=true
PMP_BASE_URL=http://127.0.0.1:12357
PMP_ROOMS_SNAPSHOT_PATH=/api/rooms/info
PMP_EVENTS_PATH=/api/rooms/listen
```

PowerShell 启动示例：

```powershell
$env:ADMIN_TOKEN = "your-admin-token"
$env:PRIVATE_CHART_LISTING = "true"
.\start-probe.cmd
```

## 管理页面

服务启动后在服务器本机访问：

```text
http://127.0.0.1:9000/admin
```

例如：

```text
http://127.0.0.1:9000/admin
```

注册制管理页面同时提供于本机 `http://127.0.0.1:9000/admin` 和现有 HTTPS Gateway 的 `/admin`（当前使用 8443 端口）。本机管理端口仍绑定回环地址；公网用户使用服务器现有域名与 HTTPS 端口访问，不需要开放 9000。域名、证书与反向代理配置不会自动更改。

首次使用时，服务器所有者展开登录页的“初始化超级管理员”，输入现有 `ADMIN_TOKEN`，再设置自己的用户名和密码。初始化只允许成功一次，普通注册或抢先注册不会获得管理员权限。之后使用账号密码登录；管理面板账号独立于 Phira 官方账号。

普通用户可以公开提交注册申请，**通过审核后**默认实例配额为 **2**，只能管理自己创建的实例及其中的谱面、成绩。实例归属由服务端设置，配额也由服务端检查（含并发请求）。超级管理员可管理全部实例，在“用户与注册审核”中修改每人的配额（0–10000）、停用/恢复或永久删除账号。降低配额不会删除已有实例；停用账号会撤销登录会话并禁止登录，数据保留。删除账号时，其服务实例和数据会保留并转为服务器所有。默认实例和升级前已有实例由超级管理员管理。

注册时需填写注册原因（10–2000 字）、个人/团体用途、社交平台及账号；团体用途还需填写团体名称，可补充使用人数、作品或介绍。申请状态分为待审核、已通过和已拒绝。待审核或被拒绝用户可登录查看状态、修改密码、补充资料并重新提交，但不能调用实例、谱面、成绩管理接口。拒绝时必须填写原因，申请人可以查看。审核会校验资料版本，申请人修改资料后，审核员必须刷新再审；并发审核只允许一个结果成功保存。

超级管理员通过 **用户与注册审核 → 等级与权限** 配置五级制度：

| 等级 | 默认职责与范围 |
| --- | --- |
| 普通成员 | 管理自己的实例、谱面和私有成绩 |
| 进阶成员 | 在自己的实例之外，协助维护指定实例的谱面，查看成绩与操作记录 |
| 高级成员 | 维护指定实例，可创建和管理自己拥有的多人房间；可由超级管理员额外授予启停等操作，不能查看或审核注册 |
| 管理员 | 查看、审核注册，管理普通/进阶/高级成员的账号与实例，可停用/恢复账号、强制退出、调整实例可见范围与上下架、删除单张谱面 |
| 超级管理员 | 全平台管理；只有服务器所有者能调整等级、额外授权、配额、域名和永久删除账号 |

所有成员自己的实例管理能力保持不变。升级等级不会自动增加创建配额，默认仍为 2；降配额不删除数据。管理员默认不能管理其他管理员、超级管理员或服务器所有的实例；这些实例如需协作，由超级管理员明确指定范围。管理员不能操作同级或超级管理员账号，也不能转授权限。

26 项可分配操作及风险等级由 `GET /api/admin/permission-catalog` 提供。查看、下载、上传、编辑信息、标签、上架、下架、单张删除、批量清空、成绩查看/录入/删除、实例改名/可见范围/启停/删除和用户管理均分别校验。操作其他实例须同时有 `instance.read` 及相应操作权限；授予查看不自动授予其他操作。上传者没有上架权限时，新上传的谱面和合集条目自动保持下架。

额外规则支持“允许/禁止”、指定实例或全部适用对象，以及可选到期时间。个人实例基础能力保留；在其他范围，禁止规则优先于默认和额外允许。到期、撤权、降级均由每次请求的服务端检查执行。修改权限需要资料版本号和原因，避免两个编辑窗口相互覆盖；等级变更时面板清空旧的协作范围和额外授权，需保留的规则由超级管理员重新明确添加。删除实例会移除指向该实例的协作授权，重建同名实例不会继承旧授权。

**注册申请资料、社交账号、申请历史以及通过/拒绝权限只向管理员和超级管理员开放，普通、进阶、高级成员不能通过额外授权绕过这一上限。**申请人仍能查看自己的申请状态和拒绝原因。待审核、被拒绝和被停用状态优先于等级及授权；只有已通过审核且正常的账号能获得新增权限。

管理他人的可见范围、启停、删除和成绩等高风险操作需要填写 3–1000 字原因。修改账号、配额和权限也需要原因。删除整个实例要求 `X-Admin-Confirm` 为该实例 ID，批量删除和删除账号要求值为 `delete`；面板仍显示影响范围并要求输入“删除”。操作原因通过 URL 编码后的 `X-Admin-Reason` 请求头传递；账号和权限接口使用 JSON `reason` 字段，删除账号使用 `X-Admin-Reason`。默认实例继续不可删除。

“操作记录”按权限范围展示操作者、时间、目标、原因、结果和变更前后信息，支持翻页；无删除/修改审计记录的管理接口。大批量操作保留总数，明细最多 500 条，并以 `detailsTruncated` 标记；审计不是资源备份。口令、Cookie、请求体中的谱面包和成绩 token 不写入审计。退出或切换账号时清除页面中的缓存记录。

升级时保留现有账号、超级管理员、审批状态和配额。旧“审核注册”授权迁移为管理员等级及等价权限规则，不自动获得停用账号等新权限；旧的纯实例管理授权迁移为高级成员及原有范围的明确授权。旧的两个布尔授权参数不再接受，须使用新格式。

普通用户不能修改域名绑定；该设置由超级管理员维护。面板账号管理权限与 Phira 客户端身份分开：实例可按 Phira UID 设置在线列表的可见范围，不使用面板账号 ID 识别游戏用户。

账号、密码哈希和会话存储在实例注册表同目录的 `accounts.sqlite` 中。密码采用随机盐与 scrypt；会话使用 HttpOnly、SameSite Cookie，公网 HTTPS 额外设置 Secure。登录有效期为 7 天，退出、账号停用或修改密码会撤销相应会话。密码和会话凭据不会保存在浏览器 localStorage，也不写入请求日志。

管理台分为谱面库、上传谱面、私有成绩、服务实例和连接与设置。顶部可切换当前实例，谱面支持关键词、标签、显示状态筛选和分页；勾选后可跨页批量修改标签或删除。行内可编辑谱面信息、切换在线显示和下载当前实例的 PEZ。删除前会显示影响范围，并要求输入“删除”确认。

上传页支持拖入单个 PEZ/ZIP 或合集 ZIP，导入结果会保留新增数量及跳过文件的原因。成绩准确率以百分比显示，手动录入时也使用 0–100%。在“连接与设置”可修改密码，修改成功后所有会话退出。

页面支持：

- 上传 `.pez` 或 `.zip` 谱面包
- 修改谱面名称、等级、难度、谱师、作曲和曲绘作者
- 查看私有谱面
- 手动上传成绩
- 查看和删除成绩
- 删除谱面及其本地资源

## 多实例谱面服务

管理页面中的“谱面服务实例”用于隔离不同的谱面集合和成绩数据。每个实例拥有独立的：

- 谱面 metadata 和资源目录
- 成绩与排行榜 SQLite 数据库
- 域名映射和启用状态

创建实例时填写实例 ID、名称和域名，例如：

```text
实例 ID：community
名称：Community Charts
域名：community.example.com
```

域名是可选的旧入口映射，按用户控制显示不需要为每个实例配置域名。设置了明确可见范围的实例会在同一个 Gateway 入口按当前 Phira 用户合并列表。未设置范围的旧实例保留原来的行为：匹配域名时显示对应实例，没有匹配时显示 `default`。全局唯一的私有谱面 ID 用于定位详情、资源及该谱面的成绩所属实例。

### 按 Phira 用户设置可见范围

进入 **服务实例 → 设置 → Phira 可见范围**，或者在创建实例时选择：

- **所有人可见**：使用该 Gateway 的所有用户均可在在线列表和搜索中看到该实例已上架的谱面。
- **指定用户可见**：填写一个或多个 Phira UID，支持逗号、空格或换行分隔，最多 1000 个。例如 `12345, 67890` 仅向这两个 Phira 账号显示。
- **所有人不可见**：该实例的谱面不加入任何用户的在线列表或搜索。

新实例默认所有人不可见。旧实例显示“保留原有入口显示”，编辑其他字段不会改变原有显示范围；选择上述三项后应用新规则。实例所有者、拥有“管理所有实例”权限的人员和超级管理员可以修改范围。

指定用户须在 Phira 客户端登录。Gateway 使用客户端登录凭据向配置的官方上游 `/me` 验证 UID，不信任请求参数中的 UID、面板会话或本地成绩身份绑定。官方身份短暂不可验证时，仅隐藏指定用户范围的实例；正常的官方列表与所有人可见实例继续显示。身份验证结果短时缓存，但每次列表请求都读取当前可见范围；修改设置后刷新在线列表即可生效。

该功能只控制在线列表与搜索中的显示，不限制直接详情和资源链接，也不撤回已下载的谱面。显示还要求实例已启用、谱面自身已上架，以及服务器总开关 `PRIVATE_CHART_LISTING=true`。设置可见范围不改变管理面板的实例归属和权限。

为使同一入口能正确定位跨实例的资源与成绩，新上传谱面的 ID 必须在所有实例中唯一；留空会自动分配未被其他实例使用的 ID，合集里的重复 ID 会跳过。旧的重复 ID 不自动修改，仍仅在原域名入口显示；无法唯一定位时返回冲突错误，不转发给官方。

实例数据默认存放在：

```text
data/instances/<instance-id>/
├── charts/
├── records.sqlite
├── records.json
└── token-capture.jsonl
```

`default` 实例继续使用原来的 `PRIVATE_CHARTS_PATH`、`PRIVATE_RECORDS_DB_PATH` 等配置，不会自动迁移已有谱面或成绩。禁用实例后，该实例的公网请求返回 `503`，管理页面仍可查看和修改；默认实例不能删除。

## 谱面包格式

上传一个单独的 `.pez` 或 `.zip` 文件即可：

```text
chart.pez
```

也支持批量谱面合集。合集是一个外层 ZIP，内部每个文件是一个 `.pez` 或 `.zip` 谱面包，文件名使用以下格式：

```text
#<chart-id>_<chart-name>.pez
#<chart-id>_<chart-name>.zip
```

上传合集后，服务端会从每个文件名提取 `chart-id`，并分别注册每张谱面。正数和负数 ID 都支持；单个谱面包或合集内的每个谱面都可以通过 `info.yml`、`info.yaml` 或 `info.txt` 提供名称、等级、难度和谱师信息。

单个谱面包推荐的包内结构：

```text
info.yml
<chart>.json
<music>.mp3、.ogg 或 .wav
<illustration>.jpg、.jpeg 或 .png
```

`info.yml` 示例：

```yaml
name: Example Chart
level: AT Lv.17
difficulty: 17.0
charter: Example Charter
composer: Example Composer
illustrator: Example Artist
```

`name`、`level`、`difficulty`、`charter`、`composer` 和 `illustrator` 会自动读取，也可以在管理页面中修改。文本格式支持 `key: value` 和 `key=value`。

服务端会保留原始谱面包，并提取包内的图片和音频。支持 `info.yml`、`info.yaml`、`info.txt`，曲绘支持 JPG/JPEG/PNG，音频支持 MP3/OGG/WAV；没有独立预览音频时，会使用音乐文件作为预览。资源 URL 会使用实际文件类型并返回对应的 `Content-Type`。

对于使用 `info.txt` 的谱面包，服务端会在派生的 PEZ 包中生成标准 `info.yml`。如果谱面 JSON 引用了包内缺失的默认 `line.png`，服务端会补入兼容纹理；包中已有的故事板、纹理和其他资源会原样保留。

## 管理 API

完整参考见 **[API 文档](docs/API.md)**，包含成员登录、Cookie/CSRF、五级权限、实例选择、全部管理接口、字段校验、响应结构、错误码和客户端接口说明。

- [成员快速开始](docs/API.md#2-成员快速开始)：登录、创建实例、上传谱面和设置 Phira 可见 UID。
- [PowerShell 示例客户端](examples/member-api.ps1)：适用于 Windows PowerShell 5.1 / PowerShell 7，自动管理会话和 JSON 编码。
- [接口索引](docs/API.md#12-接口索引)：查找全部管理路径。
- [管理员审核与授权](docs/API.md#8-用户审核和授权)：审核版本、权限版本、额外授权和强制退出。
- [错误码与常见问题](docs/API.md#11-错误码与重试)：排查登录后 403、缺少原因、未带删除确认、上传后不可见等问题。

成员通过自己的面板账号登录，在同一入口使用会话 Cookie；写请求还需管理请求头和同一会话的 CSRF 值。谱面、成绩及下载接口明确传入 `?instance=自己的实例ID`。原 `ADMIN_TOKEN` 仅兼容本机维护入口，不能用于公网成员认证。

## Chart ID

私有谱面 ID 必须是非零的 32 位有符号整数，支持正数和负数。

管理页面中填写负数 ID 时，详情、资源、成绩和排行榜接口都会使用同一个负数 ID。留空时服务端自动分配正数 ID。

## 客户端使用的私有接口

上传谱面后，客户端会使用以下接口：

```http
GET /chart/<chart-id>
GET /private-charts/<chart-id>.pez
GET /private-files/<chart-id>/illustration.jpg|jpeg|png
GET /private-files/<chart-id>/music.mp3|ogg|wav
GET /private-files/<chart-id>/preview.mp3|ogg|wav
GET /record/best/<chart-id>
GET /record/list15/<chart-id>
GET /chart/<chart-id>/rate
POST /chart/<chart-id>/rate
DELETE /chart/<chart-id>/rate
```

音频资源支持 Range 请求，适用于在线播放和分段下载。

### 私人成绩玩家资料

私人成绩仍使用原始玩家 ID 关联玩家。客户端请求该玩家资料时，Gateway 会读取对应的公开名称和头像，并在名称后追加 `-P`，用于区分本地成绩玩家，例如 `AmaoQWQ-P`。如果公开资料暂时无法读取，则显示本地兜底名称；玩家资料会缓存在本地成绩数据中。

### 谱面评分

评分接口使用 0 到 10 的整数分数。客户端读取当前用户评分时返回 `{"score":0}` 表示尚未评分；提交评分示例：

```http
POST /chart/<chart-id>/rate
Content-Type: application/json
Authorization: Bearer <登录凭据>

{"score":8}
```

提交 `score: 0` 或使用 `DELETE` 会删除当前用户的评分。谱面详情中的 `rating` 是 0 到 1 的平均分，`ratingCount` 是评分人数。评分仅对已登记的私有谱面在本地保存，不会转发到官方服务。

## 在线列表和搜索

开启：

```text
PRIVATE_CHART_LISTING=true
```

开启后，Gateway 会把本地私有谱面加入官方 `/chart` 列表的第一页，并支持按以下内容搜索：

- 谱面名称
- 等级
- 谱师
- 作曲
- 曲绘作者
- 标签

关闭：

```text
PRIVATE_CHART_LISTING=false
```

关闭后，官方列表恢复透明转发，私有详情和资源接口仍然可用。

## 多人房间

多人游戏仅使用 `mp-server/PMP+`，默认 TCP 端口为 12356：

```text
<服务器地址>:12356
```

仓库包含当前兼容版本的 PMP+ 源码快照，但不会提交真实数据库连接、管理令牌、插件和运行数据。首次部署时先复制示例配置，再填写本机值：

```powershell
Copy-Item mp-server/server_config.example.yml mp-server/server_config.yml
Copy-Item mp-server/docker-compose.example.yml mp-server/docker-compose.yml
```

使用 Docker Compose 时还需在本机设置 `PMP_POSTGRES_PASSWORD`；不要把真实密码写回示例文件或提交到 Git。

PMP+ 负责完整房间状态、玩家与 monitor 身份、选谱、准备、同步开局、判定与成绩流程。Windows 下运行 `start-probe.cmd` 或 `npm.cmd run start:quick` 会先确认 PMP+ 启动成功，再启动网关；`stop-probe.cmd` 会停止两项服务。

管理面板的“多人房间”页面已接入 PMP+ 原生管理接口。高级成员和管理员可以创建并管理自己拥有的长期托管房或一次性预约白名单房，超级管理员可以管理全部房间；网页房间所有者与 Phira 协议房主相互独立。托管房玩家 UID 可留空，留空表示所有玩家均可进入；预约白名单房仍要求填写玩家 UID。可管理字段包括白名单、容量、协议房主、谱面模式和本地随机谱池，也可发送公告和解散房间。网关只在服务端使用 `PMP_ADMIN_TOKEN`，不会把 PMP 管理令牌交给浏览器；未单独设置时使用 `ADMIN_TOKEN`。长期托管房定义（含网页所有者）存放在 PMP+ 的 PostgreSQL 中，网关不复制房间数据。

基本流程：

1. 创建房间
2. 加入房间
3. 房主选择谱面
4. 玩家准备
5. 同步开始
6. 广播游戏状态和结果

私有谱面会广播本地 chart ID，两台客户端从同一个 Gateway 下载谱面资源。

## 数据存储

```text
data/private-charts/
├── charts.json
└── <chart-id>/
    ├── chart-package.pez
    ├── illustration.jpg|jpeg|png
    ├── music.mp3|ogg|wav
    └── preview.mp3|ogg|wav

data/private-records/records.json
data/private-records/records.sqlite
```

成绩、评分、玩家资料和身份绑定保存在 `data/private-records/records.sqlite` 中。首次启动时，如果存在旧的 `records.json`，服务会自动迁移数据；原 JSON 文件会保留作为备份。

## 测试

`node scripts/test-admin-policy.js` 使用隔离数据库和临时端口验证五级上限、指定范围、过期授权、禁止优先、原子字段检查、上传不越过上架权限、管理员保护、操作原因、删除确认、强制退出、审计隔离、降级、实例重建及重启持久化。`scripts/test-admin-ui.js` 还覆盖等级编辑、指定实例授权、审核入口限制、手机布局和操作记录页面。

`node scripts/test-instance-visibility.js` 使用隔离数据和本地模拟 HTTPS 上游，验证单个/多个 UID、全部可见/隐藏、身份验证和伪造拦截、缓存、搜索与分页、跨实例资源和成绩定位，以及全局 ID 唯一性，不请求官方 API。浏览器回归包含可见范围选择和保存，预览位于 `artifacts/admin-ui/visibility.png`。

`node scripts/test-admin-accounts.js` 使用完全隔离的数据库和临时端口，验证旧账号迁移、注册资料、审核/拒绝/重提、过期资料与并发审核、授权和撤权，以及会话、越权拦截、并发配额、CSRF、账号停用、永久删除、实例保留与密码修改，不使用生产令牌或用户数据。浏览器回归还覆盖申请资料展示、授权人员实际审核和权限变更后的界面。

管理台浏览器回归使用 Playwright 和已安装的 Microsoft Edge。先构建项目，再运行 `node scripts/test-admin-ui.js`；若 Playwright 安装在项目之外，可通过 `ADMIN_UI_PLAYWRIGHT_PATH` 指定其模块目录。测试会创建随机命名的隔离数据目录和临时端口，退出时清理测试数据，不读取生产令牌。仅含合成数据的桌面、手机与上传页截图输出到 `artifacts/admin-ui/`。

```bash
npm run build
npm run test:multiplayer
npm run test:rating
```

健康检查：

```bash
curl -k https://127.0.0.1:8443/health
```

## License

## 成绩解码器插件与无密钥运行模式

成绩上传解码器通过 `PRIVATE_RECORD_DECODER_PLUGIN` 作为可选插件加载，默认使用：

```text
decoder/decoder-dist/private-upload-adapter.js
```

真实验签还需要配置：

```text
PRIVATE_RECORD_VERIFICATION_KEY_PATH=decoder/record-verification-key.bin
```

`decoder/record-verification-key.bin` 已由 `.gitignore` 排除，不应提交到 GitHub。没有这个密钥，或解码器插件不存在时，网关仍然可以正常启动；注册私有谱面的成绩上传会返回兼容客户端的成功响应，但不会验签，也不会保存成绩。这是本地开发/演示用的假成功模式，不能用于生产环境，否则任何人都可以伪造上传结果。

如果要启用真实成绩验证，请同时提供密钥和插件，并重启网关。插件可以导出 `handlePrivateUpload`，并从同目录的 `phira-record-decoder.js` 导出 `decodePhiraRecordToken`；也可以在同一个模块中导出两个函数。

本项目代码使用 [MIT License](LICENSE) 发布。该许可证只适用于本项目自有代码，不适用于谱面、音乐、曲绘或其他第三方内容。
