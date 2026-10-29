# BlockML 语言规范 v1.0

Status: **normative** · Date: 2026-10-29 · 后缀 `.blockml`

BlockML 是给**架构图**用的 diagram-as-code 语言。它只描述三件事：有哪些块（node）、块之间靠什么连（edge）、它们怎么分组（group）。**布局坐标也是语言的一部分** —— 这是它和 Mermaid / D2 的关键差别：写完图和拖完图，落在同一个文件里。

```blockml
diagram {
  title: "订单平台"
}

group core "核心服务" {
  color: #4f46e5
}

node order "order-service" {
  group: core
  kind: service
  tech: "Spring Boot 8080"
  at: 340, 280
}

edge order -> pg "JDBC" {
  kind: sql
}
```

---

## 1. 设计约束

| # | 约束 | 后果 |
| --- | --- | --- |
| C1 | **文件即事实源**：语义 + 坐标都在同一份文本里 | 不需要 sidecar 布局文件 |
| C2 | **可 round-trip**：parse → serialize → parse 必须得到同一棵树 | 工具可以安全重写文件 |
| C3 | **只写改动的键**：编辑器拖完只回写 `at` / `via` | 手写注释和格式不被破坏 |
| C4 | **未知即降级，不阻断**：未知 kind / 未知 `x-` 属性给 warning | 旧工具能打开新文件 |
| C5 | **无外部依赖**：解析器和渲染器都不需要运行时库 | 内网双击即用 |

非目标：流程图语义（分支/泳道）、类图关系（继承/实现）、自动布局质量。BlockML 只保证「坐标可存、图画得出来」。

---

## 2. 词法

### 2.1 文件

- 扩展名 `.blockml`，UTF-8，`LF` 或 `CRLF` 均可。
- 一个文件 = 一张图（`diagram`）。多张图请用多个文件。

### 2.2 注释

```blockml
# 行注释，到行尾
// 同样等价
```

块内块外都可写。注释不进入 AST 的语义，但实现**必须**在格式化时保留。

### 2.3 标识符

```
[A-Za-z_][A-Za-z0-9_.-]*
```

用于块 id、`group` 引用、`kind` 值。大小写敏感，推荐 `kebab-case` 或 `snake_case`。

### 2.4 字符串

```blockml
tech: "Spring Boot 8080"
note: "第一行\n第二行"
note: """
原样多行文本
  保留缩进
"""
```

- 普通字符串用双引号，支持转义 `\"` `\\` `\n` `\t`。
- 三引号字符串**原样保留**内容（不解析转义），去掉开头换行和结尾换行。
- 单引号不合法（报 BLK003）。

### 2.5 其它字面量

| 类型 | 写法 | 例 |
| --- | --- | --- |
| number | 整数或小数 | `12`, `-3.5` |
| boolean | 小写 | `true` / `false` |
| pair | 两个 number，逗号分隔 | `340, 280` |
| list | 方括号，逗号分隔 | `[a, b, "c d"]` |
| ident | 见 2.3 | `service` |
| color | `#rgb` / `#rrggbb` | `#4f46e5` |

`pair` 的两个分量按出现顺序解释为 `x, y`。

### 2.6 结构符号

`{` `}` `[` `]` `:` `,` `->`。语句以**换行**或 `;` 结束。

块内属性之间可以用换行、分号或逗号分隔，所以小块的属性可以写在同一行：

```blockml
node a "A" { kind: db, group: core }
edge a -> b "调用" { kind: sql, via: -20, 0 }
```

缩进不参与语法，仅用于可读性。

---

## 3. 文档结构

一个文档由 0..n 个顶层块组成，顺序任意（引用可前向）。

```
document  := diagram? group* node* edge*
diagram   := "diagram" STRING? block
group     := "group" IDENT STRING? block
node      := "node" IDENT STRING? block
edge      := "edge" IDENT "->" IDENT STRING? block
block     := "{" (property NEWLINE)* "}" | ε
property  := IDENT ":" value
```

- 块头后面的标题可省略，缺省用 id。
- `{ }` 可省略：无属性时直接写一行。
- **空块 `{ }` 与省略等价**。

### 3.1 diagram

```blockml
diagram "标题" {
  title: "订单平台架构画布"
  subtitle: "diagram-as-code"
  theme: light
  direction: TB
  version: "1.0"
}
```

| 属性 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 文件名 | 画布标题 |
| `subtitle` | string | — | 副标题 |
| `theme` | ident | `light` | `light` / `dark` / `auto` |
| `direction` | ident | `TB` | 仅在缺 `at` 自动布局时参考 |
| `version` | string | `"1.0"` | 目标规范版本 |

### 3.2 group

```blockml
group core "核心服务" {
  color: #4f46e5
  note: "下单、库存、支付三个服务"
  src: "docs/architecture/README.md:5"
}
```

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `color` | color | 组框与标题色；缺省按调色板分配 |
| `label` | string | 覆盖块头标题 |
| `note` / `src` | string | 详情面板内容 |

