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
| 成绩 Token 验证材料 | 可选 | 自动验证兼容客户端上传的私有成绩；验证密钥不会包含在公开仓库中 |

只想先看看管理页面时，不需要安装 PMP+、PostgreSQL、Rust 或成绩验证密钥。

## Windows 快速开始

### 1. 安装运行环境

需要：

- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org/) 22.5 或更高版本

安装 Node.js 后请重新打开终端，确保以下命令可以运行：

```powershell
node --version
npm --version
```

### 2. 下载项目

```powershell
git clone https://github.com/AmaoQWQ/Phira-Local-Chart-Manager.git
cd Phira-Local-Chart-Manager
```

### 3. 创建配置文件

```powershell
Copy-Item .env.example .env
```

用文本编辑器打开 `.env`。第一次本机运行至少要修改以下两项：

```env
PUBLIC_BASE_URL=https://localhost
ADMIN_TOKEN=请替换为一串足够长的随机字符
```

`ADMIN_TOKEN` 用于证明你是服务器所有者。不要使用示例值，也不要把真实值发给别人或提交到 GitHub。

### 4. 启动服务

双击 `start-probe.cmd`，或者在 PowerShell 中运行：

```powershell
.\start-probe.cmd
```

第一次启动时，脚本会自动：

1. 安装 Node.js 依赖。
2. 生成本机测试用的自签名 HTTPS 证书。
3. 编译 TypeScript。
4. 尝试启动可选的 PMP+。
5. 启动网页管理与谱面服务。

没有安装 PMP+ 时会出现提示，但网页管理服务仍会正常启动，只是多人房间暂不可用。

启动脚本不会自动打开浏览器。默认管理地址为：

- `http://127.0.0.1:9000/admin`：仅供服务器本机管理
- `https://localhost/admin`：HTTPS 管理入口

自签名证书会触发浏览器安全警告，这是本机测试环境的正常现象。正式公网部署应换成受信任的 HTTPS 证书。

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

安装 Git 和 Node.js 22.5 或更高版本，然后运行：

```bash
git clone https://github.com/AmaoQWQ/Phira-Local-Chart-Manager.git
cd Phira-Local-Chart-Manager
npm install
cp .env.example .env
```

编辑 `.env`，至少设置 `ADMIN_TOKEN` 和正确的 `PUBLIC_BASE_URL`。Linux 普通用户通常不能直接监听 443 端口，本机测试可将 `PORT` 改为 `8443`。

生成测试证书、编译并启动：

```bash
npm run cert:generate
npm run build
npm start
```

此方式在前台运行，按 `Ctrl+C` 停止。公网部署建议使用 systemd、容器或其他进程管理器，并通过反向代理提供受信任的 HTTPS。

## 常用命令

Windows PowerShell 可将下面的 `npm` 换成 `npm.cmd`。

| 命令 | 作用 |
| --- | --- |
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
6. 把你的 HTTPS 服务地址和客户端接入方式告诉玩家。

玩家不需要注册管理面板账号。管理账号只提供给需要上传谱面或协助维护服务的人。面向玩家的接入说明见 [USER.md](USER.md)，部署者应先把其中的域名和服务器地址改成自己的实际信息。

## 让其他设备访问

`127.0.0.1` 和 `localhost` 只能表示当前电脑。手机或其他电脑要连接服务，需要满足以下条件：

- 服务器拥有其他设备可以访问的局域网 IP 或公网域名。
- 防火墙允许 HTTPS 端口；多人功能还需要允许 PMP+ 的游戏 TCP 端口。
- `.env` 中的 `PUBLIC_BASE_URL` 是玩家实际使用的 HTTPS 地址。
- HTTPS 证书与域名匹配并受客户端信任。
- 如果通过反向代理部署，应只公开需要的入口，不要公开本机管理端口 `9000`。

Phira 客户端的具体接入方式取决于所使用的客户端版本和部署域名。服务器所有者应向玩家提供最终域名、证书要求和多人服务器地址。

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

Windows x64、Linux x64 和 Linux ARM64 可以运行：

```powershell
npm.cmd run install:pmp
```

Linux 或 macOS 使用：

```bash
npm run install:pmp
```

安装器会从 GitHub Release 下载当前平台的程序，使用 `SHA256SUMS` 校验文件，并生成 `pmp-runtime/server_config.yml`。然后完成以下配置：

1. 安装并启动 PostgreSQL。
2. 编辑 `pmp-runtime/server_config.yml`，填写可用的 `database_url`。
3. 在 `.env` 中设置独立的 `HSN_SECRET_KEY`，用于保持稳定的节点身份。
4. 在 `.env` 中设置 `PMP_ADMIN_TOKEN`；留空时会使用 `ADMIN_TOKEN`。
5. 确认 `PMP_BASE_URL` 与 PMP+ 配置中的 HTTP 端口一致。

启动并检查：

```powershell
npm.cmd run start:pmp
npm.cmd run status:pmp
```

默认情况下，PMP+ 游戏端口为 TCP `12356`，HTTP 管理端口为 `12357`；实际值以 `pmp-runtime/server_config.yml` 为准。

### 为什么必须使用定制版

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

- 不要提交真实的 `.env`、数据库口令、管理 Token、证书私钥或成绩验证材料。
- 为 `ADMIN_TOKEN`、`PMP_ADMIN_TOKEN` 和 `HSN_SECRET_KEY` 使用不同的随机值。
- 不要把只供本机使用的 `ADMIN_PORT` 暴露到公网。
- 不要在日志、截图、工单或聊天记录中粘贴 Cookie、Token 或完整请求体。
- 正式部署必须使用有效的 HTTPS 证书，不要让玩家长期依赖关闭证书校验。
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
