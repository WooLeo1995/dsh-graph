# Agent Note: 工作图 v7 —— `/graph` 命令面、渲染、经校验的配置

Status: implemented

[English](2026-08-14-workgraph-v7-command-surface.md) | 中文

## Problem

到 issue 06 为止，图只作为引擎 API 存在：没有人类能启动、观察、暂停、补额或清空它，除非写代码。jxca 的 `/graph` 是参考人工面，而 spec 的配置清单（`concurrency`、`nodeRounds`、`replanCap`、`optimizer`、`maxNodes`、`historyMax`、`planBytesMax`、per-child await budget）没有经校验的归宿。命令必须无模型回合分派，绝不让 `resume`/`retry` 拼错落入 `set`，并在暂停时等待子代理静止。

## Decision

**`dsh-command-workgraph` 是 `ctx.workGraph` 之上的纯适配器。** 语法忠实移植自 jxca：控制词仅在占据完整输入时大小写不敏感；任何以 `resume` 或 `retry` 开头的输入都解析为该命令且**绝不**落入 set（拼错的补额不得悄悄替换可恢复的 budget-limited 图）；只有末尾、独立、值为全数字正 token 的 `--budget` 才会被消费——其余留在目标中。`status` 渲染 jxca ASCII 字形树（`[x] [>] [ ] [.] [!] [-]`、等待、轮次、消耗、预算行、发现、暂停原因）；`show` 移植 box-drawing DAG 渲染器——最长路径分层、跨层边的哑链、单遍重心排序、带合并字形画布（空白永不覆盖墨迹）的车道打包连接总线、unicode 字形（`✓ ▶ ○ · ✗ ⊘`）与图例、120 列宽度预算——当排布放不下或图无法分层（pending 或循环外来数据拒绝渲染垃圾）时降级为状态树。域拒绝（已设置、不可重试、预算提示、未知节点）变成稳定的直接错误；非域失败重新抛出，由适配器报告。

**暂停达到静止。** 调度器跟踪每次 drive 的结算；`pause()` 中止回合，以 `childAwaitBudget` 为界等待进行中 drive 的结算，并返回最新已提交视图——drive 的进行中降级在命令返回前落地（资源停止，绝非判定）。等待期间落下的 clear 回退到已提交快照。

**裸 retry 是联合批次。** `retryAllNodes`（tracker）把每个失败节点及其传递阻塞链作为**一个**批次重置——被兄弟失败阻塞的共享终节点会拒绝任何单根重置（`WORKGRAPH_RETRY_UPSTREAM_NOT_ACHIEVED`），因此 `/graph retry` 必须携带整个集合；引擎暴露 `retryAll`。逐节点 retry 保持既有语义。

**配置在加载时校验。** `config.ts` 以默认值解析 spec 可调项并在越界时响亮失败；provider 的 `static Config`（schemastery）在 cordis 加载时执行文档化钳制：concurrency（3，1–8）、nodeRounds（3，1–8）、replanCap（3，0–10）、optimizer（开——随 issue 09 在规划边界消费）、maxNodes（24）、historyMax（64）、planBytesMax（256 KiB——规划门现在把过大 artifact 作为首项检查拒绝）、childAwaitBudget（600 秒，1–3600）。`WorkGraphLimits` 增加可选 `planBytesMax`。

## Alternatives considered

**第二个"分离启动"引擎入口。** 本 issue 否决：确定性 set-驱动到结算的契约由执行套件钉死；命令文档化阻塞行为，且父会话仍不花模型回合。分离启动留待后续。

**静默钳制而非响亮失败。** 否决：spec 与验收要求越界值在加载时失败——部署拼错必须浮现，而非被吸收。

**裸 retry 作为逐节点重试循环。** 否决：被兄弟失败阻塞的共享终节点拒绝任何单根重置，循环永远无法清图；联合批次是唯一正确语义。

## Consequences

- `/graph` 以完整 jxca 语法无模型回合分派；`status`/`show` 诚实渲染并优雅降级；`resume`/`retry` 前缀永不替换图。
- 暂停仅在界内子结算后返回；预算补额提示引导 `budget_limited` 图。
- 裸 retry 一次清掉每个失败链；`retryAllNodes` 加入 tracker 词汇。
- 经校验的 `Config` schema 让部署调参免写代码；规划门执行字节预算。
- 255 个 workgraph 测试全绿（新增 18 个命令测试加 config/gate/tracker 增量），逐文件 100% 覆盖；主机 typecheck 与 staged lint 干净。
- issue 08 在 Web 客户端从同一会话事件渲染活 DAG；issue 09 在规划边界消费 `optimizer` 开关。
