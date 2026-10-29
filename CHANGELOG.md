# Changelog

## 0.2.3 — 2026-10-29

### 修复

- 导出图与查看不一致：`toSVG()` 过去只内联一份手写的最小样式，丢了 `VIEWER_CSS` 里的分组底色透明度（`.bml-group-box{fill-opacity:.06}`）和 CSS 变量，于是导出图里分组变成实心色块、分组标签底板退成黑块、节点与连线底色也不再跟随主题。现在导出直接内嵌完整的 `VIEWER_CSS`，把当前主题的 `--bml-*` 变量求值后写到根 `<svg>` 上，并铺一张画布色底；同时移除折叠按钮、选中 / 聚焦等交互态。SVG 与 PNG 导出从此与屏幕同源（画布点阵仍不导出，它是编辑辅助）。

## 0.2.2 — 2026-10-29

### 修复

- macOS 安装包被系统判为「已损坏」：此前的 `.app` 只有链接器级临时签名（`adhoc,linker-signed`），bundle 内没有 `_CodeSignature`，macOS 15+ 的 Gatekeeper 会直接报「已损坏，无法打开」。打包配置改为 ad-hoc 深签名（`bundle.macOS.signingIdentity: "-"`），CI 里断言 `_CodeSignature/CodeResources` 存在且 `codesign --verify --deep --strict` 通过；系统提示退回到「无法验证开发者」，按发版说明放行即可。要彻底免提示仍需 Apple Developer ID 签名 + 公证。

## 0.2.1 — 2026-10-29

### 修复

- npm 包页没有说明：三个包目录此前没有 `README.md`，registry 里 `readme` 为空，页面只剩标题。现在 `@block-ml/core` / `@block-ml/viewer` / `@block-ml/cli` 各自带上安装、用法与相关包链接的 README，并补了 `homepage` / `bugs` 字段。

语言与渲染行为无变化，版本号只用于把新的包元数据发布上去。

## 0.2.0 — 2026-10-29

### 新增

- **正交走线**：`diagram { route: orthogonal }` 切到 draw.io 式直角布线，转折为圆角（半径不超过相邻两段各自长度的一半），跨线处上层线画跳弧。
- **边汇流**：边属性 `bundle: <name>`，同名边在正交走线下共用公共端点与一段主干，再分叉到各自对端，标签只落在各自支线上（规范 §3.4 / §7.3）。
- **单吸附点**：每个节点每条边只从所选出入口的边框中点出入，同类线共用同一个点，异色线由车道分开，不再按边各自错开。
- **标签避让**：标签自动落在本边独享的直线段上，不压其它连线、不落在共用主干上。
- **npm 分发**：`v*` tag 触发 `.github/workflows/npm.yml`，发布 `@block-ml/core` / `@block-ml/viewer` / `@block-ml/cli`（带 provenance，已发布版本自动跳过），`npm i -g @block-ml/cli` 即可使用命令行。

### 修复

- 文字字号失效：`font: 500 10.5px/1 inherit` 这类简写会被浏览器整条丢弃，标签与节点标题实际按 16px 渲染、溢出标签底色并互相压字；改为 longhand 后标签 10.5px、节点标题 13px/600。

### 语言兼容

- 标记语言只新增可选属性 `bundle`，其余变化都在渲染层；v1.0 写法的 `.blockml` 文件无需修改即可打开。

## 0.1.0 — 2026-10-29

- 首个发布：`.blockml` 语法、parser / validator / serializer、交互式单文件 HTML 阅读器、CLI（`validate` / `render` / `fmt` / `inspect`）、Tauri 桌面阅读器与多平台发布流水线。
