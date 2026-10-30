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
  tech: "Spring Cloud Gateway · 8080"
  at: 340, 40
  src: "docs/deploy.md:18-20"
}

node pg "PostgreSQL" {
  group: data
  kind: db
  tech: "orders"
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

产物是一个自包含 HTML：内联 CSS 和 JS、零外部依赖、内网双击即看。画布上可以直接拖节点、拖连线控制点，按住 Shift / Ctrl 点选多个节点后可以整组拖动；拖动时靠近其它节点的边或中线会自动吸附并画出对齐线（按住 Alt 临时关闭吸附）；两条线交叉时上层连线在交点画一个小圆弧跳过下层；正交走线按方向分吸附点：同一侧所有入站线共用一个点、所有出站线共用另一个点，两者不重合；连线颜色从起点的节点色（浅）过渡到终点的节点色（实色），箭头取终点色，入站与出站即使在同侧也能一眼分方向；diagram 里写 `route: orthogonal` 可以切换成 draw.io 式的正交走线（圆角转折、跨线跳弧，默认 `curve` 贝塞尔）；悬停或选中节点会高亮与它相连的边；顶部下拉可以在四种排列算法之间切换；每个分组框右上角可以折叠成带计数的胶囊，「图层」面板能逐个隐藏分组或节点（只影响视图，不改源码）；改完点「下载源码」拿回带坐标的 `.blockml`。

仓库里有一份渲染好的示例：[`examples/order-platform.html`](examples/order-platform.html)（虚构的电商订单平台，源码同名 `.blockml`）。

## 桌面阅读器（Tauri）

`apps/desktop` 把同一套 viewer 包成原生应用：系统文件对话框、拖入打开、拖动后自动写回文件、外部修改检测、最近文件、SVG / PNG 导出、深浅主题，并注册 `.blockml` 文件关联（双击直达）。

前置：Node 20+、pnpm、Rust 工具链（`curl https://sh.rustup.rs -sSf | sh`）。

```bash
pnpm install
pnpm --filter @block-ml/desktop tauri dev     # 本机窗口里开发
pnpm --filter @block-ml/desktop tauri build   # 打包到 apps/desktop/src-tauri/target/release/bundle/
```

产物按平台生成：macOS `.app` / `.dmg`、Windows `.msi` / `.exe`、Linux `.AppImage` / `.deb`（在对应系统上构建）。macOS 包用 ad-hoc 签名（`bundle.macOS.signingIdentity: "-"`），不做公证：首次打开要在「系统设置 → 隐私与安全性」点「仍要打开」，或执行 `xattr -dr com.apple.quarantine /Applications/BlockML.app`；要彻底免提示需要 Apple Developer ID 签名 + 公证。

## 发布

推送 `v*` tag 触发两条流水线：

| 工作流 | 产物 |
| --- | --- |
| `.github/workflows/desktop.yml` | 三平台桌面安装包 + GitHub Release |
| `.github/workflows/npm.yml` | npm 包 `@block-ml/core`、`@block-ml/viewer`、`@block-ml/cli`（带 provenance） |

发布前要求：

- tag 与根 `package.json` 的 `version` 一致（`v0.2.0` ↔ `0.2.0`），不一致流水线直接失败。
- 仓库 secrets 里配置 `NPM_TOKEN`（npm automation token，对 `@block-ml` scope 有发布权限）；npm 上需要已存在 `@block-ml` 组织。
- 已发布过的版本会跳过，重跑流水线不会因为重复版本失败。

发布后可用 `npm i -g @block-ml/cli` 安装命令行，或 `npx @block-ml/cli render app.blockml` 直接渲染。本地想预演打包内容：`pnpm -r publish --dry-run --no-git-checks`。

## 语法 30 秒

```blockml
diagram "标题" { title: "…", theme: light }   // 可选
group <id> "标题" { color: #4f46e5 }
node  <id> "标题" { group:, kind:, tech:, at: x, y, note:, src: }
edge  <from> -> <to> "标签" { kind:, via: dx, dy, dash:, bundle:, note:, src: }
```

- 没有属性的块可以写成一行，`{ }` 省略。
- `at` 是节点左上角；`via` 是连线控制点相对两端点中点的偏移（仅 `route: curve` 生效）。
- 未知 kind 降级 + warning；未知属性警告并忽略；`x-` 前缀字段原样保留。
- 完整规范：[`spec/blockml-spec-v1.md`](spec/blockml-spec-v1.md)

## 仓库结构

```
CHANGELOG.md                  版本变更记录
spec/
  blockml-spec-v1.md          语言规范（normative，当前 v1.1）
examples/
  order-platform.blockml      虚构的电商订单平台（可直接渲染）
  order-platform.html         渲染成品，可双击打开
packages/
  core/                       词法、解析、校验、序列化、几何、坐标回写
  viewer/                     渲染 + 交互 + 单文件导出
  cli/                        blockml validate / render / fmt / inspect
apps/
  desktop/                    Tauri 2 桌面阅读器（复用 viewer，注册 .blockml）
skills/
  blockml/                    给 agent 的写作与自检流程
```

## CLI

`npm i -g @block-ml/cli` 装好之后直接跑 `blockml`；不装也能用仓库里的 `node packages/cli/bin.mjs`。

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

v0.1 已实现：规范、parser、viewer（四种排列 + 悬停高亮 + 分组折叠 / 图层隐藏）、CLI、agent skill、Tauri 桌面阅读器。

路线图：

- [ ] 自定义 kind 样式（`style kind service { color: … }`）
- [ ] 子图嵌套 / 边链 `a -> b -> c`
- [x] 桌面阅读器（Tauri，含 `.blockml` 文件关联）
- [x] 四种排列算法 + 悬停高亮
- [x] 分组折叠 + 图层隐藏（仅视图，不写回）
- [ ] npm 发布与 d.ts

## License

MIT
