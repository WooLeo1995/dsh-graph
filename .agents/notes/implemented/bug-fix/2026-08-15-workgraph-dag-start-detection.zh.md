# Agent Note:workgraph DAG 从不渲染 —— set 提交 start 检测失配

Status: implemented

[English](2026-08-15-workgraph-dag-start-detection.md) | 中文

## 问题

workgraph 在后台运行(dispatchSet 把规划+驱动链分离),但 Web 客户端的活 DAG 视图从未物化——实时和刷新后都不出现。从捕获的会话日志验证:三次历史图运行都提交了 `workgraph/change` 事件,但 GUI 什么都没显示。

根因:客户端 start 检测处的载荷形状失配。调度器的 `dispatchSet` 经 `createPendingGraph` 提交 pending 图,其 history 是 `['created', 'planning-started']`——规划在首个 checkpoint 之前就开始。客户端的 `isGraphStartChange` 要求 history 恰好为 `['created']`(假设阻塞 set 路径产生的形状)。因此首个事件以 role='update' 匹配,而会话折叠引擎(`ConversationNodeAssembler.acceptMatch`)会丢弃任何 start 之前的 update——聊天节点永不物化,DAG 永不渲染。失败是静默的:无错误、无节点。

实时传输链路本身是健康的:`dsh-host-apiproxy` 把每个已提交的会话事件以 `session/event` mux 帧推给连接的 Web 客户端(`cache-control: no-cache`),所以一旦节点物化,更新就会实时流入。

## 决议

- **`isGraphStartChange` 以创建事实锚定,历史形状回退**:当且仅当快照的 `createdAt === updatedAt` 时,该变更才是唯一 start——创建事实只对 set 提交成立,因为之后每个转换都 bump `updatedAt`(已核:`tracker.ts` 全部 16 处转换点),且与 history cap 无关。缺时间戳的载荷(旧日志、外来数据)回退到恰好 `['created']` 或恰好 `['created','planning-started']` 的历史形状。历史形状臂构造上安全:`created` 每图只追加一次,之后每个变更至少再追加一种 kind,history cap 只从头部驱逐——所以后续事件永远不可能恰好携带这两个数组,折叠引擎的"多于一个 start"拒绝永远不会触发。
- **宿主契约不变**:无 scheduler 改动。曾考虑把 `planning-started` 拆成独立 checkpoint(让首提交只携带 `['created']`),被否决:那会让所有既有图(其首事件已携带两条)永久不可见,而且毫无收益——客户端规则现已覆盖两种形状加 cap 截断形状。
- 创建事实臂还覆盖 `historyMax = 1` 配置(`config.ts` 的合法下限):此时首事件 history 在持久化前被截成恰好 `['planning-started']`,任何历史形状规则都无法识别——时间戳判别可以。
- 回归测试用真实 scheduler 形状端到端钉死契约:`[created, planning-started] → +planning-completed → +node-started` 的折叠在首个事件即物化节点并实时更新;`completeEvents` fixture 重塑为真实提交序列;cap 截断的首事件(`['planning-started']` + 创建事实)断言为 start。

## 已知边界(记录在案,非缺陷)

`dispatchRetryAll` 在无失败节点时返回原 snapshot 不变;若未来有调用方绕过 command 层的零失败守卫,可能提交一个非首变更而其快照仍携带 `createdAt === updatedAt`,重新触发 start 匹配(引擎会响亮抛错——不是静默缺席)。当前产品流不可达;若该入口未来暴露,建议无操作分支同样 bump `updatedAt` 或用创建事实做幂等。

## 验证

21/21 客户端测试全绿;`workgraph-definition.ts` 语句/分支/函数/行覆盖 100%;`tsc -b` 干净;客户端 bundle 重建并确认包含新分支。复现到修复回路:回归测试(真实 dispatch 事件形状)在修复前失败(`expected undefined to be 'active'`),修复后通过。

## 备选方案

**在宿主拆分首个 checkpoint**(先提交 `['created']`,再单独提交 `planning-started` checkpoint)。否决:既有图会保持不可见(其首事件已携带两条),且客户端的严格规则对未来的 scheduler 变更依然脆弱。

**`includes('created')` start 规则**。否决:history cap 驱逐 `created` 之前的每个事件都会匹配为 start,触发折叠引擎的恰好一次 start 拒绝。
