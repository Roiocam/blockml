---
name: blockml
description: 用 BlockML（.blockml）写架构图并交付可交互的单个 HTML 阅读器。当用户说「画架构图」「把系统画出来」「这套服务谁连谁」「diagram-as-code」「架构地图」「部署拓扑」「谁拥有谁」，或需要把一段架构描述沉淀成可版本管理、可拖拽调整的图时使用。
---

# BlockML

BlockML 是给架构图用的 diagram-as-code：作者只写**语义**（有哪些块、怎么连、怎么分组），布局与渲染质量由平台负责。默认分层布局、共享端口、法线出线、标签避让、避障与跨线跳弧都不需要手写样式；用户拖动后，坐标只由编辑器回写到同一份文件。

## 什么时候用

用：系统架构、部署拓扑、调用链、数据流、依赖关系、模块归属 —— 任何「方块 + 连线」的图。

不用：流程图（有分支/泳道语义）、时序图、类图、ER 图。这些用 Mermaid 更合适。

## 工作流

1. **先划范围**：这张图回答什么问题？选 6–16 个块。超过 20 个先分两张。
2. **写 `.blockml`**：先 `group`，再 `node`，最后 `edge`。**不要写 `at` / `via` / `color` / `theme` / `dash`**——布局交给平台；走线风格（曲线 / 正交）是阅读器选项，不写进文件。
3. **每条断言挂 `src`**：节点/边只要说了「谁连谁、跑在哪、几个连接池」这类事实，就要能被 `文件:行` 或文档章节指到。没有出处的断言不要写进图。
4. **自检**：`node <blockml-repo>/packages/cli/bin.mjs validate <file>`，error 必须清零，warning 逐条确认。
5. **交付**：`node <blockml-repo>/packages/cli/bin.mjs render <file> -o <out.html>`，把 HTML 路径给用户。HTML 默认打开为**演示态**（无点阵网格、无折叠点、无控制点手柄，节点不可拖）；顶部「编辑」可切到编辑态，拖动后点「下载源码」拿回带坐标的 `.blockml`。分组折叠与「图层」隐藏只影响视图，不写回文件。
6. **需要另一套整体排法时**（可选）：`node <blockml-repo>/packages/cli/bin.mjs layout <file> --algo layered|pipeline|snowflake|compact --write`。这是破坏性重排，会覆盖所有已有坐标；不要为了「微调」跑它。

> 走线风格是渲染期选择，不是文档语义：阅读器 / 桌面 App 工具条可在「曲线 / 正交」间切换，`render <file> --route orthogonal` 只设打开时的初始风格（默认 `curve` 贝塞尔）。`route` 不是文档键；旧文件里写了会被忽略并提示。
> 两种风格共用侧端口：同一侧 ≥3 条边也只有一入一出两个普通附着点；端点沿边框法线出线（偏差 ≤0.5°）；标签不压节点/组头/其它标签；线不穿过非端点节点；交叉统一跳弧。这些都由平台保证，不要用 `via` 去「修」。
> 汇流：一个节点连同一组里的多个对端时，给这几条边加同名 `bundle: <name>`，会画成一条主干再分叉；`curve` 与 `orthogonal` 都生效。主干会穿过其它节点时只保留共享吸附点，各边分别绕行。
> 仓库在本地时用上面的完整路径；把 `@block-ml/cli` 装到 PATH 之后，可以直接用 `blockml validate` / `blockml render`。
> 首次使用前先在该仓库跑一次 `pnpm install && pnpm build`，否则 `packages/*/dist` 不存在。

## 语法骨架

```blockml
diagram {
  title: "订单系统"
}

group access "接入层"
group core "核心服务"

node gw "api-gateway" {
  group: access
  kind: service
  tech: "Spring Cloud Gateway 8080"
  note: "浏览器只访问它；下游不直接暴露"
  src: "docs/deploy.md:18-24"
}

node order "order-service" {
  group: core
  kind: service
  tech: "Go 1.22 · 8081"
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
| 一个 `group` 只装同一层的东西 | 组框是成员节点的包围盒，层级混在一起会散 |
| `tech` 只写一行、≤ 24 字 | 卡片里放不下，详情面板才有 `note` |
| 不写 `at` / `via` / `dash` / `color` / `theme` | 这些是编辑器回写或旧文件兼容键；新文档只留语义 |
| 不写 `route` | 走线风格是阅读器工具条选项，不是文档键；写了会被警告并忽略 |
| 同一对节点多条边不用手写偏移 | 平台自动分配端口并错开 |
| 不确定的 kind 用 `ext` | 未知 kind 会降级并产生 warning |
| 自定义字段一律加 `x-` 前缀 | 未知属性只报 warning，但会丢值 |

## 自检清单

交付前逐条过（详见 `references/checklist.md`）：

- [ ] `validate` 0 error
- [ ] 节点数 ≤ 16，每个节点都回答了「它是什么」
- [ ] 每条边都有协议/通道类型的 `kind`
- [ ] 关键事实带 `src`
- [ ] 渲染出的 HTML 默认是演示态：无网格、无折叠点、无控制点手柄
- [ ] 点「编辑」后能拖动，拖动后源码有变化；切回「预览」后画布干净

## 配套文件

- `references/syntax.md` — 全部语句、属性、值类型
- `references/kinds.md` — 节点/连线 kind 词表与选型
- `references/recipes.md` — 分层架构、调用链、数据面三种配方
- `references/checklist.md` — 交付前自检清单
- `assets/starter.blockml` — 空模板
- `assets/example.blockml` — 完整样例（虚构的订单平台）
