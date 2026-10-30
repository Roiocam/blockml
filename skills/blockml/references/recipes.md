# 三种配方

> 共同前提：**不写坐标、不写颜色**。平台按 group 分列，组内节点自动排；需要整体换一种排法时才用 `layout --algo`。

## 1. 分层架构（最常用）

按「接入 → 平台 → 执行 → 数据」声明 group，外部依赖单独成组。

```blockml
group access "接入层"
group platform "平台"
group runtime "执行面"
group data "数据面"

node ui "web" { group: access, kind: ui }
node gw "gateway" { group: access, kind: service }

node app "app" { group: platform, kind: service }
node worker "worker" { group: platform, kind: service }

node sandbox "sandbox" { group: runtime, kind: acp }

node pg "PostgreSQL" { group: data, kind: db }
```

要点：

- 一个 group 一列，列序按组内最浅依赖深度；接入层自然在最左，数据面在最右。
- 同组节点按声明顺序纵向排，组框自动包住成员。
- 数据面放右侧竖列，避免长线横穿中间。

## 2. 调用链

一条主链路从左到右，旁路依赖上下分叉。**每条边标端口/路径**，不要只写「调用」。

```blockml
edge gw -> app "/api/v1/**" { kind: rest }
edge app -> sandbox "ACP POST + SSE" { kind: acp }
edge app -> pg "JDBC" { kind: sql }
```

要点：

- 主链路的节点放进同一条 group 序列，平台会按列展开。
- 旁路依赖用 `opt` / `gate`，视觉上自然弱化。
- 反向调用（回调、轮询）不用手写 `via`；平台会选端口、避节点、在交叉处画跳弧。

## 3. 数据面 / 存储归属

回答「谁写谁、谁读谁、哪张表归谁」。

```blockml
node app "app" { group: platform, kind: service }
node pg "PostgreSQL" { group: data, kind: db }
node cache "Redis" { group: data, kind: cache }

edge app -> pg "agent_session · 5 池" { kind: sql }
edge app -> cache "session" { kind: sql }
edge skills -> pg "skill_store（独立库）" { kind: sql }
```

要点：

- 一个库多个库名时，写在边标签里（`agent_session` / `skill_store`），不要拆成多个 db 节点——除非它们真的在不同实例上。
- 只画主干，不要把所有表都画成节点。
- 同一对节点有多条边时不用手写偏移，端口由平台分配。

## 视觉验收

写完直接 `render` 看默认效果，**不要靠手写 `at` / `via` 修补**：

1. 线穿节点、标签压节点/组头/其它标签、标签被裁掉、交叉没有跳弧——都算平台缺陷，记录文件与截图，不要用样式键绕过。
2. 如果整体形状确实不适合当前分层（例如是中心辐射结构），用 `layout --algo snowflake --write` 换排法，再交给平台走线。
3. 手工微调只在编辑态拖动完成，坐标由编辑器回写，不手写。
