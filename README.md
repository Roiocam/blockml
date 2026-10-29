# BlockML

**Diagram-as-code for architecture maps — semantics *and* layout in one text file.**

Mermaid 和 D2 从文本算出布局，你的手动调整存不下来；draw.io 和 Excalidraw 存布局，但没法 code review。
BlockML 把两件事放进同一个 `.blockml` 文件：写完是图，拖完还是同一份文件。

```blockml
group access "接入层" { color: #f59e0b }
group data "数据面" { color: #10b981 }

node gw "api-gateway" {
  group: access
  kind: service
  tech: "WebFlux 8088 · 唯一对外边界"
  at: 340, 40
  src: "docs/deploy.md:18-20"
}

node pg "PostgreSQL" {
  group: data
  kind: db
  tech: "agent_session"
  at: 1180, 260
}

edge gw -> pg "JDBC · 5 池" {
  kind: sql
}
```

## 快速开始

```bash
pnpm install
pnpm build

# 校验
node packages/cli/bin.mjs validate examples/order-platform.blockml

# 生成可双击的单文件阅读器
node packages/cli/bin.mjs render examples/order-platform.blockml -o out/order-platform.html
```

产物是一个自包含 HTML：内联 CSS 和 JS、零外部依赖、内网双击即看。画布上可以直接拖节点、拖连线控制点；悬停或选中节点会高亮与它相连的边；顶部下拉可以在四种排列算法之间切换；每个分组框右上角可以折叠成带计数的胶囊，「图层」面板能逐个隐藏分组或节点（只影响视图，不改源码）；改完点「下载源码」拿回带坐标的 `.blockml`。

仓库里有一份渲染好的示例：[`examples/order-platform.html`](examples/order-platform.html)（虚构的电商订单平台，源码同名 `.blockml`）。

## 语法 30 秒

```blockml
diagram "标题" { title: "…", theme: light }   // 可选
group <id> "标题" { color: #4f46e5 }
node  <id> "标题" { group:, kind:, tech:, at: x, y, note:, src: }
edge  <from> -> <to> "标签" { kind:, via: dx, dy, dash:, note:, src: }
```

- 没有属性的块可以写成一行，`{ }` 省略。
- `at` 是节点左上角；`via` 是连线控制点相对两端点中点的偏移。
- 未知 kind 降级 + warning；未知属性警告并忽略；`x-` 前缀字段原样保留。
- 完整规范：[`spec/blockml-spec-v1.md`](spec/blockml-spec-v1.md)

## 仓库结构

```
spec/
  blockml-spec-v1.md          语言规范（normative）
examples/
  order-platform.blockml      虚构的电商订单平台（可直接渲染）
  order-platform.html         渲染成品，可双击打开
packages/
  core/                       词法、解析、校验、序列化、几何、坐标回写
  viewer/                     渲染 + 交互 + 单文件导出
  cli/                        blockml validate / render / fmt / inspect
skills/
  blockml/                    给 agent 的写作与自检流程
```

## CLI

| 命令 | 作用 |
| --- | --- |
| `blockml validate <file...>` | 语法与引用检查，error 退出码 1 |
| `blockml render <file> [-o out.html]` | 生成自包含阅读器 |
| `blockml layout <file> [--algo layered\|pipeline\|snowflake\|compact] [--write]` | 用算法重排并回写 `at`（保留 `via`） |
| `blockml inspect <file>` | 打印规模、kind 分布、缺坐标/缺出处的节点数 |
| `blockml fmt <file> [--write]` | 规范化输出（会丢弃注释，默认只打印） |

## 设计约束

1. **文件即事实源** —— 语义和坐标同一份文本，没有 sidecar 布局文件。
2. **可 round-trip** —— `parse → serialize → parse` 得到同一棵树。
3. **只写改动的键** —— 拖拽只回写 `at` / `via`，注释和其它属性字节不变。
4. **未知即降级** —— 新文件能被旧工具打开（warning，不阻断）。
5. **零运行时依赖** —— 解析器和渲染器都不引第三方库，内网可用。

## 状态

v0.1 已实现：规范、parser、viewer（四种排列 + 悬停高亮 + 分组折叠 / 图层隐藏）、CLI、agent skill。

路线图：

- [ ] 自定义 kind 样式（`style kind service { color: … }`）
- [ ] 子图嵌套 / 边链 `a -> b -> c`
- [ ] 桌面阅读器（Tauri）
- [x] 四种排列算法 + 悬停高亮
- [x] 分组折叠 + 图层隐藏（仅视图，不写回）
- [ ] npm 发布与 d.ts

## License

MIT