组的框由**成员节点的包围盒**自动算出，不能手写坐标。

### 3.3 node

```blockml
node order "order-service" {
  group: core
  kind: service
  tech: "Spring Boot 8080"
  at: 340, 280
  note: "下单主链路，写 orders 库"
  src: "docs/architecture/README.md:5"
  tags: [core, java]
}
```

| 属性 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `group` | ident | — | 必须指向已声明的 group |
| `kind` | ident | `service` | 见 §5 |
| `label` | string | 块头标题 | 覆盖显示名 |
| `tech` | string | — | 卡片副标题（一行，超长截断） |
| `at` | pair | 自动 | 节点**左上角**世界坐标（px） |
| `note` | string | — | 详情面板正文，可多行 |
| `src` | string | — | 出处，约定 `文件:行` |
| `tags` | list | `[]` | 供过滤/搜索 |

### 3.4 edge

```blockml
edge app -> sandbox "ACP POST + SSE" {
  kind: acp
  via: -30, 0
  src: "AgentsAcpClient.java:843-857"
}
```

| 属性 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `kind` | ident | `rest` | 见 §5 |
| `label` | string | 块头标题 | 线上标签，可省略 |
| `via` | pair | `0, 0` | 控制点相对两端点中点的偏移 |
| `dash` | boolean | 按 kind | 强制虚线/实线 |
| `note` / `src` | string | — | 详情面板内容 |

规则：

- `from` 与 `to` 必须存在（BLK007）。自环允许。
- 同一对节点可以有多条边，渲染器**必须**自动错开（建议间距 ≥ 40px）。
- 边的箭头永远指向 `to`。

---

## 4. 类型与解析

### 4.1 属性值必须匹配合法类型

```blockml
at: 340, 280        # ✅ pair
at: "340, 280"      # ❌ BLK006（字符串不是 pair）
kind: "service"     # ✅ 字符串会被当作 ident 接受，但 fmt 输出裸 ident
```

### 4.2 未知属性

- `x-` 前缀：**保留**，任何块均可写，实现放行且不报错。
- 其它未知键：warning `BLK005`，值丢弃。

### 4.3 未声明 group

`group: foo` 而 `foo` 未声明 → error `BLK008`，该节点视为无组。

### 4.4 重复 id

同一文档内 `node` / `group` 的 id 各自唯一 → 否则 error `BLK004`，保留第一个。

---

## 5. kind 词表（v1 内置）

`kind` 只影响**视觉**，不影响语义。实现必须内置下表；未知值降级并给 warning `BLK009`。

### 5.1 节点 kind

| kind | 含义 | 建议色 |
| --- | --- | --- |
| `service` | 自有服务 | `#4f46e5` |
| `ui` | 界面 / 前端 | `#64748b` |
| `db` | 数据库 | `#10b981` |
| `cache` | 缓存 | `#ef4444` |
| `idp` | 身份提供方 | `#f59e0b` |
| `acp` | 执行面 / ACP 运行时 | `#0ea5e9` |
| `model` | 模型网关 | `#14b8a6` |
| `channel` | 外部渠道 | `#ec4899` |
| `ext` | 其它外部依赖（默认降级目标） | `#8b5cf6` |

### 5.2 边 kind

| kind | 含义 | 建议线型 |
| --- | --- | --- |
| `rest` | HTTP / REST | 实线 `#6366f1` |
| `acp` | ACP 协议 | 实线 `#0ea5e9` |
| `sse` | 单向事件流 | 虚线 `#0ea5e9` |
| `sql` | 数据库访问 | 实线 `#10b981` |
| `rpc` | 服务间 RPC | 实线 `#8b5cf6` |
| `oidc` | 身份 / 令牌 | 虚线 `#f59e0b` |
| `llm` | 模型调用 | 实线 `#14b8a6` |
| `mcp` | MCP 工具面 | 虚线 `#64748b` |
| `ws` | 长连接 | 虚线 `#ec4899` |
| `gate` | 准入 / 闸门 | 点线 `#f43f5e` |
| `opt` | 可选 / 弱依赖（默认降级目标） | 点线 `#94a3b8` |

---

## 6. 诊断

诊断对象：

```ts
interface Diagnostic {
  severity: "error" | "warning";
  code: string;        // BLKxxx
  message: string;
  line: number;        // 1-based
  column: number;      // 1-based
  hint?: string;       // 一句话修复建议
}
```

