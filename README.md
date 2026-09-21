# Phira 本地谱面管理系统

这是一个面向 Phira 的自建谱面服务。你可以用网页管理谱面、成员、服务实例和本地成绩，并让 Phira 客户端从你的服务器浏览和下载谱面。多人房间由可选的定制版 PMP+ 提供。

> [!IMPORTANT]
> 本项目不是 Phira 官方项目，与 Phira 官方不存在隶属、授权或背书关系。部署者必须确认自己有权分发上传的谱面、音乐、曲绘和其他内容，并遵守 Phira 的相关规则。

## 能做什么

- 通过网页上传、编辑、下载和删除 `.pez` 或 `.zip` 谱面包
- 将自建谱面加入 Phira 的在线列表和搜索结果
- 自动读取谱面信息，提取曲绘、音乐和预览音频
- 管理本地成绩、排行榜和谱面评分
- 创建多个相互隔离的谱面服务实例
- 创建成员账号，审核注册申请并分配管理权限
- 接入定制版 PMP+，创建和管理多人房间
- 在 Windows、Linux 和 macOS 上运行

## 开始前先了解

项目分为一个必需服务和几个可选组件：

| 组件 | 是否必需 | 用途 |
| --- | --- | --- |
| 网页管理与谱面 Gateway | 必需 | 管理谱面、账号、实例、成绩，并响应 Phira 客户端请求 |
| 定制版 PMP+ | 可选 | 提供多人房间；需要 PostgreSQL |
| 谱面预览渲染器 | 可选 | 在管理页面预览谱面；需要另外构建 |
| 成绩令牌验证材料 | 可选 | 自动验证兼容客户端上传的私有成绩；验证密钥不会包含在公开仓库中 |

只想先看看管理页面时，不需要安装 PMP+、PostgreSQL、Rust 或成绩验证密钥。

## Windows 快速开始

### 1. 安装运行环境

需要：

- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org/) 22.13 或更高版本

安装 Node.js 后请重新打开终端，确保以下命令可以运行：

```powershell
node --version
npm.cmd --version
```

### 2. 下载项目

```powershell
git clone https://github.com/AmaoQWQ/Phira-Local-Chart-Manager.git
cd Phira-Local-Chart-Manager
```

### 3. 创建配置文件

```powershell
npm.cmd run setup
```

该命令会从 `.env.example` 创建不会提交到 Git 的 `.env`，并分别生成随机的 `ADMIN_TOKEN`、`PMP_ADMIN_TOKEN` 和 `HSN_SECRET_KEY`。如果直接双击 `start-probe.cmd`，启动脚本也会自动完成这一步。

本机测试可以直接使用生成的配置。`.env.example` 中的 `PUBLIC_BASE_URL` 默认留空，此时服务会根据每次请求的 Host 生成谱面资源链接。

准备让原版 Phira 客户端接入时，再用文本编辑器打开 `.env`，明确设置：

```env
PUBLIC_BASE_URL=https://phira.5wyxi.com
```

这不是把官方服务设为上游，而是在返回的私有谱面信息中写入玩家真正访问的外部地址。原版 Phira 的接入还必须使用外部 `443` 端口和 DNS 改写，完整说明见下方“Phira 客户端网络模型”。自定义客户端若允许修改 API 地址，才应在这里填写你自己的域名。

`ADMIN_TOKEN` 用于证明你是服务器所有者。首次初始化管理员时需要从 `.env` 复制它；不要把真实值发给别人或提交到 GitHub。已有 `.env` 不会被初始化命令覆盖。

### 4. 启动服务

双击 `start-probe.cmd`，或者在 PowerShell 中运行：

```powershell
.\start-probe.cmd
```

第一次启动时，脚本会自动：

1. 检查 Node.js 版本，并在缺少 `.env` 时生成本机配置和随机密钥。
2. 安装 Node.js 依赖。
3. 生成本机测试用的自签名 HTTPS 证书。
4. 编译 TypeScript。
5. 尝试启动可选的 PMP+。
6. 启动网页管理与谱面服务。

没有安装 PMP+ 时会出现提示，但网页管理服务仍会正常启动，只是多人房间暂不可用。

