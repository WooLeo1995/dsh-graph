# `@deepseek-ai/dsh-workgraph-scheduler`

[English](README.md) | 中文

工作图调度器的确定性 tracker 核心：规范化节点身份、计划静态门、以及纯快照状态机。每个函数都是对不可变 `WorkGraphSnapshot` 的纯函数，非法转移抛出 `WORKGRAPH_INVALID_TRANSITION`，并显式接收转移时间戳——tracker 永不读时钟。通过 subagent 接缝驱动回合的 Cordis provider 随执行类 issue 落地（见[工作图 spec](../../../.scratch/workgraph/spec.md)）；本包先交付确定性的一半，使转移表无需模型即可穷举测试。

## 规范化 id

`canonicalNodeId(slug)` 铸造 `gn-` 加 slug 的 FNV-1a 32 位哈希的八位小写十六进制——跨进程稳定，因此投影可按行合并。`FINAL_NODE_ID`（`gn-final`）是 harness 追加的最终节点的固定非哈希身份。

## 计划门

`parsePlanArtifact` 按固定顺序校验原始规划器产物（模型 JSON 边界），每次拒绝都点名确切原因：产物形状；节点表非空；逐行形状与依赖去重；节点上限；slug 卫生（`[A-Za-z0-9_-]` 的 1–64 位）；slug 唯一；trim 后标题与 spec 非空；无自依赖与未知依赖；规划器顺序稳定的 Kahn 无环性（存储序中第一个 `ready` 继承规划器意图，环会搁浅其成员）；以及不同 slug 之间的规范化 id 碰撞。`installPlan` 规范化 id、改写 `blocks` 边、按拓扑序保持全部节点 `waiting`、拒绝规范化到保留最终 id 的 slug，并以固定的整体目标验证 spec 追加门控于全部规划节点的最终节点。

## 状态机

`createPendingGraph` 提交持久的规划窗口快照（零节点，历史带 `created` + `planning-started`），规划中途崩溃留下的是可恢复的图。`installPlanIntoGraph` 安装已校验节点集（根提升、计划版本保持 1）并记录 `planning-completed`。`initializeGraph` 创建带已提升根的 active 快照。`markRunning` 启动 ready 节点（记录 worker 子会话）。`settleAchieved` 结算 running 节点、提升依赖方，并在含最终节点的全部节点达成时完成图。`settleFailed` 令 running 节点失败、把每个未达成的传递依赖方标记为 blocked 并把链条归因于原始失败、并在无可运行节点时卡死图（状态 `blocked`、重试提示）。`pauseGraph` 把 active 图以用户或 infra 原因暂停；`pausePlanningFailed` 记录 `planning-failed` 历史条目；`resumeGraph` 重新激活已暂停或 blocked 的图并丢弃暂停原因。`retryNodes` 复位一个终态节点及其传递性受阻断的链——轮数保留以供审计、失败与 worker 会话清除——在上游依赖既未达成也不在批次内时拒绝，并解除 blocked 图。`restoreSnapshot` 把 running 节点降为 ready、把 active 图降为用户暂停（`RESTORE_PAUSE_REASON`），恢复的快照绝不自我驱动地复活。`appendHistory` 优先丢弃最旧条目来封顶历史。

## 规划执行幕

`renderPlannerPrompt`/`runPlannerEpisode` 运行规划尝试（渲染 → spawn → `parsePlanArtifact`），带注入的 `PlannerSpawn` seam 与 `PLAN_OUTPUT_SCHEMA` 捕获 schema：`planned`（门禁通过）、`invalid`（精确门禁原因，可重试一次）、`fail-closed`（子代理错误或产物缺失——infra）。`createBaselineStore` 以 create-new 语义把每版完整节点集冻结在 harness home 下（重复冻结报 `WORKGRAPH_BASELINE_EXISTS`）。

## worker 轮次与对抗验证

