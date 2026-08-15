# CONTEXT — dsh-graph 插件（workgraph / graph engineering Phase 2）

> 领域词汇表（glossary），不含实现细节。术语已在 grilling 会话中确立（2026-08-15，对照 jxca-cli `/graph` 与 DSH spec `.scratch/workgraph/spec.md`）。

## 核心概念

- **Work Graph（工作图 / graph 编排）**：把一个目标变成依赖 DAG 并确定性地执行到底的编排方式。区别于单线程"思考→行动→重复"循环、同会话 goal（延续同一对话）、Ralph（单目标新鲜工人迭代）、workflow（模型写的编排脚本）——work graph 是**确定性调度器 + 对抗验证 + 可恢复持久化**。
- **Graph（图）**：一次 `/graph <objective> [--budget N]` 运行。拥有 graph_id、目标文本、节点集、token 预算、plan 版本、事件历史。一次会话至多一个活跃图。
- **Node（节点）**：图中的一个工作单元。`gn-<fnv1a32(slug)>` 规范 id（跨机器稳定、可行合并）；title、spec（节点级契约）、`blocks` 依赖边、生命周期状态、结算轮数、token 花费、失败原因、worker 会话与发现来源溯源。
- **`gn-final`（最终验证节点）**：由 harness 追加、依赖所有规划节点、固定"整体目标端到端复验"spec 的终端节点；总是最后运行，planner/replanner/optimizer 都不许写它。完成是被认证的，不是被宣告的。
- **Blocks 边**：唯一的调度门控依赖（`Waiting → Ready` 当所有 Blocks 依赖都 `Achieved`）。
- **Episode（执行幕）**：调度器的一次执行单元——结算一个串行节点或一个并行批次；不是常驻守护进程。图的前进由调度器（确定性）驱动，父会话不花任何模型轮次。
- **Worker（工人）**：节点的实现者，spawn 子代理；只做本节点 scope 内的工作；结构化报告 `{ status: done | blocked, summary, discovered }`。验证轮次 ≥2 时经 continuation 管理器**续跑同一子代理**（上下文与 worktree 保留）。
- **Adversarial Verifier（对抗式验证器）**：只读怀疑者，收到节点契约（判定对象）与 worker summary（被审计的数据，非信任对象）；自行重跑决定性检查（不可验证的声称就是 gap）；结构化报告 `{ verdict: achieved | not_achieved, gaps, discovered }`。出错/缺失/无 gap 的拒绝都 fail-closed（永不通过）。
- **Discovered Work（发现的工作）**：worker/verifier/串行节点 final 文本报告的、超出本节点 scope 但必要的后续工作；在幕边界由 replanner 追加为新节点（带 `discovered_from` 溯源），受 replanCap 上限约束。
- **Replan（重规划）**：追加式（append-only）扩展图；追加节点、bump plan 版本、冻结新基线、`gn-final` 在新增之上重新门控（Ready 的 final 降级）。空附录也消耗一个 cap 槽；失败降级（条目进历史），运行中的图永不为增强通过失败而暂停。
- **Topology Optimizer（拓扑优化器）**：仅在计划边界运行（初始规划后 + 重规划边界搭车）；受限操作集 `remove_dep`/`reorder`/`merge`/`split`，只动 pending 节点；`gn-final` 不可参与合并/拆分；空操作集是被尊重的答案；失败降级警告。
- **Budget（预算）**：set/resume 时可选；调度器按子会话 durable usage records 累计（按它启动的 child session id 记账）；dispatch 在零剩余时门控；超支时 in-flight 节点 **demote 回 Ready**（资源停止，不是判定）；spent-so-far 总是入账（含失败节点）；top-up 从 spent 起算。无 usage 记录的组合配置预算在 set 时 fail loud。
- **Plan version / Baseline（计划版本 / 基线）**：版本单调递增；每次 replan/optimizer 通过 bump；每版完整节点集在执行前冻结为**不可覆盖**的基线（create-new 语义）。

## 状态词汇

- **节点状态**：Waiting → Ready → Running → Achieved；Failed（判定不可达成/轮次上限/合并冲突/HEAD 移动）、Blocked（依赖失败，固定点 `block_dependents` 扫描，已 Achieved 的依赖者永不被降级）为终态旁支。Verifying 仅展示、永不持久化；未知持久化状态恢复为 Ready（恢复的工作永远可重跑，绝不"静默完成或卡死"）。
- **图状态**：active / user_paused / infra_paused / blocked / budget_limited / complete。jxca 的 goal-engine 暂停种类（back_off/no_progress）被丢弃——dsh 节点是子代理，不是 goal 引擎占用者。
- **Wedge（楔死）**：无节点可跑且未全部达成 → 图以带 retry 提示的 blocked 暂停。
- **恢复语义**：复活先消毒再降级——Active → user_paused（带重启消息），Running → Ready。恢复的快照永远不会自行驱动。