启动脚本不会自动打开浏览器。默认管理地址为：

- `http://127.0.0.1:9000/admin`：仅供服务器本机管理
- `https://localhost/admin`：HTTPS 管理入口

自签名证书会触发浏览器安全警告，这是本机测试环境的正常现象。启动脚本生成的测试证书同时包含 `localhost` 和 `phira.5wyxi.com`。不要把忽略证书警告当成普通公网网站的安全做法。

如果启动失败，并且 `logs/server-error.log` 出现 `EADDRINUSE` 或 `EACCES`，表示 `443` 已被占用或当前账号不能监听该端口。本机测试可在 `.env` 中改为 `PORT=8443`，重启后访问 `https://localhost:8443/admin`；原版 Phira 接入仍必须保证外部 `443` 能到达 Gateway。

### 5. 创建第一个管理员

第一次打开管理页面时：

1. 展开“初始化超级管理员”。
2. 在“现有管理令牌”中填写 `.env` 里的 `ADMIN_TOKEN`。
3. 设置管理员用户名和至少 10 个字符的密码。
4. 提交后使用新账号进入管理面板。

以后登录管理面板使用用户名和密码，不需要把 `ADMIN_TOKEN` 交给普通成员。

### 6. 停止服务

双击 `stop-probe.cmd`，或者运行：

```powershell
.\stop-probe.cmd
```

服务日志保存在 `logs/`。本地谱面、账号和成绩等运行数据保存在 `data/`，这两个目录都不应提交到 GitHub。

## Linux / macOS 快速开始

安装 Git 和 Node.js 22.13 或更高版本，然后运行：

```bash
git clone https://github.com/AmaoQWQ/Phira-Local-Chart-Manager.git
cd Phira-Local-Chart-Manager
npm install
npm run setup
```

初始化命令会生成独立的管理令牌和 PMP+ 密钥。Linux 和 macOS 的普通用户通常不能直接监听 443 端口，本机浏览器测试可在 `.env` 中将 `PORT` 改为 `8443`，然后访问 `https://localhost:8443/admin`。`PUBLIC_BASE_URL` 留空即可跟随请求入口。

生成测试证书、编译并启动：

```bash
npm run cert:generate
npm run build
npm start
```

此方式在前台运行，按 `Ctrl+C` 停止。公网部署建议使用 systemd、容器或其他进程管理器。若 Gateway 内部监听 `8443`，还需要用路由器端口映射或反向代理把外部 `443` 转到该端口；DNS 改写本身不能转换端口。

## 常用命令

Windows PowerShell 可将下面的 `npm` 换成 `npm.cmd`。

| 命令 | 作用 |
| --- | --- |
| `npm run setup` | 首次创建 `.env` 并生成随机管理令牌和密钥 |
| `npm run build` | 编译项目 |
| `npm run start:gateway` | 在后台只启动网页与谱面服务 |
| `npm run start:quick` | 尝试启动 PMP+，然后启动网页与谱面服务 |
| `npm run install:pmp` | 下载并校验配套的定制版 PMP+ |
| `npm run start:pmp` | 单独启动 PMP+ |
| `npm run status:pmp` | 检查 PMP+ 进程与端口 |
| `npm run stop` | 停止本项目管理的 Gateway 和 PMP+ |

## 基本使用流程

进入管理页面后，通常按以下顺序操作：

1. 创建或选择一个服务实例。
2. 上传单张谱面包或批量合集。
3. 检查名称、难度、谱师、作曲和曲绘作者等信息。
4. 将需要展示的谱面设为上架。
5. 设置实例对 Phira 用户的可见范围。
6. 把私服 IP、DNS 改写方法、证书要求和可选的多人地址告诉玩家。

玩家不需要注册管理面板账号。管理账号只提供给需要上传谱面或协助维护服务的人。面向玩家的接入说明见 [USER.md](USER.md)，部署者应先填入自己的服务器 IP、证书要求和多人地址。

## Phira 客户端网络模型

先区分四个容易混淆的地址：

