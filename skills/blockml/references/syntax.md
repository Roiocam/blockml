# BlockML 语法速查

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
| ident | `service`（裸词） | kind、group、theme、direction |
| number | `12`、`-3.5` | 坐标 |
| pair | `340, 280` | `at`、`via` |
| boolean | `true` / `false` | `dash` |
| list | `[a, b, "c d"]` | `tags` |
| color | `#rgb` / `#rrggbb` | `color` |

普通字符串支持 `\n` `\t` `\"` `\\` 转义。三引号字符串原样保留，适合多行 `note`。

## 属性

### diagram

| 属性 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 文件名 | 画布标题 |
| `subtitle` | string | — | 副标题 |
| `theme` | ident | `light` | `light` / `dark` |
| `direction` | ident | `TB` | 自动布局方向 |
| `route` | ident | `curve` | `curve` 贝塞尔 / `orthogonal` 正交（单吸附点、圆角转折、跨线跳弧） |
| `version` | string | `"1.0"` | 规范版本 |

### group

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `color` | color | 框与标题色，缺省按调色板 |
| `note` | string | 详情 |
| `src` | string | 出处 |

### node

| 属性 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `group` | ident | — | 必须已声明 |
| `kind` | ident | `service` | 见 kinds.md |
| `tech` | string | — | 卡片副标题，一行 |
| `at` | pair | 自动 | **左上角**坐标 |
| `note` | string | — | 详情面板 |
| `src` | string | — | `文件:行` |
| `tags` | list | `[]` | 过滤用 |

### edge

| 属性 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `kind` | ident | `rest` | 见 kinds.md |
| `via` | pair | `0, 0` | 相对两端点**中点**的偏移 |
| `dash` | boolean | 按 kind | 强制虚线 |
| `bundle` | ident | — | 同名边汇流成一条主干再分叉（仅 `route: orthogonal`） |
| `note` / `src` | string | — | 详情面板 |

块头里的字符串就是这条边的标签；`label:` 属性会覆盖它。

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

1. 手写 `at` / `via` 优先。
2. 没写 `at`：渲染器按文档顺序补位，**不写回文件**。
3. 用户拖动后：只回写 `at` / `via` 两个键，其余字节不动。
