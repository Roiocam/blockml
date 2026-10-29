---
name: blockml
description: 用 BlockML（.blockml）写架构图并交付可交互的单个 HTML 阅读器。当用户说「画架构图」「把系统画出来」「这套服务谁连谁」「diagram-as-code」「架构地图」「部署拓扑」「谁拥有谁」，或需要把一段架构描述沉淀成可版本管理、可拖拽调整的图时使用。
---

# BlockML

BlockML 是给架构图用的 diagram-as-code：一块文本同时描述**语义**（有哪些块、怎么连、怎么分组）和**布局**（坐标、连线曲率）。写完能渲染，拖完能回写，文件和图永远一致。

## 什么时候用

用：系统架构、部署拓扑、调用链、数据流、依赖关系、模块归属 —— 任何「方块 + 连线」的图。

不用：流程图（有分支/泳道语义）、时序图、类图、ER 图。这些用 Mermaid 更合适。

## 工作流

1. **先划范围**：这张图回答什么问题？选 6–16 个块。超过 20 个先分两张。
2. **写 `.blockml`**：先 `group`，再 `node`，最后 `edge`。位置可以先不写，渲染器会自动补位。
3. **每条断言挂 `src`**：节点/边只要说了「谁连谁、跑在哪、几个连接池」这类事实，就要能被 `文件:行` 或文档章节指到。没有出处的断言不要写进图。
4. **自检**：`node <blockml-repo>/packages/cli/bin.mjs validate <file>`，error 必须清零，warning 逐条确认。
5. **排版**（可选）：`node <blockml-repo>/packages/cli/bin.mjs layout <file> --algo layered --write`，让机器先摆一遍，再人工微调
6. **交付**：`node <blockml-repo>/packages/cli/bin.mjs render <file> -o <out.html>`，把 HTML 路径给用户。用户拖动后的坐标会写回 `.blockml`，可再 `下载源码`；阅读器里的分组折叠与「图层」隐藏只影响视图，不写回文件。

> 排列算法：`layered`（按组分层）、`pipeline`（按组声明顺序）、`snowflake`（中心放射）、`compact`（网格）。重排会覆盖手工坐标，只保留连线曲率。
> 仓库在本地时用上面的完整路径；把 `@blockml/cli` 装到 PATH 之后，可以直接用 `blockml validate` / `blockml render`。
> 首次使用前先在该仓库跑一次 `pnpm install && pnpm build`，否则 `packages/*/dist` 不存在。

## 语法骨架

```blockml
diagram {
  title: "订单系统"
}

group edge "接入层" {
  color: #f59e0b
}

node gw "api-gateway" {
  group: edge
  kind: service
  tech: "Spring Cloud Gateway 8080"
  at: 200, 80
  note: "浏览器只访问它；下游不直接暴露"
  src: "docs/deploy.md:18-24"
}

edge gw -> order "REST /v1/orders" {
  kind: rest
  src: "docs/deploy.md:31"
}
```

完整属性表见 `references/syntax.md`，kind 选型见 `references/kinds.md`。

## 硬规则

| 规则 | 原因 |
| --- | --- |
| 一块图 6–16 个节点 | 超过就分成「全景 + 局部」两张 |
| 一个 `group` 只装同一层的东西，节点在空间上聚在一起 | 组框是成员节点的包围盒，散开会让框互相穿插 |
| `tech` 只写一行、≤ 24 字 | 卡片里放不下，详情面板才有 `note` |
| 坐标写整数 | 手改时好读，diff 也小 |
| 同一对节点多条边时，给每条不同的 `via` | 否则线会叠在一起 |
| 不确定的 kind 用 `ext` | 未知 kind 会降级并产生 warning |
| 自定义字段一律加 `x-` 前缀 | 未知属性只报 warning，但会丢值 |

## 自检清单

交付前逐条过（详见 `references/checklist.md`）：

- [ ] `validate` 0 error
- [ ] 节点数 ≤ 16，每个节点都回答了「它是什么」
- [ ] 每条边都有协议/通道类型的 `kind`
- [ ] 关键事实带 `src`
- [ ] 没有两个组框重叠
- [ ] 渲染出的 HTML 能打开、能拖动、拖动后源码有变化

## 配套文件

- `references/syntax.md` — 全部语句、属性、值类型
- `references/kinds.md` — 节点/连线 kind 词表与选型
- `references/recipes.md` — 分层架构、调用链、数据面三种配方
- `references/checklist.md` — 交付前自检清单
- `assets/starter.blockml` — 空模板
- `assets/example.blockml` — 完整样例（虚构的订单平台）