| 名称 | 作用 |
| --- | --- |
| `phira.5wyxi.com:443` | 原版 Phira 固定访问的 HTTPS API 入口 |
| `PORT` | Gateway 在服务器内部监听的 HTTPS 端口 |
| `PUBLIC_BASE_URL` | 写入私有谱面曲绘、音频和 `.pez` 下载链接的外部地址；它不会改变原版客户端访问哪个 API |
| `UPSTREAM_BASE_URL` | Gateway 在服务器端转发非私有请求时访问的官方服务 |

原版客户端的标准链路是：

```text
原版 Phira 请求 https://phira.5wyxi.com:443
  → 玩家设备上的 DNS 改写把 phira.5wyxi.com 指向私服 IP
  → 私服外部 TCP 443
  → Gateway 直接监听 443，或由端口映射/反向代理转到 Gateway 内部端口
  → 私有谱面请求由 Gateway 处理，其余请求转发到 UPSTREAM_BASE_URL
```

DNS 只把域名解析到另一个 IP，不能把客户端固定使用的 `443` 改成 `8443`。因此 `https://服务器IP:8443` 可以用于浏览器测试，但不能直接供原版 Phira 使用。

### 场景一：只在服务器本机测试管理页面

保持 `PUBLIC_BASE_URL` 为空。Gateway 使用 `PORT=443` 时访问 `https://localhost/admin`；若使用 `PORT=8443`，访问 `https://localhost:8443/admin`。本机测试不需要 DNS 改写，也不需要让公网访问任何端口。

### 场景二：让原版 Phira 接入

1. 确保玩家可以访问服务器 IP。仅同一局域网使用时可提供局域网 IP；互联网使用需要公网入口。
2. 让外部 TCP `443` 到达 Gateway。可以让 Gateway 直接使用 `PORT=443`，由路由器把外部 `443` 映射到 Gateway 的内部 `8443`，也可以由反向代理监听外部 `443` 并转发到内部 `8443`。
3. 在防火墙中只开放需要的入口。不要公开本机管理端口 `9000` 或 PMP+ HTTP 管理端口 `12357`。
4. 在 `.env` 中设置：

```env
UPSTREAM_BASE_URL=https://phira.5wyxi.com
PUBLIC_BASE_URL=https://phira.5wyxi.com
```

5. 不要在服务器自身的 hosts 文件或 DNS 中把 `phira.5wyxi.com` 指回私服。DNS 改写只应发生在玩家设备，否则 Gateway 转发官方请求时会循环访问自己。
6. 在管理面板的目标服务实例中加入 Host `phira.5wyxi.com`。原版客户端只有这一个 Host，因此同一个入口只能按 Host 命中一个实例；多实例面向不同人群时应使用实例可见范围，若要按不同域名区分则需要可修改 API 地址的客户端。
7. 把 [USER.md](USER.md) 复制为部署专用指南，填入私服 IP 与证书要求后发给玩家。真实地址可保存在忽略提交的 `data/site-docs/USER.md`。

如果服务器位于家用路由器后面，还要把路由器的外部 TCP `443` 转发到实际提供入口的机器。若运营商使用 CGNAT、没有可入站的公网地址，普通端口转发不会生效，需要 VPS、公网隧道或其他能接收 TCP `443` 的入口。多人功能另需按实际配置开放并转发 PMP+ 游戏 TCP 端口，默认是 `12356`。

### 证书与“不安全模式”

原版 Phira 连接时校验的主机名是 `phira.5wyxi.com`。部署者通常不拥有这个官方域名，因此不能为它申请常规公开 CA 证书；本项目生成的是包含该域名的自签名测试证书。玩家使用这种入口时通常需要在 Phira 中明确开启“不安全模式”。这会降低 TLS 身份校验能力，只应连接自己信任的服务器，返回官方服务后应关闭。

这种接入本质上是在玩家设备上把官方 API 域名导向私人 Gateway。Gateway 会接收 Phira 发出的 API 请求，包括其中可能携带的登录凭据或授权信息，再把非私有请求转发到官方服务。部署者必须保护日志和服务器；玩家也必须确认自己信任部署者。受信任证书只能证明当前连接的域名身份，不能消除私人代理本身的信任边界。

### 场景三：自定义客户端或自有域名

