# @block-ml/viewer

BlockML 交互画布：渲染、拖拽（回写源码）、图层开关、导出 SVG，以及把整张图内联成可双击的单文件 HTML。
渲染质量（共享端口、法线出线、标签避让、避障与跳弧）由这一层统一保证，不依赖文档里的样式键。

`@block-ml/cli` 的 `blockml render` 和 BlockML 桌面端用的就是这一份实现。

## 安装

```bash
npm i @block-ml/viewer @block-ml/core
```

## 用法（ESM）

```ts
import { mount } from "@block-ml/viewer";

const handle = mount(document.getElementById("canvas")!, {
  source: text,                 // .blockml 源码
  theme: "light",               // light | dark
  mode: "presentation",         // 嵌入编辑器时可用 editing
  route: "orthogonal",          // 初始走线：curve（默认）| orthogonal；可用 handle.setRoute() 切换
  onSourceChange: (next) => save(next), // 拖动后回写
});

handle.fit();
const svg = handle.toSVG();
```

`viewer` 默认 `editing` 以保持嵌入编辑器行为；单文件 HTML 与 CLI 交付默认 `presentation`，
只保留选择、详情、缩放与平移，顶部可切到编辑态。`mount()` 返回的 `ViewerHandle` 还提供
`setMode` / `getMode`、`zoomTo`、`layout`、`toggleLayers`、`setHiddenNodes`、
`setCollapsedGroups`、`showAll`、`getVisibility` 等方法。

## 用法（普通 HTML）

IIFE 构建会把 API 挂到 `globalThis.BlockML`：

```html
<link rel="stylesheet" href="node_modules/@block-ml/viewer/dist/styles.css" />
<script src="node_modules/@block-ml/viewer/dist/viewer.iife.js"></script>
<script>
  BlockML.mount(document.getElementById("canvas"), { source: "diagram \"demo\" {}" });
</script>
```

## 单文件 HTML

把 CSS 与 IIFE 内联进一个文件，双击即可打开——这正是 CLI 在做的事：

```ts
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderStandaloneHTML } from "@block-ml/viewer";

const require = createRequire(import.meta.url);
const read = (id: string) => readFileSync(require.resolve(id), "utf8");

const html = renderStandaloneHTML({
  source: text,
  viewerScript: read("@block-ml/viewer/iife"),
  viewerCss: read("@block-ml/viewer/styles.css"),
  title: "订单平台",
  theme: "light",
});
```

也可以直接用命令行：`blockml render your.blockml -o your.html`（默认演示态，`--route` 只设初始走线风格，阅读器工具条可随时切换，`--readonly` 隐藏编辑切换）。

## 相关包

- [`@block-ml/core`](https://www.npmjs.com/package/@block-ml/core)：解析与规范化
- [`@block-ml/cli`](https://www.npmjs.com/package/@block-ml/cli)：命令行

文档与语言规范：[Roiocam/blockml](https://github.com/Roiocam/blockml)

## License

MIT
