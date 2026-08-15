# Agent Note: 工作图 v9 —— 拓扑优化器与跨会话项目复活

Status: implemented

[English](2026-08-14-workgraph-v9-optimizer-project-revive.md) | 中文

## Problem

还差两个收尾机制。其一，图只运行规划器产出的内容：假依赖留在 DAG 中，微小与超大节点从不合并或拆分，唯一改进路径是发现驱动的重规划。其二，图完全活在会话日志里：新会话中的队友什么都看不到，第二个会话也无法被阻止恢复属主正在执行的工作。jxca 用规划边界拓扑优化器与排他锁下的仓库根 `.dsh/graph.jsonl` 投影同时收尾两者。

## Decision

**拓扑优化器**（`optimizer.ts`）仅在规划边界运行——初始规划之后，并搭车每个重规划边界，绝不在执行中途。`maybeOptimize` 以 `optimizer` 开关、活图与共享重规划上限的空闲槽位为门；优化器子代理（与规划同 spawn seam，自有 `OPTIMIZER_OUTPUT_SCHEMA`）发布受限操作——`remove_dep`、`reorder`、`merge`、`split`——仅作用于 Waiting/Ready 节点。`applyOptimization` 执行逐操作规则（仅 pending 目标、已知 id、无自/重、`gn-final` 永不合并/拆分/作合并方、无非 pending 依赖者、split 2–3 个替换且 slug 卫生、deps 存活、无死依赖）与最终不变量：终节点门在全部幸存非终节点之上重建，pending 状态双向再推导（嫁接的依赖把 Ready 节点降级——纯 promote 的回合会静默违反分派顺序）、非 pending 节点字节级不变、可环性与节点上限复核。应用的回合自增计划版本、消耗共享重规划槽位、记录 `optimized` 并冻结新基线；空操作列表是被尊重的 no-op；任何失败（拒绝的操作、子代理错误、基线冲突）都带警告降级——增强回合绝不暂停运行中的图。

**跨会话复活**（`project.ts`）：仓库根 `.dsh/graph.jsonl` 投影编排——第 1 行头部（快照去掉节点），随后每行一个节点，原子写入（tmp + rename），经内容哈希 id 行可合并。`set` 在任何提交**之前**认领仓库锁（create-exclusive sidecar）——被拒绝的第二持有者在会话日志中不留痕迹；持有锁期间每个检查点提交都重投影（写失败带警告降级——会话日志才是真源）；`resume` 在另一会话持锁时拒绝，且拒绝先于 `requireGraph`，使复活图被锁拒绝而非 NOT_FOUND；新会话的 `status` 复活投影并净化降级（Running→Ready，Active→user_paused 带重启消息）；`clear` 删除文件并释放锁；畸形文件是响亮错误，绝非"无图"。引擎的 `status` 改为异步以承载复活路径。`WORKGRAPH_INVALID_OPTIMIZATION`、`WORKGRAPH_MALFORMED_PROJECTION` 与 `WORKGRAPH_LOCKED` 加入域错误码。

## Alternatives considered

**仅在实际应用重规划后运行优化器。** 否决：恢复图的 resume 边界永远见不到回合；jxca 在每个重规划边界触发优化器，共享上限门已约束成本。

**flock 式建议锁。** 为 node 运行时否决：create-exclusive sidecar 可移植、可在单进程内跨会话测试、clear 时释放（陈旧文件是响亮的锁定状态，契合"第二持有者只读"契约）。

**保持 `status` 同步并另设复活入口。** 否决：每个调用方都要走两条路径；异步 status 使复活成为唯一观察面。

## Consequences

- 假依赖解锁真实并行批次；merge/split 在共享上限与冻结基线之下重塑 DAG；每个优化器失败都降级而不暂停。
- 图在 `.dsh/graph.jsonl` 团队可见且有排他写者；第二会话可读但不可恢复；新会话净化并暂停地复活；clear 删除投影与锁。
- 284 个 workgraph + 20 个客户端测试全绿，逐文件 100% 覆盖；主机与客户端 typecheck 与 staged lint 干净。
- Phase 2 issue 02–09 全部完成；最终自验运行完整仓库套件。
