# Agent Note: 工作图 v4 —— 对抗验证器与有界 worker 轮次

Status: implemented

[English](2026-08-14-workgraph-v4-adversarial-verifier-rounds.md) | 中文

## Problem

issue 03 直接从 `done` 报告结算节点——没有人审计工作。对抗验证器必须门控达成（不可验证的声称按构造即 gap），拒绝必须以保留上下文与工作区的**同一** worker 子代理迭代，并受轮次上限约束——而不是忘掉一切的全新 spawn。

## Decision

**验证器是一次性对抗怀疑者。** `verifier.ts` 交付 `VERIFIER_OUTPUT_SCHEMA` 捕获 schema、移植自 jxca 的验证器契约（自行重跑决定性检查；不可验证的声称是 gap；缺失证据是 gap；按契约只读），以节点契约与 worker summary 作为被审计的数据渲染，并给出严格结果三分：`achieved`、`rejected`（要求具体 gaps——无 gaps 的拒绝本身无效）、`fail-closed`（缺失判定、未知判定或出错子代理——未验证的声称永不通过）。验证器 spawn 携带 `VERIFIER_TOOL_FILTER` deny-list——`write`/`edit`、委派（`subagent`/`workflow`/`jobs`/`skill`/`todo`）与代码运行时被直接拒绝；`bash` 保留因为重跑决定性检查（测试、构建）可能写产物，只读契约的其余部分由 prompt 强制。验证器发现的与 worker 的一起入队。

**节点回合是有界轮次循环。** `serial.ts` 运行 worker round 1 → 验证器；拒绝以精确命名的 gaps 迭代**同一**持久子代理（round 2+ prompt 追加 gaps 段），受 `nodeRounds` 上限（默认 3）约束；耗尽时以最后 gaps 令节点失败，`settleFailed` 现在为审计记录已结算轮数（retry 保留轮数）。每个 await 边界都检查 abort 信号并在权威快照上降级进行中节点，因此暂停落在验证器或后续轮次中是资源停止，绝非判定。无 usage 记录预算检查移到结算之前，首个子代理的响亮失败降级的是 running 节点而不是抹掉判定。

**continuation 传输保留子代理。** `continuation.ts` 是默认 worker 轮次 seam：round 1 `startContinuable`，round 2+ 对同一持久子会话 id `followup`，每轮经子代理的 `subagent/end` epoch 边等待（叶子 worker 子代理——委派工具被拒绝——在其轮次完成时结算其 epoch）。continuation 管理器的组合不把结构化捕获带入后续轮次，因此 worker 报告以其最终输出的严格 `REPORT:` JSON 信封传输——最后一行胜出，缺失或畸形即不可解析（fail-closed），且 summary 与结构化捕获一样无法伪装 status 字段。`workerRound`/`verifierSpawn` 配置 seam 无需模型即可编写轮次与判定。

## Alternatives considered

**每轮全新 worker spawn。** 否决：验收与 spec 都要求同一子代理（continuation，而非全新 spawn）——上下文与工作区保留——round N+1 保有 round N 的工作。

**从纯最终文本解析轮次报告。** 否决，改用严格信封：信封是解析器完整校验的单行 JSON，保留防伪属性（summary 无法改变 status）与 fail-closed 纪律。

**给验证器硬只读沙箱。** 否决：`bash` 必须重跑决定性检查，那会写测试产物；硬沙箱会让验证不可能，因此 deny-list 加 prompt 契约是唯一自洽姿态（设计会话中已确认）。

## Consequences

- `done` 报告不再直接结算节点：验证器门控达成，拒绝以命名的 gaps 迭代同一子代理，轮次上限约束循环——节点结算的 `rounds` 反映真实的 worker-verifier 轮数。
- 出错或无 gaps 的验证器永不通过；验证器发现的与 worker 的一起为重规划边界（issue 06）入队。
- 149 个 vitest 测试全绿（新增 49 个），逐文件 100% 覆盖：验证器解析矩阵、信封解析器、传输（跨轮同一子代理、忽略外来 end 事件、aborted epoch 等待、非 completed 轮次）、带 gaps 的轮次迭代、上限耗尽、验证器期间与 round 2 期间的暂停、以及失败时的轮数记录。
- 默认传输的 `REPORT:` 信封是相对结构化捕获理想的文档化偏差，仅限于 continuation 轮次；continuation 管理器捕获 setup 的真实栈集成随 llm-mock-server 工作延后。
