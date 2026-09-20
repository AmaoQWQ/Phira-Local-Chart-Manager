# Phira 本地谱面管理系统

一个面向 Phira 客户端的社区项目，用于管理和分发自建谱面，并提供本地成绩与多人房间功能。

> [!IMPORTANT]
> 本项目并非 Phira 官方项目，与 Phira 官方不存在隶属、授权或背书关系。使用者应遵守 Phira 的相关规则，并确认自己有权分发所上传的谱面、音乐、曲绘及其他内容。

## 功能

- 管理和分发本地谱面
- 上传单张 .pez、.zip 或批量谱面合集
- 自动读取谱面信息并提取曲绘、音乐和预览音频
- 在客户端的在线列表和搜索结果中展示已上架谱面
- 保存本地成绩、排行榜和谱面评分
- 创建与管理多人房间
- 支持多个相互隔离的谱面服务实例
- 支持 Windows、Linux 和 macOS

## 重要的访问范围说明

实例的“所有人可见”“指定用户可见”和“所有人不可见”只控制谱面是否出现在在线列表与搜索结果中，**不是下载访问控制**。

知道谱面详情或资源链接的人仍可能直接访问相应内容；已经下载到客户端的内容也无法由服务器撤回。因此：

- 不要把这一功能当作严格的保密或数字版权保护机制。
- 不要上传泄露后会造成严重后果的内容。
- 需要严格私有分发时，应先在详情和资源接口上增加经过验证的访问授权，再将服务开放到公网。

## 安装

需要 Node.js 22.5 或更高版本。

~~~bash
git clone https://github.com/AmaoQWQ/phira-private-chart.git
cd phira-private-chart
npm install
npm run build
~~~

## 配置

复制示例配置，在本机填写部署所需的值：

~~~powershell
Copy-Item .env.example .env
~~~

Linux 或 macOS：

~~~bash
cp .env.example .env
~~~

部署时请注意：

- .env 中可能包含管理凭据、服务地址和数据库口令，不要提交到 Git、粘贴到工单或发送给无关人员。
- 管理凭据应使用独立、随机且足够长的值，不要沿用其他服务的密码。
- 公网部署应使用有效的 HTTPS 证书，并限制不需要对外开放的监听端口。
- 数据库、证书、私钥和运行数据应由部署者在仓库之外安全管理。
- 升级前请备份配置、谱面、账号和成绩数据。

完整变量及说明见 [.env.example](.env.example)。示例中的域名、账号、Token 和密码均为占位值，不应直接用于生产环境。

## 启动与停止

### Windows

~~~powershell
.\start-probe.cmd
~~~

`start-probe.cmd` 会先尝试启动可选的 PMP+ 多人服务，然后启动网页管理服务。如果 PMP+ 尚未编译、未配置或启动失败，脚本会显示警告并继续启动网页管理服务；此时只是多人房间功能不可用。

也可以直接运行：

~~~powershell
npm.cmd run start:quick
~~~

只启动网页管理服务：

~~~powershell
npm.cmd run start:gateway
~~~

停止服务：

~~~powershell
.\stop-probe.cmd
~~~

### Linux / macOS

~~~bash
npm run build
npm start
~~~

启动脚本只会打开命令行日志窗口，不会自动打开浏览器。默认本机管理地址是 `http://127.0.0.1:9000/admin`；HTTPS 入口是 `https://localhost/admin`。如果修改了 `.env` 中的 `ADMIN_PORT` 或 `PORT`，地址中的端口也要相应修改。本地自签名 HTTPS 证书会触发浏览器安全提示。

管理页面地址和客户端连接地址由部署者提供。不要为了方便而把仅供本机维护的端口直接暴露到公网。

## 可选：安装定制版 PMP+

PMP+ 用于多人房间，不是网页管理服务的必需组件。不需要多人功能时可以跳过本节。

