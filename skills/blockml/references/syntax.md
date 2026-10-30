# BlockML 语法速查

> 新文档只写**语义**：块、连线、分组、kind、tech、note、src、tags、bundle。布局与样式键（`at` / `via` / `dash` / `color` / `theme`）是编辑器回写或旧文件兼容键，不要手写；走线风格（曲线 / 正交）由阅读器工具条决定，`route` 不是文档键。

## 顶层块

```blockml
diagram "标题" { … }      // 0..1 个
group <id> "标题" { … }   // 0..n 个
node  <id> "标题" { … }   // 0..n 个
edge  <from> -> <to> "标签" { … }  // 0..n 个
```

- 顺序随意，引用可以前向（edge 写在 node 之前也行）。
- 标题可省略，缺省用 id。
- 没有属性时 `{ }` 可以整个省掉，写成一行。
- 缩进不参与语法。

## 注释

```blockml
// 行注释
# 行注释（`#` 后面必须是空格或行尾）
```

`#4f46e5` 这种紧贴 hex 的会被当成颜色。

## 值类型

| 类型 | 写法 | 出现在 |
| --- | --- | --- |
| string | `"文本"` / `"""多行"""` | title、tech、note、src、label |
| ident | `service`（裸词） | kind、group、bundle、旧文件 theme / direction |
| number | `12`、`-3.5` | 旧文件坐标 |
| pair | `340, 280` | 旧文件 `at`、`via` |
| boolean | `true` / `false` | 旧文件 `dash` |
| list | `[a, b, "c d"]` | `tags` |
| color | `#rgb` / `#rrggbb` | 旧文件 `color` |

普通字符串支持 `\n` `\t` `\"` `\\` 转义。三引号字符串原样保留，适合多行 `note`。

## 属性

### diagram

| 属性 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 文件名 | 画布标题 |
| `subtitle` | string | — | 副标题 |
| `version` | string | `"1.0"` | 规范版本 |
| `theme` | ident | `light` | **兼容保留**，新文档不写 |
| `direction` | ident | `TB` | **兼容保留**，默认分层布局不读取 |

> `route` 不是文档属性。旧文件里的 `diagram.route` 会被忽略并给出 `BLK005` 警告；走线风格在阅读器工具条切换，或用 `render --route` 设初始值。

### group

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `label` | string | 覆盖块头标题 |
| `note` | string | 详情 |
| `src` | string | 出处 |
| `color` | color | **兼容保留**；缺省按平台调色板分配 |

### node

| 属性 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `group` | ident | — | 必须已声明 |
| `kind` | ident | `service` | 见 kinds.md |
| `tech` | string | — | 卡片副标题，一行 |
| `note` | string | — | 详情面板 |
| `src` | string | — | `文件:行` |
| `tags` | list | `[]` | 过滤用 |
| `at` | pair | 平台布局 | **编辑器回写**：左上角坐标；新文档不写 |

### edge

| 属性 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `kind` | ident | `rest` | 见 kinds.md |
| `bundle` | ident | — | 同名边汇流成一条主干再分叉；`curve` / `orthogonal` 都生效 |
| `note` / `src` | string | — | 详情面板 |
| `via` | pair | `0, 0` | **编辑器回写 / 兼容保留**，新文档不写 |
| `dash` | boolean | 按 kind | **兼容保留**，新文档不写 |

块头里的字符串就是这条边的标签；`label:` 属性会覆盖它。

## 平台负责的渲染规则

- 同一节点同一侧 ≥3 条边时，普通附着点最多 2 个（一入一出）；`bundle` 另占一个。作者不需要手写偏移。
- 每条边沿边框法线出线（8–24px 直段），切线偏差 ≤ 0.5°。
- 标签中心距本边路径 ≤ 8px，且不压节点、分组标题、其它标签。
- 线不穿过非端点节点；交叉统一画跳弧。
- 标签与连线都在适应窗口内，不会被裁掉。

`curve` 与 `orthogonal` 共用上面全部规则。阅读器工具条可随时切换；`render <file> --route orthogonal` 只设初始风格。

## 诊断码

| 码 | 级别 | 含义 |
| --- | --- | --- |
| BLK001 | error | 无法识别的语句 |
| BLK002 | error | 块未闭合 |
| BLK003 | error | 字符串未终止 |
| BLK004 | error | id 重复 |
| BLK005 | warning | 未知属性 |
| BLK006 | error | 属性类型不匹配 |
| BLK007 | error | 边端点不存在 |
| BLK008 | error | group 未声明 |
| BLK009 | warning | 未知 kind，已降级 |
| BLK010 | warning | version 高于实现 |
| BLK011 | error | 块头缺必填字段 |
| BLK012 | error | 颜色格式错误 |

## 坐标怎么来的

1. 没写 `at`：平台按 `layered` 分列（一个 group 一列），**不写回文件**。
2. 手写/回写的 `at` 只覆盖该节点，其它节点保持默认位置；拖一个节点不会让整张图重排。
3. 用户在编辑态拖动后：只回写 `at`（拖控制点时回写 `via`），其余字节不动。
4. 需要另一套整体排法时用 `layout --algo ... --write`，这是破坏性重排。