`worker.ts` 渲染 worker 契约（位置、spec、图目标、仅本节点 scope、发现的工作、先前 gaps），并解析结构化报告（`{ status: done | blocked, summary, discovered }`）：缺失或畸形报告不可解析并 fail-closed 令节点失败，出错的子代理 fail-closed，且 summary 是 schema 数据、无法伪装 status。`done` 报告之后，`verifier.ts` 运行对抗怀疑者（只读 deny-list 工具过滤，保留 `bash` 以便重跑决定性检查）：`achieved` 结算节点；`not_achieved` 以精确命名的 gaps 迭代**同一** worker 子代理（`continuation.ts` 传输——round 1 `startContinuable`，round 2+ 对同一持久子代理 `followup`，每轮经其 `subagent/end` epoch 边等待，报告以严格 `REPORT:` JSON 信封形式传输），受 `nodeRounds` 上限约束——耗尽时以最后 gaps 令节点失败；出错或无 gaps 的拒绝永不通过。`serial.ts` 确定性驱动图——按存储序逐 Ready 节点——预算门控分派，中断的回合（pause/clear）经权威快照把进行中节点降级。
## 预算

`usage.ts` 按调度器启动的子会话 id 折叠子会话的持久 `assistant/message` usage 记录。`set` 仅在具备 usage 记录证据时接受 token 预算（父日志，或首个子会话的记录——否则 infra 暂停，响亮失败）。越界结算触发 `budget_limited`，把其他 running 节点降级为 Ready（资源停止，绝非判定）；spent-so-far 总是入账，含失败节点；`resumeGraph` 从 spent-so-far 起加补，`budget_limited` 上的普通 resume 以提示拒绝。

## Provider

`WorkGraphScheduler` 实现完整 `ctx.workGraph` 引擎表面：`set` 规划、安装、冻结基线 v1 并驱动执行幕（一次反馈重试、规划失败 infra 暂停）；`status` 读取最新已提交快照并以会话日志折叠作为重载路径；`pause`/`resume`/`retry`/`clear` 在 tracker 层运作且 resume/retry 会驱动；`resume` 对 pending 图重规划。并行批次与 worktree 隔离随 issue 05 落地；发现重规划回合随 issue 06 落地。

## 并行批次与 worktree 隔离

当 Ready 节点多于一个且并发上限超过 1 时，`parallel.ts` 取一批，让每个节点作为独立的 worker/verifier 对在各自的 git worktree 中运行（`worktrees.ts`：在 fan-out HEAD 的分离 checkout、来自 git plumbing 的变更集（含未跟踪文件）、每文件 3-way 字节合并——base==ours 取 theirs，ours==theirs 已存在，否则该节点以点名文件失败——以及 HEAD 守卫：主 HEAD 移动即响亮失败该节点）。合并回主树按批次顺序串行；冲突只失败该节点（兄弟继续、依赖者阻塞、楔死阻塞整图），已合并 worktree best-effort 移除，失败节点保留其 worktree 供事后分析。workspace 覆盖在 subagent seam 中 capability 门控（`SubagentStartRequest.workspace` + `SubagentCapabilities.workspace`）：无能力提供方或非 git 仓库降级串行，与 jxca 的非 git 钳制一致。可运行集在每个边界钩子之后按权威快照重读，被重门控的 Ready 终节点绝不会以过期状态被分派。

## 发现与重规划

`replan.ts` 拥有这一回合：在回合边界，`maybeReplan`（scheduler）把挂起的 `discovered` 条目（来自 worker 与 verifier 报告）经 replanner 子代理（与规划同一 spawn seam）折叠进图，含一次反馈重试。前置门：无条目 → 无操作；剩余预算为零 → 条目保持排队（`resume --budget` 补额后重新进入）；`gn-final` 已达成 → 追加式排空到历史（advisory）；`replanCap` 为 0 或耗尽 → 安静排空，图按当前计划收敛。`validateAppendix` 按固定顺序执行附录行规则（形状、slug 卫生、唯一性、非空正文、字符串 deps、无自依赖；deps 可引用现存活节点，由 `replanDependencyGuard` 解析——永指保留终节点，永指非活节点）；`installReplan` 按规划者顺序追加，把 `gn-final` 重新门控到新增之上（Ready 终节点降级为 waiting；空附录若使每个依赖均达成则重新提升，终节点校验永不搁浅），计划版本自增、条目清空、冻结新基线（v1 不可变）。空附录是被尊重的答案且消耗一个槽位；无效结果以精确原因重试一次，随后降级——条目排空、槽位消耗、图继续运行，绝不暂停。

