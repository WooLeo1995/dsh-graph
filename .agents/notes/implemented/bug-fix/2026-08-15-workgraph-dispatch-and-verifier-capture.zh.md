# Agent Note: /graph 立即派发；verifier 判定走结构化捕获

Status: implemented

[English](2026-08-15-workgraph-dispatch-and-verifier-capture.md) | 中文

## Problem

两个缺陷让试用 web 实例上的 `/graph` 命令看起来卡死：

1. **命令会为图的整个生命周期阻塞。** `set`/`resume`/`retry` 返回
   `trackEpisode(this.drive(...))`——drive 串行运行每个节点的
   worker/verifier/轮次（数分钟到数小时），命令通道在结算前没有任何输出。
   观测到的运行（`/graph 检查一下这个插件`）中，命令约 11 秒后以
   `This operation was aborted` 中止，但被遗弃的 `set()` 链仍在继续：
   计划被装入、drive 派发 worker，图在后台不可见地运行——active、锁被持有、
   用户看不到任何驱动者。再次 `/graph set` 报 "already set"。
2. **verifier 提示词教的是 worker 的 `REPORT:` 文本信封，但判定是通过
   structured-output 工具捕获的。** verifier spawn 携带
   `VERIFIER_OUTPUT_SCHEMA`；遵循提示词的模型会把 `REPORT: {...}` 写成纯
   文本而从不调用捕获工具，spawn 结果永远无法结算。观测到：第一个 verifier
   子代理以 `REPORT: {"verdict":"achieved",...}` 结束，drive 永久卡在挂起
   的 result 上——图停留在 `running`，再无任何 checkpoint。

## Decision

- **派发，不阻塞。** 引擎新增 `dispatchSet`/`dispatchResume`/
  `dispatchRetry`/`dispatchRetryAll`：校验、提交持久转换，然后把
  planning+drive 链交给调度器**后台**运行（`runEpisode`：pending 图重新
  规划、计划边界 optimizer、drive 至结算）。阻塞形式（`set`/`resume`/
  `retry`/`retryAll`）保留为 `dispatch*` + `settled()`，供程序化调用与测试
  使用。命令面改用派发形式并立即渲染持久快照（pending 图附带进度提示）。
  失败遏制：episode 失败把图暂停为 `infra_paused` 并携带原因（绝不出现
  "active 却无人驱动"），对阻塞调用方再抛出；规划期间到来的 pause/clear
  会放弃计划安装，被 clear 的图不会借迟到的 planner 结果复活。
- **节点的 `running` 转换在 worker spawn 时提交。** 轮次 seam 新增
  `onSpawned`，在子代理发布后、epoch 等待前调用；status 与 DAG 在 worker
  真正干活时即显示 `running`（旧的轮后提交会隐藏长达数分钟的 worker 运行）。
- **verifier 提示词改为结构化结果契约**（恰好一个形状为
  `{"verdict","gaps","discovered"}` 的结构化结果），与 planner 一致；worker
  保留 `REPORT:` 信封，因为 continuation 轮次无法携带结构化捕获。

## Alternatives considered

**保留阻塞契约，仅在命令被中止时暂停图。** 否决：命令仍会为整张图的运行
阻塞会话通道——卡住本身就是缺陷。

**让 verifier 同时接受两种捕获路径（信封与结构化）。** 否决：一个判定两种
捕获路径会引入欺骗混淆，并保留产生楔死的矛盾；对一次性 spawn，结构化工具
是唯一权威通道。
