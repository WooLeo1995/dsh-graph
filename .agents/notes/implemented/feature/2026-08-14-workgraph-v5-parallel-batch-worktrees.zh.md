# Agent Note: 工作图 v5 —— 并行批次、worktree 隔离、seam workspace 覆盖

Status: implemented

[English](2026-08-14-workgraph-v5-parallel-batch-worktrees.md) | 中文

## Problem

issue 04 在主工作区串行结算节点。并行需要真正的隔离：独立节点必须并发运行而不破坏主树，各自在 worktree 中验证、只有通过后才合并回来——而一次坏合并必须只失败它自己的节点。

## Decision

**subagent seam 获得唯一的 workspace 扩展。** `SubagentStartRequest.workspace`（绝对会话 `cwd` 覆盖）经可选的 `SubagentCapabilities.workspace` 标志 capability 门控：在不声明该标志的 provider 上请求它会以 `UNSUPPORTED_CAPABILITY` 拒绝——与其他能力相同的"响亮失败、绝不静默忽略"纪律。进程内 driver 通过覆盖子会话创建 meta 中的 `cwd` 来兑现它；continuation 管理器持久化 durable header，因此续跑的 worker 轮次自动保留 worktree。spawn provider 宣告该能力；调度器探测它（`workspaceCapableFor`），缺失时降级串行。

**`worktrees.ts` 持有隔离机制。** 在 fan-out HEAD 处于 harness home（`workgraph/worktrees/<session>/<node>`）铸造分离 worktree；变更集来自 git plumbing——相对 base 的已跟踪 diff 加未跟踪文件；每个变更文件按原始字节 3-way 合并（base = fan-out HEAD blob，ours = 主树工作文件，theirs = worktree 文件；base==ours 取 theirs，ours==theirs 已存在，否则冲突）。HEAD 守卫在 fan-out 时捕获主 HEAD，移动即响亮失败该节点。已合并 worktree best-effort 移除；失败节点保留其 worktree 供事后分析。

**`parallel.ts` 在符合条件处驱动批次。** 当至少两个节点 Ready、并发上限超过 1、组合具备 workspace 能力、目录是 git 仓库（探测一次降级为串行，与 jxca 的非 git 钳制一致）时，取一批（至多上限）：所有 worktree 在同一个 fan-out 基线上铸造，每个节点的 worker/verifier 轮次在各自 worktree 中运行（workspace 覆盖到达 worker 轮次与验证器；round 2+ 在 worktree 中续跑同一子代理），然后按批次顺序串行合并回主树。合并失败通过新增的 `settleMergeFailed` tracker 转换撤销达成——节点以精确原因失败、其未达成依赖者阻塞、楔死阻塞整图，因此一次坏合并绝不会杀死整图。`settleAchieved` 现在会在迟到达成搁浅整图时重查楔死（兄弟仍可运行时失败，待兄弟结算即楔死）。

## Alternatives considered

**不隔离（共享树）。** 设计会话中否决：并行节点在同一棵树上必然互相踩踏；worktree 是"不通过就不合并"承诺的物理前提。

**以沙箱模式隔离代替 worktree。** 否决：沙箱限制但不隔离状态——合并回语义（HEAD 守卫、3-way 字节合并、失败保留 worktree 供事后分析）需要真实 checkout。

**让合并冲突阻塞整图。** 否决：验收与 jxca 都只失败冲突节点——兄弟继续，依赖者经 tracker 的普通失败语义阻塞。

## Consequences

- 并行批次在隔离 worktree 中运行独立节点；干净批次经串行 3-way 合并落地文件并移除 worktree；冲突或 HEAD 移动只失败该节点，其 worktree 保留供事后分析。
- workspace 覆盖是恰当的、capability 门控的 seam 扩展，subagent 套件中有真实栈子会话 `cwd` 断言；非 git 仓库与无能力 provider 降级串行。
- 202 个 vitest 测试全绿（新增 51 个），scheduler 源码逐文件 100% 覆盖；lint 与主机 typecheck 干净。
- issue 06 接入发现与重规划；issue 07 落地命令面与经校验的 `concurrency` 配置。
