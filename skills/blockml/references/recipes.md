# 三种配方

## 1. 分层架构（最常用）

按「接入 → 平台 → 执行 → 数据」纵向分带，外部依赖放两侧或底部。

```blockml
group access "接入层" { color: #f59e0b }
group platform "平台" { color: #4f46e5 }
group runtime "执行面" { color: #0ea5e9 }
group data "数据面" { color: #10b981 }

node ui "web" { group: access, kind: ui, at: 60, 40 }
node gw "gateway" { group: access, kind: service, at: 340, 40 }

node app "app" { group: platform, kind: service, at: 340, 240 }
node worker "worker" { group: platform, kind: service, at: 700, 240 }

node sandbox "sandbox" { group: runtime, kind: acp, at: 340, 480 }

node pg "PostgreSQL" { group: data, kind: db, at: 1100, 240 }
```

要点：

- 同一层的节点 y 相同，层间距 ≥ 140。
- 组框会自动包住成员，所以同组节点要挨着。
- 数据面放右侧竖列，避免长线横穿中间。

## 2. 调用链

一条主链路从左到右，旁路依赖上下分叉。**每条边标端口/路径**，不要只写「调用」。

```blockml
edge gw -> app "/api/v1/**" { kind: rest }
edge app -> sandbox "ACP POST + SSE" { kind: acp }
edge app -> pg "JDBC" { kind: sql }
```

要点：

- 主链路节点 y 对齐。
- 旁路依赖用 `opt` / `gate`，视觉上自然弱化。
- 反向调用（回调、轮询）单独标注 `via` 绕开主线。

## 3. 数据面 / 存储归属

回答「谁写谁、谁读谁、哪张表归谁」。

```blockml
node app "app" { group: platform, kind: service, at: 200, 120 }
node pg "PostgreSQL" { group: data, kind: db, at: 700, 120 }
node cache "Redis" { group: data, kind: cache, at: 700, 40 }

edge app -> pg "agent_session · 5 池" { kind: sql }
edge app -> cache "session" { kind: sql }
edge skills -> pg "skill_store（独立库）" { kind: sql }
```

要点：

- 一个库多个库名时，写在边标签里（`agent_session` / `skill_store`），不要拆成多个 db 节点——除非它们真的在不同实例上。
- 只画主干，不要把所有表都画成节点。

## 布局微调

初版写完先跑一次 `render` 看效果，再决定要不要补 `at`。

常见的两条修正：

1. **线穿节点**：给那条边加 `via`，往空白方向偏 60–120。
2. **标签重叠**：给其中一条边加 `via`，让两条线的中点分开。

拖拽之后坐标会自动写回，不必手算。