## 配置

provider 声明经校验的 cordis `Config` schema（`config.ts`）：部署从 cordis.yml 调图，而非改代码。每个字段解析到 spec 默认值，越界值在插件加载时响亮失败。concurrency（默认 3，钳 1–8）、nodeRounds（3，1–8）、replanCap（3，0–10）、optimizer（开——随 issue 09 在规划边界消费）、maxNodes（24）、historyMax（64）、planBytesMax（256 KiB——规划门拒绝更大的 artifact）、childAwaitBudget（600 秒，钳 1–3600——`pause` 返回前尊重的有界子结算等待）。直接构造解析相同默认值并在越界时响亮失败；显式 `limits` seam 仍覆盖可调默认值。

## 拓扑优化器

`optimizer.ts` 运行规划边界审查回合——初始规划之后，并搭车每个重规划边界，绝不在执行中途：`maybeOptimize` 以 `optimizer` 开关、活图与共享重规划上限的空闲槽位为门。优化器子代理（与规划同 spawn seam，自有 `OPTIMIZER_OUTPUT_SCHEMA`）发布受限操作——`remove_dep`、`reorder`、`merge`、`split`——仅作用于 Waiting/Ready 节点；`applyOptimization` 执行逐操作规则（仅 pending 目标、已知 id、无自/重、`gn-final` 永不合并/拆分/作合并方、无非 pending 依赖者、split 2–3 个替换且 slug 卫生、deps 存活）与最终不变量：终节点门在全部幸存非终节点之上重建，pending 状态双向再推导（嫁接的依赖把 Ready 节点降级）、非 pending 节点字节级不变、可环性与节点上限复核。应用的回合自增计划版本、消耗共享槽位、记录 `optimized` 并冻结新基线；空操作列表是被尊重的 no-op；任何失败都带警告降级——增强回合绝不暂停运行中的图。

## 跨会话项目复活

`project.ts` 把编排投影到仓库根 `.dsh/graph.jsonl`（第 1 行头部去掉节点，随后每行一个节点，原子写入，经内容哈希 id 行可合并）。`set` 在任何提交**之前**认领仓库锁（create-exclusive sidecar）——被拒绝的第二持有者不留痕迹；持有锁期间每个检查点提交都重投影（写失败带警告降级——会话日志才是真源）；`resume` 在另一会话持锁时拒绝（拒绝先于 `requireGraph`）；新会话的 `status` 复活投影并净化降级（Running→Ready，Active→user_paused 带重启消息）；`clear` 删除文件并释放锁；畸形文件是响亮错误，绝非"无图"。

## Model Experience

间接地，经由规划子代理的结构化输出 spawn：provider 渲染规划子代理收到的规划契约（`prompts.ts`），并通过 `PLAN_OUTPUT_SCHEMA` seam 捕获其计划。

#### KV Cache effect

无直接影响。触及图状态的模型请求先经过调度器 provider，任何由此产生的前缀变化由其持有。


## Known Limitations and Deferred Work

- **信封传输** —— continuation 管理器的组合不把结构化捕获带入后续轮次，worker 报告以其最终输出的严格 `REPORT:` JSON 信封传输；捕获 setup 的真实栈集成随 llm-mock-server 工作延后。
- **Verifying 仅显示** —— 直亮的 verifier 进行中徽章留在持久词汇之外，直到执行类 issue 定义其渲染。
