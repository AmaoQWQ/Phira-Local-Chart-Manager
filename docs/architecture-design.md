# Phira 本地谱面管理系统：设计说明

本文档描述项目当前的通用设计。项目用于配合 Phira 客户端访问管理员自行准备的私有谱面资源。

## 目标

- 保持普通官方 API 请求的透明转发
- 使用统一的私有 `chart_id` 判断函数
- 为私有谱面提供 metadata、PEZ 和媒体资源
- 在不修改官方数据的情况下向列表响应注入私有谱面
- 提供最小的多人房间状态同步
- 默认不记录敏感请求内容

## 请求流程

```text
Phira 客户端
    |
    v
HTTPS Gateway
    |
    +-- 普通路径 --------> 官方 Phira API
    |
    +-- 私有 chart_id ----> 本地 metadata / 本地资源
```

Gateway 必须使用服务器能够直接访问的官方上游地址。客户端侧的域名重定向不能影响 Gateway 到上游的解析，否则会形成请求回环。

## 私有 Chart

私有 ID、metadata、搜索字段和资源映射集中在 `src/private-chart.ts`。路由层只调用统一函数，不在多个文件中重复 ID。

资源目录格式：

```text
data/private-charts/<chart-id>/
├── chart-package.pez
├── illustration.jpg
├── music.mp3
└── preview.mp3
```

谱面包内部文件由部署者自行提供。Gateway 不修改谱面原始字节；兼容处理只能使用派生 staging 文件。

## 列表注入

列表注入只处理官方成功返回且结构可识别的 JSON。注入前检查：

- 搜索字段是否匹配
- ranked、reviewed、stable 等过滤条件
- division、tag、uploader 等过滤条件
- 页码和官方列表结构
- ID 是否已经存在

无法安全解释的过滤条件保持官方响应不变。列表注入可以通过 `PRIVATE_CHART_LISTING=false` 关闭。

## 多人状态

多人服务使用独立 TCP 端口，状态机如下：

```text
SelectChart
    -> 房主请求开始
WaitingForReady
    -> 所有玩家准备
Playing
    -> Played / Abort / Leave
```

私有 Chart 在房主选谱时本地校验，普通 Chart 才访问官方 Chart endpoint。私有 ID 不得发送到官方上游。

## 成绩边界

本地成绩接口支持可解析的 JSON 或压缩 JSON 摘要。原版客户端的成绩 Token 可能是闭源二进制数据，Gateway 不应猜测、伪造或提交官方成绩。

多人 `Played` 消息如果只有记录 ID，Gateway 无法从 ID 推导 score。只有收到可验证的成绩摘要或判定事件时，才可以计算本地房间显示成绩。

## 安全边界

- Authorization、Cookie 和 Token 不写入普通日志
- 默认不记录完整请求 body
- Token 捕获仅用于短期本地调试
- 证书、私钥、日志、成绩和私有谱面资源不进入公开仓库
- 普通 API 代理不等于官方身份验证或官方成绩验证

## 开源部署要求

公开部署前需要自行准备：

1. 合法授权的谱面资源
2. TLS 证书和私钥
3. 官方上游地址
4. HTTPS 入口和 TCP 端口配置
5. 防火墙规则和访问控制

项目与 Phira 客户端/API 有关，与 Phigros 无关。