| 码 | 级别 | 含义 |
| --- | --- | --- |
| `BLK001` | error | 无法识别的语句 |
| `BLK002` | error | 块未闭合（到 EOF 仍在块内） |
| `BLK003` | error | 字符串未终止 |
| `BLK004` | error | id 重复 |
| `BLK005` | warning | 未知属性（非 `x-` 前缀） |
| `BLK006` | error | 属性类型不匹配 |
| `BLK007` | error | 边端点不存在 |
| `BLK008` | error | 引用了未声明的 group |
| `BLK009` | warning | 未知 kind，已降级 |
| `BLK010` | warning | `version` 高于实现支持 |
| `BLK011` | error | 块头缺必填字段 |
| `BLK012` | error | 颜色格式错误 |

**有 error 时不得渲染**（可渲染上一次成功的结果）。**只有 warning 时必须正常渲染**。

---

## 7. 布局语义

### 7.1 坐标系

- 世界坐标，单位 px，原点左上，y 向下。
- `at` 是节点左上角；节点尺寸由渲染器决定（建议 200×62，随标题自适应）。
- 组框 = 成员节点包围盒 + 内边距（建议左右 30、上 34、下 30）。

### 7.2 自动布局

缺 `at` 的节点由实现补位，规则不强制。实现**不得**把自动补位的结果写回源文件——只有用户在界面上拖动过，才回写。

实现应至少提供以下四种**显式重排**算法（命令或交互入口），选择后可以整体覆盖 `at`：

| 算法 | 形状 | 适合 |
| --- | --- | --- |
| `layered` | 一个 group 占一列，列序按该组最浅依赖深度 | 有明确分层（接入 / 服务 / 数据）的架构图 |
| `pipeline` | 一个 group 占一列，列序按声明顺序 | 阶段顺序由人定、与依赖不完全一致的流水线 |
| `snowflake` | 度数最高的节点居中，其余按环向外扩散 | 没有清晰分层、以中心服务为核心的星形依赖 |
| `compact` | 按度数排序的方形网格 | 只看清单、不关心连线的示意图 |

重排是**破坏性**操作：会覆盖所有手工坐标，只保留 `via`。

### 7.3 边的走线

`via` 是**相对两端点中点的偏移**，不是绝对坐标。这样节点移动后曲线仍跟随。

```
control = midpoint(p1, p2) + perpendicular(offset) + via
```

同一对节点的多条边，`via` 之外还要叠加自动错开量；手动拖动控制点时，写回的 `via` 应扣除自动错开量，保证「拖到哪就是哪」。

### 7.4 回写契约

交互式编辑器在以下时机回写，且**只改这两个键**：

| 动作 | 回写 |
| --- | --- |
| 拖动节点结束 | `at: x, y` |
| 拖动边控制点结束 | `via: dx, dy` |

回写必须保留：注释、块顺序、其它属性、未修改的格式。建议实现为「按行定位 + 只替换目标键」。

---

## 8. 序列化（canonical form）

工具产出（而非用户手写）的规范格式：

1. 块顺序：`diagram` → `group`（按声明序）→ `node` → `edge`。
2. 属性顺序：`group` `kind` `label` `tech` `at` `note` `src` `tags`。
3. 缩进 2 空格；块之间空一行。
4. pair 写作 `x, y`；ident 不加引号；string 一律加引号。
5. 空属性块折叠为单行块头。

---

## 9. 版本与演进

- `version` 是**目标**版本，不是文件版本。实现支持 `1.x` 即接受 `1.0`–`1.99`。
- 次版本新增：只增属性或 kind，不改变既有语义。
- 主版本变更：必须提供迁移说明与转换脚本。
- 未来（非 v1）：块级样式 `style kind service { color: … }`、子图嵌套、边链 `a -> b -> c`。

---

## 10. 渲染最小集（实现契约）

一个合格的 BlockML 阅读器至少要提供：

1. 渲染 group 框、node 卡片（标题 + tech）、edge 曲线 + 标签。
2. 图例（按出现的 kind）。
3. 节点拖拽，并遵守 §7.4 回写。
4. 边选中 + 控制点拖拽，并遵守 §7.4 回写。
5. 缩放 / 平移 / 适应窗口。
6. 导出 SVG。
7. 语法错误定位到行，错误时不覆盖上一次成功渲染。
8. 悬停或选中节点时，高亮与它相连的边并淡化其余元素。
9. 提供至少一种显式重排算法入口（见 §7.2）。
10. 分组折叠与隐藏：group 框右上角提供折叠开关；折叠后组成员与相关边不绘制，组框收缩为带成员/连线计数的胶囊；隐藏的 group 与 node 连同其边一起不绘制。**可见性是视图状态，不进文件、不写回源码**；提供「全部显示」恢复。

建议但非必需：标签避让、导出 PNG、只读模式、深色主题、按 kind 过滤。

---

## 11. 参考实现

| 包 | 职责 |
| --- | --- |
| `@blockml/core` | 词法、解析、校验、序列化、几何辅助 |
| `@blockml/viewer` | 渲染、交互、单文件 HTML 导出 |
| `@blockml/cli` | `blockml validate` / `blockml render` |
| `skills/blockml` | 给 agent 的写作与自检流程 |