## 持久化与投影

- **Session 事件是源**：`workgraph/change`（整快照或清除墓碑，严格解码/折叠，last-wins）；`workgraph/changed`（agent 作用域 emit，观察专用，绝不暴露控制面）。每次转变都 checkpoints。
- **项目投影**：仓库根 `.dsh/graph.jsonl`——第 1 行 header（不含节点的编排状态），随后每节点一行，原子写；旁车排他锁在图的整个生命周期持有；第二持有者只读 + 拒绝 resume；畸形文件是响亮错误，绝不是"无图"。scheduler 只往仓库写这一个文件（+锁）；worktree 在 harness home（`workgraph/worktrees/<session>/<node>`）；提交与否永远是用户决定。
- **Write isolation（写隔离）**：调度器只写 `.dsh/graph.jsonl` 及其锁；worktree checkout 位于 harness home；git 自身在 `.git` 下加 worktree 管理条目。

## 执行模型

- **串行与并行**：串行路径（G0）——一次一个 Ready 节点，spawn worker 跑在主树 cwd；并行路径（G1）——Ready 节点 ≥2 且并发配置 >1 时取批次，每节点独立 worker/verifier 对，各自在 per-node git worktree 中（round 1 spawn 带 workspace override，续轮保留）。非 git 仓库或无能力提供方 → 降级串行（与 jxca 的非 git 钳制一致）。
- **验证轮次**：done 报告后 → 对抗验证器（one-shot spawn，worker 的 workspace 上）→ achieved 结算 / not_achieved 带 gaps 续跑同一 worker（gaps 追加进 prompt），受 nodeRounds 上限（默认 3）约束；轮次上限耗尽 → 节点 Failed，指名最后 gaps。
- **合并回主树**：批次顺序**串行**合并；fan-out 时捕获主 HEAD 守卫，移动即响亮失败该节点；变更集来自 git plumbing；每文件按原始字节 3-way（base = fan-out HEAD blob，ours = 主树工作文件，theirs = worktree 文件；base==ours 取 theirs；ours==theirs 已存在；否则冲突）。冲突只失败该节点（兄弟继续，依赖者阻塞）；成功合并 best-effort 移除 worktree；失败节点保留 worktree 供事后分析。
- **数据流诚实**：兄弟节点结果永不进入节点 prompt（隔离是设计）；合并后的工作树 + gn-final 整体复验是仅有的通道。

## 与宿主（DeepSeek Harness）的映射

- **能力族 `workgraph/`**：`dsh-workgraph`（Service Definition：词汇、`ctx.workGraph` 方法 set/status/render/pause/resume/retry/clear、workgraph/* 观察事件）；`dsh-workgraph-scheduler`（Provider：tracker、episodes、passes、worktrees、merge）；`dsh-command-workgraph`（人类命令消费方，注册 `ctx.commands`，**无模型轮次**）；`packages/client/ui-workgraph`（GUI DAG 渲染）。v1 无面向模型的工具。
- **子代理 seam 扩展（唯一扩展）**：`SubagentStartRequest` 增加 capability 门控的 `workspace` override（issue 05 落地）。验证器只读用 **deny-list 工具过滤**（fs 写类 + 编排类；`bash` 保留——验证必须能重跑测试，硬只读会让对抗验证名存实亡，其余靠 prompt 契约兜底）。
- **预算读法**：折叠子会话日志的 durable usage 事件（权威计费），不用 token-meter 启发式。
- **命令语法**：`/graph <objective> [--budget N] | status | show | pause | resume [--budget N] | retry [node] | clear`；resume/retry 前缀永不落入 set。
- **配置**（cordis.yml 校验字段）：concurrency（3，clamp 1–8）、nodeRounds（3，clamp 1–8）、replanCap（3，clamp 0–10）、optimizer（on）、maxNodes（24）、historyMax（64）、planBytesMax（256 KiB）、per-child await 预算（600 s）。

## 未决

- 唯一遗留问题：`examples/web-cordis/cordis.yml` 未提交的 `cordis-host-runner` 删除行——恢复还是保留（phase-1 遗留，作者拍板）。
