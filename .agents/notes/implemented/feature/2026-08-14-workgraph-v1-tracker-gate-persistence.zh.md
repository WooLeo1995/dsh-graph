# Agent Note: 工作图 v1 —— tracker 核心、计划门、会话事件持久化

Status: implemented

[English](2026-08-14-workgraph-v1-tracker-gate-persistence.md) | 中文

## Problem

工作图 spec 的 issue 01 是 agent 工作 DAG 调度器的确定性一半：在任何规划器或 worker 运行之前，词汇、状态机、计划门与持久化必须先存在，并可脱离模型穷举测试。持久格式还要撑过 issue 02–09（规划器产物、worker 会话、发现来源、预算）而不发生会话日志格式动荡；此外 goal 族"一个名字既是品牌构造器又是品牌类型"的双重含义必须在不改名公共词汇的前提下解决。

## Decision

**两个包交付核心。** `dsh-workgraph` 是 Service Definition：持久词汇（`WorkGraphSnapshot` 及其节点/历史/发现成员）、`workgraph/change` 会话事件、严格解码器与回放 fold、agent 作用域的 `workgraph/changed` emit，以及由后续 issue 实现的抽象 `ctx.workGraph` 引擎（`set`/`status`/`pause`/`resume`/`retry`/`clear` 面）。`dsh-workgraph-scheduler` 是 tracker：规范化 `gn-<fnv1a32(slug)>` 身份、有序计划门、显式接收时间戳并在非法转移抛 `WORKGRAPH_INVALID_TRANSITION` 的纯快照转移。`commitWorkGraphChange` 是每个 provider 转移都要经过的检查点漏斗：追加整体值会话事件，并在其提交后通过融合的 agent 派发器发出 agent 作用域的 `workgraph/changed` 通知，使持久日志与活动流不可能分叉。

**每次变更整体携带快照。** whole-value 规则使 fold 在严格解码后按最后写入生效，并跨变更校验身份与单调连续性；清除墓碑重置 fold。解码按设计 fail-safe：未知持久节点状态恢复为 `ready`（恢复的工作可重跑，绝不静默完成或卡死），未知历史种类解码为 `unknown` 并保留原始种类——与会话信封对 `ignorable` 的前向兼容姿态一致。完整词汇（待处理发现、token 预算、重规划次数、可选节点来源）从第一天就在场，后续 issue 填充字段而不是提升变更版本。

**计划门按 spec 固定顺序检查**（形状、非空、逐行形状与依赖去重、节点上限、slug 卫生、唯一性、非空字段、自/未知依赖、规划器顺序稳定的 Kahn 无环、规范化碰撞），每次拒绝点名确切原因；harness——而非规划器——追加门控于全部规划节点的最终节点。id 铸造可注入，因此碰撞与保留最终 id 分支无需寻找真实 FNV 碰撞即可测试。

**品牌双名沿用了 goal 族的子路径答案。** 同名值导出会遮蔽星号类型再导出，包根部的 `import type { WorkNodeId }` 会绑到构造器上；`dsh-workgraph` 导出 `./types` 子路径（与 `dsh-goal` 相同），调度器从那里导入品牌类型。

## Alternatives considered

**把 tracker 折进 Service Definition 包。** 拒绝：接缝的 provider 按设计可替换；把纯状态机放在其未来回合驱动器旁边，使组合可以只依赖词汇而不依赖实现。

**以逐转移事件（node-started、node-achieved……）作为会话日志记录。** 拒绝：整体快照变更让回放天然逐字节一致、日志更短，并让 fold 校验连续性而不是重导出转移；细粒度动词留在快照内的封顶历史里。

**把 `verifying` 存为持久状态。** 拒绝：它是活动徽章而非事实；持久化它会让验证中途崩溃变得语义不明。它不进持久联合，fail-safe 的未知状态映射使任何泄漏值无害。

## Consequences

- 转移表、门顺序、FNV 向量、retry/restore/wedge 语义与事件往返由 57 个 vitest 测试覆盖，per-file 100% 覆盖率，全程无模型。
- `KNOWN_SESSION_EVENT_TYPES` 与持久化目录包含 `workgraph/change`，持久层正确拒绝未知日志并接受我们的。
- issue 02–09 在此核心之上实现引擎；README 限制一节把缺失的 provider、投影键与流不变量记录为它们的入口。