只有当客户端允许修改 API 基础地址时，才可以让它直接访问 `https://charts.example.com`，无需把官方域名做 DNS 改写。此时将 `PUBLIC_BASE_URL` 设为同一个外部地址，并为自有域名配置受信任的 HTTPS 证书。这种方式不适用于 API 地址固定的原版 Phira。

### 使用反向代理

反向代理必须保留原始 `Host`，否则服务实例路由会失效。它可以在外部监听 `443`，再转发到 `https://127.0.0.1:8443`；`PUBLIC_BASE_URL` 仍填写玩家看到的外部地址，不要带内部 `:8443`。同时传递 `X-Forwarded-Host` 与 `X-Forwarded-Proto`，并确保代理到 Gateway 时正确处理本地自签名证书。

例如，Gateway 的 `.env` 可以使用：

```env
HOST=127.0.0.1
PORT=8443
PUBLIC_BASE_URL=https://phira.5wyxi.com
```

对应的 Nginx 核心配置如下。证书路径应换成实际路径；前端证书仍需包含 `phira.5wyxi.com`。`proxy_ssl_verify off` 只用于同机回环地址上的自签名 Gateway，不应拿来关闭公网后端的校验。

```nginx
server {
    listen 443 ssl;
    server_name phira.5wyxi.com;

    ssl_certificate     /path/to/server.crt;
    ssl_certificate_key /path/to/server.key;

    location / {
        proxy_pass https://127.0.0.1:8443;
        proxy_ssl_verify off;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

需要在根路径展示项目主页时，可将 `HOMEPAGE_HOST` 设为专门的主页域名；留空时 Gateway 不会拦截根路径。主页域名与原版 Phira 使用的 API Host 是两个不同概念。

## 安装谱面预览功能

谱面预览是管理面板中的可选功能。安装后，拥有谱面查看权限的成员可以在“谱面”页面点击“预览”，直接在浏览器中播放自动演示、拖动进度和调整音量。

这个功能由两部分组成：

- 编译成 WebAssembly 的 `phira-web-monitor` 浏览器渲染器
- 将 `.pez` 转换为渲染数据的本机 `chart-compiler`

二者都需要在部署机器上构建。构建产物不会提交到 GitHub。

### 1. 安装构建工具

先安装 [Rustup](https://rustup.rs/)，然后确认以下命令可以运行：

```powershell
rustc --version
cargo --version
```

再安装 `wasm-pack`：

```powershell
cargo install wasm-pack
wasm-pack --version
```

Windows 如果提示缺少 C++ 链接器，请安装 Visual Studio Build Tools，并选择“使用 C++ 的桌面开发”。Linux 则需要系统提供常用的 C/C++ 编译工具和链接器。

### 2. 构建渲染器

在本项目根目录运行：

```powershell
npm.cmd run build:renderer
```

Linux 或 macOS 使用：

```bash
npm run build:renderer
```

构建脚本会自动克隆 [HyperSynapseNetwork/phira-web-monitor](https://github.com/HyperSynapseNetwork/phira-web-monitor)，应用本项目需要的音量、透明背景和 Hold 音符显示补丁，然后生成：

```text
vendor/renderer/pkg/                         # 浏览器 WASM 渲染器
vendor/renderer/bin/chart-compiler.exe       # Windows 谱面编译器
vendor/renderer/bin/chart-compiler           # Linux / macOS 谱面编译器
```

源码默认克隆到本项目相邻的 `phira-web-monitor-hsn` 目录。需要指定其他位置时，可以在运行命令前设置 `RENDERER_SRC` 环境变量。

### 3. 可选资源包

不安装资源包时，渲染器仍可运行，但会使用内置的简化纹理。个人部署需要使用上游默认资源包时，可以运行：

```powershell
npm.cmd run build:renderer -- --respack
```

资源包包含第三方美术和音效，不属于本项目的 MIT 许可证范围，不应在没有授权的情况下重新分发或提交到公开仓库。

### 4. 使用预览

默认配置中的 `MONITOR_RENDERER_PATH=vendor/renderer` 已指向上述构建目录，不需要额外修改。构建完成后刷新管理页面，在谱面列表中点击对应谱面的“预览”按钮即可。

第一次预览某张谱面时，服务器需要解压音频并生成渲染数据，可能需要等待一段时间。生成的数据会缓存到 `data/monitor-cache/`，单个缓存可能达到几十 MB；可以通过 `.env` 中的 `MONITOR_CACHE_MAX_MB` 调整总缓存上限。

如果页面提示“谱面渲染器尚未构建”，请检查以下文件是否存在：

```text
vendor/renderer/pkg/monitor_client.js
vendor/renderer/pkg/monitor_client_bg.wasm
vendor/renderer/bin/chart-compiler.exe        # Windows
vendor/renderer/bin/chart-compiler            # Linux / macOS
```

## 安装多人房间服务 PMP+

不需要多人功能时可以跳过本节。

本项目使用 [AmaoQWQ/Phira-mp-plus](https://github.com/AmaoQWQ/Phira-mp-plus) 的定制版本，当前配套版本为 [`v1.0.50`](https://github.com/AmaoQWQ/Phira-mp-plus/releases/tag/v1.0.50)。请使用这个版本；[HyperSynapseNetwork/Phira-mp-plus](https://github.com/HyperSynapseNetwork/Phira-mp-plus) 不包含本项目需要的房间管理接口，不能直接替代。

### 自动安装

Windows x64 可以运行：

```powershell
npm.cmd run install:pmp
```

Linux x64 或 Linux ARM64 使用：

```bash
npm run install:pmp
```

macOS 暂无配套的预编译包，请直接使用下方“从源码编译 PMP+”的方法。

安装器只负责从 GitHub Release 下载当前平台的程序、使用 `SHA256SUMS` 校验文件，并在缺少配置时生成 `pmp-runtime/server_config.yml`；它不会安装 PostgreSQL、创建数据库或替你填写连接信息。下载完成后还需要手动完成：

1. 安装并启动 PostgreSQL。
2. 编辑 `pmp-runtime/server_config.yml`，填写可用的 `database_url`。
3. 在 `.env` 中设置独立的 `HSN_SECRET_KEY`，用于保持稳定的节点身份。
4. 在 `.env` 中设置 `PMP_ADMIN_TOKEN`；留空时会使用 `ADMIN_TOKEN`。
5. 确认 `PMP_BASE_URL` 与 PMP+ 配置中的 HTTP 端口一致。
6. 如果暂不安装下方的房间实时监控插件，保持 `.env` 中的 `PMP_MONITOR_ENABLED=false`。

启动并检查：

```powershell
npm.cmd run start:pmp
npm.cmd run status:pmp
```

默认情况下，PMP+ 游戏端口为 TCP `12356`，HTTP 管理端口为 `12357`；实际值以 `pmp-runtime/server_config.yml` 为准。

### 安装房间实时监控插件（可选）

定制版 PMP+ 自带 `/admin/rooms` 管理接口，不安装插件也可以在管理页面创建、修改和解散托管房间。若还需要观察普通玩家自行创建的房间，并让管理页面实时显示加入、离开、选谱、开局和成绩等变化，则安装第三方 [HSNPhira-v2-PMP-plugin](https://github.com/FireflyF09/HSNPhira-v2-PMP-plugin)。

本项目不重新分发该插件，而是直接使用原作者的 Release。当前文档固定使用 [`v0.2.51`](https://github.com/FireflyF09/HSNPhira-v2-PMP-plugin/releases/tag/v0.2.51)，不要直接下载仓库页面上的 Source code ZIP。

先停止 PMP+。Windows PowerShell 在本项目根目录运行：

```powershell
npm.cmd run stop:pmp
New-Item -ItemType Directory -Force pmp-runtime/plugins | Out-Null
$pluginUrl = 'https://github.com/FireflyF09/HSNPhira-v2-PMP-plugin/releases/download/v0.2.51/hsnphira_v2_pmp_plugin.component.wasm'
$pluginPath = 'pmp-runtime/plugins/hsnphira_v2_pmp_plugin.component.wasm'
Invoke-WebRequest -Uri $pluginUrl -OutFile $pluginPath
(Get-FileHash -Algorithm SHA256 $pluginPath).Hash.ToLower()
```

输出的 SHA-256 应为：

```text
943d6cc3e84981b0a91fbbb45334cedf2e1c72b2b032c1a19e5d8a07f4962dfb
```

Linux 或 macOS 使用：

```bash
npm run stop:pmp
mkdir -p pmp-runtime/plugins
curl -fL \
  https://github.com/FireflyF09/HSNPhira-v2-PMP-plugin/releases/download/v0.2.51/hsnphira_v2_pmp_plugin.component.wasm \
  -o pmp-runtime/plugins/hsnphira_v2_pmp_plugin.component.wasm