PMP+ 源码已拆分到独立 fork：[AmaoQWQ/Phira-mp-plus](https://github.com/AmaoQWQ/Phira-mp-plus)。本仓库不再内嵌 `mp-server/` 源码。当前 Gateway 与 fork 的 `v1.0.49` 配套，**不要用 [HyperSynapseNetwork 上游](https://github.com/HyperSynapseNetwork/Phira-mp-plus) 的原版 Release 直接替换**，因为原版不包含本项目依赖的房间管理接口。

相对上游原版，这个 fork 增加或调整了：

- 新增长期托管房和一次性预约白名单房。
- 新增基于 `x-admin-token` 的 `/admin/rooms` 原生 HTTP 管理接口，可创建、查询、更新、解散房间，并可调整人数、发送聊天和维护谱池。
- 新增 `HOST_SELECT` 和 `POOL_RANDOM` 选谱模式，以及房主、容量和允许用户列表控制。
- 新增 `mp_managed_rooms` 持久化及重启恢复；管理员解散时会保存删除状态，避免房间在重启后被误恢复。
- 新增可选的房间事件和比赛结果回调，以及禁止普通客户端建房的配置开关。
- 将 Playing 状态的默认断线重连宽限从上游的 15 秒调整为 5 秒。
- Gateway 在服务端转发这些房间管理操作，不会把 PMP+ 管理令牌发给浏览器。

Windows x64、Linux x64 和 Linux ARM64 可以直接安装 fork 的已校验 Release：

~~~powershell
npm.cmd run install:pmp
~~~

该命令从 `AmaoQWQ/Phira-mp-plus` 的 `v1.0.49` Release 下载当前平台的程序，使用 Release 中的 `SHA256SUMS` 校验，然后安装到 `pmp-runtime/bin/`。首次安装会迁移旧版 `mp-server/server_config.yml`；没有旧配置时，则从 [config/pmp-server.example.yml](config/pmp-server.example.yml) 生成 `pmp-runtime/server_config.yml`。重复安装不会覆盖已有配置。

如果希望自行审查并编译，或当前平台没有预编译包，请在本仓库之外克隆 fork：

~~~powershell
git clone https://github.com/AmaoQWQ/Phira-mp-plus.git
cd Phira-mp-plus
git checkout v1.0.49
cargo build --locked --release --package phira-mp-plus-server
~~~

需要先安装 [Rustup](https://rustup.rs/)，项目中的 `rust-toolchain.toml` 会选择所需工具链。编译完成后，把程序复制到本项目的以下位置：

~~~text
pmp-runtime/bin/phira-mp-plus-server.exe    # Windows
pmp-runtime/bin/phira-mp-plus-server        # Linux
~~~

启动 PMP+ 前还需要：

1. 修改本机的 `pmp-runtime/server_config.yml`，特别是 PostgreSQL `database_url`；手动编译时可从 [配置示例](config/pmp-server.example.yml) 复制。
2. 在 `.env` 中设置独立的 `HSN_SECRET_KEY`，使 PMP+ 在重启后保持稳定节点身份。
3. 设置 `PMP_ADMIN_TOKEN`；留空时会沿用 Gateway 的 `ADMIN_TOKEN`。
4. 启动 PostgreSQL，并确保 PMP+ 能连接配置的数据库。

可单独启动并检查 PMP+：

~~~powershell
npm.cmd run start:pmp
npm.cmd run status:pmp
~~~

更完整的 PMP+ 配置、端口、数据库及源码编译说明见 fork 的 [README](https://github.com/AmaoQWQ/Phira-mp-plus/blob/main/README.md) 和 [部署文档](https://github.com/AmaoQWQ/Phira-mp-plus/blob/main/docs/deployment.md)。

## 账号与权限

管理面板账号独立于 Phira 账号。部署者可以启用注册审核，并按职责授予不同范围的权限。

| 等级 | 默认用途 |
| --- | --- |
| 普通成员 | 管理自己的实例、谱面和本地成绩 |
| 进阶成员 | 协助维护指定实例 |
| 高级成员 | 维护指定实例和自己拥有的多人房间 |
| 管理员 | 审核注册并管理授权范围内的账号和实例 |
| 超级管理员 | 负责整个平台的配置与权限管理 |

权限由服务端校验。账号等级提升不等于自动获得所有实例的访问权，具体范围以管理面板显示为准。

高风险操作会要求填写原因或再次确认。请在提交前核对目标实例、谱面数量和影响范围。

## 管理谱面

管理面板支持：

- 上传单张或批量谱面包
- 查看和筛选谱面
- 修改名称、等级、难度、谱师、作曲和曲绘作者
- 添加标签以及切换在线显示状态
- 下载谱面包
- 查看和管理本地成绩
- 删除谱面及其关联的本地数据

删除操作可能同时移除关联成绩和资源文件。删除前请先确认影响范围并保留必要备份。

## 多实例服务

每个服务实例拥有独立的谱面、成绩、显示范围和管理归属。成员只能操作自己拥有或被明确授权的实例。

可见范围包括：

- **所有人可见**：所有连接到该服务的用户都能在列表和搜索中看到已上架谱面。
- **指定用户可见**：只有配置的 Phira 用户能在列表和搜索中看到已上架谱面。
- **所有人不可见**：谱面不会加入列表和搜索结果。

新实例默认不在列表和搜索中公开。可见范围的限制不等同于资源下载授权，具体边界请先阅读上方的“重要的访问范围说明”。

## 谱面包格式

可以上传单个 .pez 或 .zip 文件：

~~~text
chart.pez
~~~

批量合集使用一个外层 ZIP，其中每个文件都是独立的谱面包：

~~~text
#<chart-id>_<chart-name>.pez
#<chart-id>_<chart-name>.zip
~~~

推荐的单张谱面包结构：

~~~text
info.yml
<chart>.json
<music>.mp3、.ogg 或 .wav
<illustration>.jpg、.jpeg 或 .png
~~~

info.yml 示例：

~~~yaml
name: Example Chart
level: AT Lv.17
difficulty: 17.0
charter: Example Charter
composer: Example Composer
illustrator: Example Artist
~~~

也支持 info.yaml 和 info.txt。未提供独立预览音频时，服务会使用音乐文件作为预览。

私有谱面 ID 必须是非零的 32 位有符号整数。留空时由服务端自动分配；批量合集中的重复 ID 会被跳过。

## 本地成绩与评分

本地成绩、排行榜和评分只保存在当前服务中，不会计入官方经验、RKS 或官方排行榜。

谱面评分使用 0 到 10 的整数。删除评分后，该用户会恢复为未评分状态。

玩家公开名称和头像可能被读取并缓存在本地，以便显示本地排行榜。服务不可用时可能显示本地兜底名称。

## 多人房间

多人功能由独立部署的 [定制版 PMP+](https://github.com/AmaoQWQ/Phira-mp-plus) 支持。用户通过部署者提供的服务器地址连接。

房间支持选谱、准备、同步开始、游戏状态与结果广播。私有谱面参与多人游戏时，所有玩家都需要能够访问同一个谱面服务。

房间白名单、所有者和管理权限由服务端控制。不要公开管理凭据，也不要将管理接口直接暴露给未授权用户。

## 用户资料与隐私

启用注册审核后，申请资料可能包括注册原因、用途、社交平台账号和团体信息。这些资料仅应用于审核和服务管理。

部署者在开放注册前应另外发布隐私政策，至少说明：

- 收集哪些资料以及使用目的
- 哪些管理员可以查看
- 数据保存期限与备份策略
- 用户如何申请更正或删除
- 账号停用、删除后哪些实例或内容仍会保留

用户不应在注册原因、谱面信息或操作原因中填写密码、Token、身份证件、住址等不必要的敏感信息。

## 安全提示

- 不要提交真实的 .env、数据库口令、管理 Token、证书私钥或其他凭据。
- 不要把客户端可见性设置误认为资源访问控制。
- 不要在共享日志中打印 Cookie、会话信息、成绩凭据或完整请求体。
- 不要在生产客户端中关闭 TLS 证书校验。
- 定期备份，并确认备份文件本身具有合适的访问权限。
- 如果凭据或私钥可能已经泄露，应立即轮换，而不是只删除文件或文档。

## 开发与测试

~~~bash
npm run build
npm run test:multiplayer
npm run test:rating
~~~

测试应使用隔离数据和临时配置，不要使用生产账号、生产凭据或真实用户资料。

## License

本项目自有代码使用 [MIT License](LICENSE) 发布。该许可证不适用于谱面、音乐、曲绘或其他第三方内容；上传者需要自行确认相应内容的授权范围。
