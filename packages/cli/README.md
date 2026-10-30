# @block-ml/cli

BlockML 命令行：校验、渲染单文件阅读器、格式化、算法重排、结构摘要。

[BlockML](https://github.com/Roiocam/blockml) 是 diagram-as-code 语言：作者只写语义，布局与渲染质量由平台负责；
编辑器拖动后的坐标回写到同一个 `.blockml` 文件。

## 安装

```bash
npm i -g @block-ml/cli
blockml --help
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `blockml validate <file...>` | 校验语法与引用，输出诊断 |
| `blockml render <file> [-o out.html] [--route curve\|orthogonal]` | 生成可双击的单文件阅读器（viewer 内联，无外部依赖；默认演示态） |
| `blockml fmt <file> [--write]` | 规范化格式（会丢弃注释，加 `--write` 才落盘） |
| `blockml layout <file> [--algo <name>] [--write]` | 破坏性整体重排并回写 `at` 坐标 |
| `blockml inspect <file>` | 打印结构摘要 |

`--algo` 可选 `layered`、`pipeline`、`snowflake`、`compact`。

## 示例

```bash
blockml validate examples/order-platform.blockml
# ✓ examples/order-platform.blockml  12 nodes · 16 edges · 4 groups

blockml render examples/order-platform.blockml -o out/order-platform.html
blockml render examples/order-platform.blockml -o out/order-platform-ortho.html --route orthogonal

blockml layout order.blockml --algo layered --write
```

`render` 选项：`-o/--out`、`--title`、`--theme light|dark`、`--readonly`、`--route curve|orthogonal`。
走线风格是查看器预设，不需要写进 `.blockml`。

## 桌面版

同一份 viewer 的桌面安装包（macOS / Windows / Linux）：
[Releases](https://github.com/Roiocam/blockml/releases)

## 相关包

- [`@block-ml/core`](https://www.npmjs.com/package/@block-ml/core)：解析与规范化
- [`@block-ml/viewer`](https://www.npmjs.com/package/@block-ml/viewer)：交互画布

## License

MIT