```

Linux 校验文件：

```bash
echo '943d6cc3e84981b0a91fbbb45334cedf2e1c72b2b032c1a19e5d8a07f4962dfb  pmp-runtime/plugins/hsnphira_v2_pmp_plugin.component.wasm' | sha256sum -c -
```

macOS 校验文件：

```bash
test "$(shasum -a 256 pmp-runtime/plugins/hsnphira_v2_pmp_plugin.component.wasm | awk '{print $1}')" = '943d6cc3e84981b0a91fbbb45334cedf2e1c72b2b032c1a19e5d8a07f4962dfb'
```

插件文件必须直接位于 `pmp-runtime/plugins/`，不要再放进子目录。然后在 `.env` 中设置：

```env
PMP_MONITOR_ENABLED=true
PMP_BASE_URL=http://127.0.0.1:12357
PMP_ROOMS_SNAPSHOT_PATH=/api/rooms/info
PMP_EVENTS_PATH=/api/rooms/listen
PMP_MONITOR_TOKEN=
```

重新启动 PMP+ 和 Gateway：

```powershell
npm.cmd run start:pmp
npm.cmd run stop:gateway
npm.cmd run start:gateway
npm.cmd run status:pmp
```

Linux 或 macOS 将上述命令中的 `npm.cmd` 换成 `npm`。最后访问 `http://127.0.0.1:12357/api/rooms/info`；正常情况下会返回 JSON 数组。若返回 404，请确认文件没有放进子目录并已重启 PMP+；若 PMP+ 启动失败，请检查 `logs/pmp-server-error.log`。插件与 PMP+ 的 WASM/WIT 接口必须兼容，升级任一方后都应重新验证这两个监控端点。

