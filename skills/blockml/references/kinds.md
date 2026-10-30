# kind 选型

`kind` 只决定视觉（颜色、线型），不影响语义。但选错会让图读起来别扭。

## 节点

| kind | 什么时候用 | 典型 |
| --- | --- | --- |
| `service` | 自己维护的服务 | `order-service`、`payment-service` |
| `ui` | 浏览器界面、SPA、客户端 | `web-storefront`、`ops-console` |
| `db` | 关系库、文档库、数仓 | `PostgreSQL`、`ClickHouse` |
| `cache` | 缓存、会话存储 | `Redis` |
| `idp` | 身份提供方 | `Keycloak`、`Okta` |
| `acp` | 执行面、ACP 运行时、Agent 容器 | `sandbox-agent-server`、`agent-runtime` |
| `model` | 模型网关、推理端点 | `Bedrock`、`vLLM` |
| `channel` | 外部消息渠道 | `企业微信`、`飞书`、`Slack` |
| `ext` | 其它外部依赖（兜底） | `S3`、`MCP Servers`、`知识库` |

选型原则：**第一眼要能分清「我们的」和「外面的」**。自有服务用 `service`，外部一律 `ext` 或更具体的专用 kind。

## 连线

| kind | 什么时候用 | 线型 |
| --- | --- | --- |
| `rest` | 同步 HTTP | 实线 |
| `acp` | ACP 协议 | 实线 |
| `sse` | 单向事件流 | 虚线 |
| `sql` | 数据库访问 | 实线 |
| `rpc` | 服务间 RPC（含 client credentials） | 实线 |
| `oidc` | 登录、令牌、验签 | 虚线 |
| `llm` | 模型调用 | 实线 |
| `mcp` | MCP 工具面 | 虚线 |
| `ws` | 长连接 | 虚线 |
| `gate` | 准入、闸门、鉴权判定 | 点线 |
| `opt` | 可选、弱依赖 | 点线 |

选型原则：**线型表达强弱，方向交给节点色**。可选依赖一定用 `opt`，否则读图的人会以为它必须存在。连线颜色不再按协议族区分，而是从起点节点色（浅）渐变到终点节点色（实色），箭头取终点色；因此同一节点上的入站线和出站线颜色必然不同，协议差别靠实线/虚线/点线与标签表达。

## 颜色

内置色板：

| kind | 色值 |
| --- | --- |
| service | `#4f46e5` |
| ui | `#64748b` |
| db | `#10b981` |
| cache | `#ef4444` |
| idp | `#f59e0b` |
| acp | `#0ea5e9` |
| model | `#14b8a6` |
| channel | `#ec4899` |
| ext | `#8b5cf6` |

组色自选，建议与组内主 kind 同色系但更淡；同一张图里两个组不要用同一个颜色。

## 自定义

v1 不支持自定义 kind 的颜色。需要标注额外语义时：

```blockml
node foo "Foo" {
  kind: service
  x-layer: "控制面"
  x-owner: "platform-team"
}
```

`x-` 前缀的字段会被保留在 AST 里（渲染器忽略），方便后续版本使用。
