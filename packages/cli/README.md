# @block-ml/cli

BlockML 命令行：校验、渲染单文件阅读器、格式化、算法重排、结构摘要。

[BlockML](https://github.com/Roiocam/blockml) 是 diagram-as-code 语言：语义和布局写在同一个 `.blockml`
文件里——写完是图，拖完还是同一份文件。

## 安装

```bash
npm i -g @block-ml/cli
blockml --help
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `blockml validate <file...>` | 校验语法与引用，输出诊断 |
| `blockml render <file> [-o out.html]` | 生成可双击的单文件阅读器（viewer 内联，无外部依赖） |
| `blockml fmt <file> [--write]` | 规范化格式（会丢弃注释，加 `--write` 才落盘） |
| `blockml layout <file> [--algo <name>] [--write]` | 算法重排并回写 `at` 坐标 |
| `blockml inspect <file>` | 打印结构摘要 |

`--algo` 可选 `layered`、`pipeline`、`snowflake`、`compact`。

## 示例

```bash
blockml validate examples/order-platform.blockml
# ✓ examples/order-platform.blockml  12 nodes · 16 edges · 4 groups

blockml render examples/order-platform.blockml -o out/order-platform.html
# ✓ out/order-platform.html  163.1 KB

blockml layout order.blockml --algo layered --write
```

`render` 选项：`-o/--out`、`--title`、`--theme light|dark`、`--readonly`。

## 桌面版

同一份 viewer 的桌面安装包（macOS / Windows / Linux）：
[Releases](https://github.com/Roiocam/blockml/releases)

## 相关包

- [`@block-ml/core`](https://www.npmjs.com/package/@block-ml/core)：解析与规范化
- [`@block-ml/viewer`](https://www.npmjs.com/package/@block-ml/viewer)：交互画布

## License

MIT
