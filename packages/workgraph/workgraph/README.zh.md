# `@deepseek-ai/dsh-workgraph`

[English](README.md) | 中文

工作图（work graph）的 Service Definition：agent 工作之上持久 DAG 词汇、`workgraph/change` 会话事件、该事件的严格解码/回放 fold，以及由调度器 provider 实现的抽象 `ctx.workGraph` 引擎接缝。[工作图 spec](../../../.scratch/workgraph/spec.md) 的 issue 01 交付本包与 `dsh-workgraph-scheduler` 的 tracker 核心；回合化执行（规划器、worker、verifier）随后续 issue 落地。

## 词汇

`WorkGraphSnapshot` 是完整的持久编排状态；每次变更整体携带（whole-value 规则），因此回放 fold 在严格解码后按最后写入生效。节点持有规范化 `gn-` id、`blocks` 边、六态生命周期（`waiting`、`ready`、`running`、`achieved`、`failed`、`blocked`；`verifying` 仅用于显示、永不持久化）、已结算轮数，以及可选的失败原因、worker 会话与发现来源字段。图状态为 `active`、`user_paused`、`infra_paused`、`blocked`、`budget_limited`、`complete`；带 `unknown` 汇的封顶历史记录每次转移。

## 会话事件

`workgraph/change` 携带整体快照或清除墓碑。解码器是严格的：其他值种类解码为 `undefined`；畸形或版本不支持的变更使回放大声失败；未知持久节点状态恢复为 `ready`（恢复的工作可重跑，绝不静默完成或卡死）；未知历史种类解码为 `unknown` 并在条目 detail 中保留原始种类；blocks 与来源边必须在节点集内可解析。`foldWorkGraph(events)` 重建当前图，并校验跨变更的身份与单调连续性。

## 引擎接缝

`ctx.workGraph` 每 context 一个抽象引擎。`set` 规划并启动图，`status` 读取，`pause` 以有界子代理沉降取消当前回合，`resume` 继续（可选地从已花费量加补 token 预算），`retry` 复位一个终态节点及其传递性受阻断的链（上游依赖既未达成也不在同一批次时拒绝），`clear` 移除图及其投影。`dsh-workgraph-scheduler` 是 provider；其 tracker 核心现在交付，回合执行随执行类 issue 到来。

## 事件

`workgraph/changed`（emit，agent 作用域）在对应会话事件提交后触发，携带新快照或清除墓碑。监听器失败被容纳；载荷永不暴露图控制。

## 扩展点

实现 `WorkGraphEngine` 提供调度器；监听 `workgraph/changed` 做 UI 投影；从会话日志 fold `workgraph/change` 重建持久状态。

## Model Experience

无。Service Definition 不贡献任何提示词、工具或模型可见输入；worker 与 verifier 提示词由调度器 provider 及其消费者持有。

#### KV Cache effect

无直接影响。图状态仅通过调度器的 worker 与 verifier 提示词到达模型，该前缀变化由该 provider 持有。

## Known Limitations and Deferred Work

- **provider 进行中** —— `dsh-workgraph-scheduler` 已交付 `set`（规划执行幕、冻结基线）与 tracker 级 `status`/`pause`/`resume`/`retry`/`clear`；串行与并行节点执行幕随 issue 03–05 落地。
- **无投影键** —— 工作图的 `SessionProjectionMap` 条目推迟到 GUI issue，那是它的第一个消费者。
- **无流不变量** —— goal 风格的已提交流不变量包推迟到回合开始在测试之外写入变更之时。
