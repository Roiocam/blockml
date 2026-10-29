# Changelog

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