### 为什么多人房间管理需要定制版

这个 PMP+ 版本提供了本项目网页管理所依赖的能力：

- 长期托管房和一次性预约白名单房
- 使用 `x-admin-token` 认证的 `/admin/rooms` 管理接口
- 创建、查询、更新、解散房间，以及调整人数、发送聊天和维护谱池
- `HOST_SELECT` 和 `POOL_RANDOM` 选谱模式
- 房主、人数上限和允许用户列表控制
- 托管房持久化、服务重启恢复和管理员删除状态保存
- 可选的房间事件与比赛结果回调
- 禁止普通客户端自行建房的配置开关
- Playing 状态下 5 秒的默认断线重连宽限

Gateway 只在服务器内部使用 PMP+ 管理令牌，不会把它返回给浏览器。

### 从源码编译 PMP+

需要先安装 [Rustup](https://rustup.rs/)，然后在本项目目录之外运行：

```bash
git clone https://github.com/AmaoQWQ/Phira-mp-plus.git
cd Phira-mp-plus
git checkout v1.0.50
cargo build --locked --release --package phira-mp-plus-server
```

把生成的程序放到：

```text
pmp-runtime/bin/phira-mp-plus-server.exe    # Windows
pmp-runtime/bin/phira-mp-plus-server        # Linux
```

再从 [config/pmp-server.example.yml](config/pmp-server.example.yml) 创建 `pmp-runtime/server_config.yml`，完成数据库和端口配置。更详细的说明见定制版 PMP+ 的 [README](https://github.com/AmaoQWQ/Phira-mp-plus/blob/main/README.md) 和 [部署文档](https://github.com/AmaoQWQ/Phira-mp-plus/blob/main/docs/deployment.md)。

## 账号与权限

管理面板账号与 Phira 玩家账号相互独立。

| 等级 | 默认用途 |
| --- | --- |
| 普通成员 | 管理自己的实例、谱面和本地成绩 |
| 进阶成员 | 协助维护指定实例 |
| 高级成员 | 维护指定实例和自己拥有的多人房间 |
| 管理员 | 审核注册申请并管理授权范围内的账号和实例 |
| 超级管理员 | 配置和管理整个平台 |

权限由服务端检查。提高账号等级不代表自动获得所有实例的访问权，具体范围以管理页面显示为准。高风险操作会要求填写原因或再次确认。

## 谱面包格式

可以上传单个 `.pez` 或 `.zip` 文件。推荐的单张谱面包结构为：

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

也支持 `info.yaml` 和 `info.txt`。未提供独立预览音频时，服务会使用音乐文件作为预览。

批量合集是一个外层 ZIP，每个文件都是独立谱面包：

```text
#<chart-id>_<chart-name>.pez
#<chart-id>_<chart-name>.zip
```

私有谱面 ID 必须是非零的 32 位有符号整数。留空时由服务端自动分配；批量合集中的重复 ID 会被跳过。

## 实例可见范围不是下载权限

实例支持“所有人可见”“指定用户可见”和“所有人不可见”。这些设置只控制谱面是否出现在在线列表与搜索结果中，**不构成严格的下载访问控制**。

知道谱面详情或资源链接的人仍可能直接访问对应内容；已经下载到客户端的文件也无法由服务器撤回。因此：

- 不要把可见范围设置当作保密或数字版权保护机制。
- 不要上传泄露后会造成严重后果的内容。
- 严格私有分发需要另外为详情和资源下载接口增加身份验证。

## 本地成绩与评分

本地成绩、排行榜和评分只保存在当前服务中，不会计入官方经验、官方 RKS 或官方排行榜。

自动验证客户端上传的私有成绩需要兼容的 Decoder 和本地验证材料。公开仓库不会附带验证密钥；缺少这些材料时，Gateway 仍可以启动，但不会把无法验证的上传当作可信成绩保存。管理员仍可在管理页面手动录入本地成绩。

谱面评分使用 0 到 10 的整数。玩家公开名称和头像可能被读取并短期缓存在本地，以便显示排行榜。

## 数据与隐私

运行数据默认位于：

- `data/private-charts/`：谱面与资源
- `data/instances/`：服务实例
- `data/private-records/`：本地成绩数据库
- `logs/`：运行日志
- `certs/`：本机证书与私钥
- `pmp-runtime/`：可选的 PMP+ 程序、配置和数据

这些目录中的敏感文件均不应提交到 GitHub。请定期备份谱面、账号、成绩、数据库和配置，并保护备份文件本身。

启用成员注册时，部署者还应发布隐私政策，说明收集哪些申请资料、哪些管理员可以查看、保存期限，以及用户如何申请更正或删除。

## 安全提示

- 不要提交真实的 `.env`、数据库口令、管理令牌、证书私钥或成绩验证材料。
- 为 `ADMIN_TOKEN`、`PMP_ADMIN_TOKEN` 和 `HSN_SECRET_KEY` 使用不同的随机值。
- 不要把只供本机使用的 `ADMIN_PORT` 暴露到公网。
- 不要在日志、截图、工单或聊天记录中粘贴 Cookie、访问令牌或完整请求体。
- 自定义客户端使用自有域名时，应配置受信任的 HTTPS 证书；原版 Phira 的官方域名改写方案通常只能使用自签名证书和“不安全模式”，必须把相应风险明确告知玩家。
- 如果凭据可能已经泄露，应立即轮换；仅删除文件或提交记录并不能使旧凭据失效。

## 开发与测试

```bash
npm run build
npm run test:multiplayer
npm run test:rating
npm run test:instances
npm run test:visibility
npm run test:policy
npm run test:monitor
npm run test:rooms
```

测试应使用隔离数据、测试账号和临时配置，不要使用生产凭据或真实用户资料。完整接口说明见 [docs/API.md](docs/API.md)，架构说明见 [docs/architecture-design.md](docs/architecture-design.md)。

## License

本项目自有代码使用 [MIT License](LICENSE) 发布。该许可证不适用于谱面、音乐、曲绘或其他第三方内容；上传者需要自行确认相应内容的授权范围。
