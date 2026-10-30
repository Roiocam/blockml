# @block-ml/core

BlockML 的解析、校验、序列化、布局与可见性计算。纯 TypeScript，无运行时依赖。

[BlockML](https://github.com/Roiocam/blockml) 是 diagram-as-code 语言：语义和布局写在同一个 `.blockml`
文件里——写完是图，拖完还是同一份文件。

## 安装

```bash
npm i @block-ml/core
```

## 用法

```ts
import { parse, serialize, hasErrors } from "@block-ml/core";

const { document, diagnostics } = parse(source);
if (hasErrors(diagnostics)) {
  throw new Error(
    diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `${d.line}:${d.column} ${d.message}`)
      .join("\n"),
  );
}

const text = serialize(document); // 规范化：缩进、属性顺序、数字格式
```

主要导出：

| 能力 | API |
| --- | --- |
| 解析 / 词法 | `parse`、`tokenize` |
| 回写 | `serialize` |
| 算法布局 | `layoutDocument`、`applyLayout`、`LAYOUT_ALGORITHMS` |
| 几何 / 走线 | `orthogonalRoute`、`planSidePorts`、`edgeGeometry`、`routeCrosses`、`boxOf`（两种风格都绕开非端点节点） |
| 可见性 | `resolveVisibility`、`visibleNodes`、`visibleEdges`、`visibleGroups` |
| 类型 | `BlockDocument`、`NodeDecl`、`EdgeDecl`、`GroupDecl`、`Diagnostic` 等 |

## 相关包

- [`@block-ml/viewer`](https://www.npmjs.com/package/@block-ml/viewer)：交互画布，拖拽后回写同一份源码
- [`@block-ml/cli`](https://www.npmjs.com/package/@block-ml/cli)：`blockml validate / render / fmt / layout / inspect`

语言规范与示例：[Roiocam/blockml](https://github.com/Roiocam/blockml)

## License

MIT
