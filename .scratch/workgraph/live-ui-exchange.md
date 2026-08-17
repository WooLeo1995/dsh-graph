# AgentTeams 交换逻辑研究笔记 —— workgraph 实时 UI 设计参考

> 编号参考:`issues/08-gui-dag-view.md`(DAG 视图现状)、`issues/09-optimizer-project-revive.md`。
> 本文是任务 t2(researcher)的产出:研究 DSH harness 中 AgentTeams(`agent_teams_*`,插件 `@nanmicoder/dsh-agent-teams` v0.1.2)的实时交换机制与 GUI 表现,给出 workgraph 实时 DAG 界面可借鉴的交换语义。只读研究,未修改任何 @deepseek-ai 源码。
> 第二遍深化(队长补充指路后):新增 §1.7 定点答疑(STATE_URL 注册/载荷/轮询/无推送、卡片折叠 vs 面板轮询分工),§3.5 补充 graphId 唯一性与"首事件即 start"简化、revive 路径发现,§4.1 更新 d/f 建议。

---

## 0. 一句话结论

AgentTeams 采用**"磁盘即真相 + 服务端快照端点 + 客户端轮询"**的实时模型:所有状态变更落盘(`team.json` + JSONL 邮箱,进程内互斥串行 + 原子写),GUI 每秒轮询一次 host 快照端点拿"磁盘状态 ⊕ 实时子代理活动"的合并快照;会话事件流(`agent-teams/*`)只是**尽力而为**的通知(类型不在 harness KNOWN 集会被跳过),从不作为 UI 唯一数据源。
workgraph 相反,采用**"会话事件即真相 + 全量快照事件 + 推送折叠"**模型:`workgraph/change` 全量快照事件经 `session/event` 帧实时推到浏览器,客户端 fold 引擎重放/追加折叠。推送路径断裂(本次 start 检测 bug)时 UI 会**静默失明**——这是本次 bug 的根因,也是与 AgentTeams 最值得对照的一点。

---

## 1. AgentTeams 交换机制摘要(带证据)

### 1.1 位置与形态

- 实现不在 @deepseek-ai 命名空间,而是 npm 第三方插件 **`@nanmicoder/dsh-agent-teams` v0.1.2**(作者 程序员阿江,语义移植自 Claude Code AgentTeams),以 web profile bundle 安装:
  - 包根:`~/.dsh/profiles/web/node_modules/@nanmicoder/dsh-agent-teams/`
  - 挂载行:`cordis.patch.yml:10-21`(`- insert: agent-teams`,`config.stateDir: .agent-teams`,`memberProvider: spawn`)
  - host 半:`lib/index.js`(apply + web 路由)、`lib/tools.js`(9 个 `agent_teams_*` 工具)、`lib/state.js`(落盘状态机)、`lib/events.js`(会话事件发射)、`lib/members.js`(成员子代理生命周期)、`lib/snapshot.js`(面板快照装配)
  - client 半:`lib/client.js`(打包后的 ActivityPanel/AgentTeamsCard/DependencyMap/definition)+ `lib/client/agent-teams-card-definition.js`(conversation node 折叠定义)
- 团队状态落盘:`<workspace>/.agent-teams/<teamId>/team.json` + `inbox/<agentKey>.jsonl`(本团队即 `/Users/wutianyu/Downloads/company/ca/gitlab/dsh-graph/.agent-teams/workgraph-live-ui/`)。

### 1.2 状态模型与并发

- `team.json` 一条 JSON 记录持有全部:`captainSessionId / members[](id,name,role,status)/ tasks[](id,subject,status,assignee,dependencies,output)/ taskSeq`(`lib/state.js:119-152`)。
- **进程内 per-team 互斥队列**:`withTeamLock(key, fn)` 用 promise 链串行化同一 team 的 read-modify-write(`lib/state.js:20-40`);锁键 `team:<stateRoot>:<teamId>` 与 `captain:<stateRoot>:<captainId>`(一个队长一个队,`lib/tools.js:33-39`)。跨进程不加锁(文档明说 in-process)。
- **原子写**:临时文件 + rename(`lib/state.js:291-301`);mailbox append 是"读整文件 + 整体原子重写"(`lib/state.js:230-244`),小文件无无限流问题。
- **任务状态机**:`TASK_TRANSITIONS` 白名单 `pending → claimed → in_progress → completed|failed|cancelled`(`lib/state.js:92-113`),非法转移抛错;依赖未完成的任务不可 claim(`unsatisfiedDependencies`,`lib/state.js:84-87`)。

### 1.3 实时反映到界面:磁盘真相 + 轮询快照,而非事件流

- host 注册两个 web 路由(`lib/index.js:98-163`):
  - `GET /plugins/dsh-agent-teams/state` —— **面板数据源**:每次请求时 `collectTeamsActivity` 遍历每个 workspace 的 `.agent-teams/*/team.json` 重新装配快照(`lib/snapshot.js:102-130`),并**实时合并子代理活动**(`ctx.subagents.listChildren(captainSessionId)`,`lib/snapshot.js:33-43`、`lib/members.js:160-168`:running→working / inactive→idle)。响应头 `cache-control: no-store`(禁止缓存,每次全新)。
  - `?archived=1` 变体服务归档团队(删除=移动到 `archive/`,`lib/state.js:411-415`)。
  - `GET /plugins/dsh-agent-teams/assets/*` —— 鲸鱼头像/动作图(allowlist)。
- client 端 **纯轮询**:
  - 右上浮动面板 `ActivityPanel`:`POLL_MS = 1000`(`lib/client.js:374`),`fetch(STATE_URL, {cache:'no-store'})` 同时拉 live + archived(`lib/client.js:892-920`),`inFlight` 守卫防止请求堆叠;折叠 badge 在活动出现 4s 后自动展开、无团队 2s 后自动收起(`:376/:382`);**按当前会话过滤**(`visibleTeams = teams.filter(t => t.captainSessionId === current)`,`:946-957`)。
  - 会话内卡片 `AgentTeamsCard`:1.5s 轮询同一端点(`:170-189`),从快照里按 `teamId + captainSessionId` 匹配自己。
- 会话事件流(`agent-teams/*`)**不是**数据源:每次变更都会 `appendTeamEvent`(`lib/events.js:26-47`),但类型不在 `dshSession.KNOWN_SESSION_EVENT_TYPES` 时**直接跳过**(仅 debug 日志),磁盘仍是唯一权威。设计意图明确:"Disk state remains the authoritative source for the activity panel."

### 1.4 任务 DAG 与依赖呈现

- 服务端预计算两个投影,随快照下发(`lib/snapshot.js:79-87`):
  - `state`:`taskVisualState(status, deps, tasks)` → `completed / running(in_progress) / blocked(有未完成依赖) / open`(`lib/state.js:446-457`);
  - `depth`:`taskDepthsById` → 最长依赖链深度 = 列号(`lib/state.js:461-488`,记忆化 DFS,循环安全)。
- 客户端 `DependencyMap`(`lib/client.js:538-599`):
  - `taskStages(tasks)` 按 depth 分组排序 → **分层列**(起点 / 依赖层 1 / 依赖层 2…),列间 `stageConnector` 箭头(`:569-596`);
  - `TaskNode`:id、状态徽标(`TASK_STATUS_LABEL` 待领取/已认领/进行中/已完成/失败/已取消,`data-state` tone 上色,`:408-424`)、assignee、依赖列表、起点标记;
  - **悬停预览 + 点击固定**:`relatedTaskIds` 沿依赖双向遍历(上游依赖 + 下游被依赖,循环安全)高亮整条链,其余置灰(`:45-72`、`:541-552`);Esc 取消固定。
- 成员侧:`memberStateLabel/memberStatusText` 把"活动态 ⊕ 任务态"合成一句话,如"正在执行 t2"/"等待 t3 · 工程师"(`lib/client.js:443-473`),阻塞时给出**具体等待哪条依赖、由谁认领**。

### 1.5 队长如何收到成员完成通知(含背压/合并写)

- 成员完成时 `agent_teams_send_message(to='captain')`(`lib/tools.js:512-602`)三步走:
  1. **先落盘**:`appendMailbox(captain.jsonl)`(持久,原子) + `appendTeamEvent`(尽力,类型不被认可则跳过);
  2. **解锁后**解析 captain 的 live Agent(`ctx.agents.get(captainSessionId)`);
  3. **live 投递**:`steerCaptainReport` → `captain.steer(createUserMessage({source:{kind:'plugin',plugin:'dsh-agent-teams'}}))`(`lib/tools.js:110-122`)——队长**运行中在下一个 model step 收到**,空闲则唤醒新 turn;失败回落 mailbox(下轮 `agent_teams_status` 可见)。`delivered` 三态:`live / wake / mailbox`。
- 成员→成员:直接 `ctx.subagents.followup(captain, childId, ...)` 唤醒对方(**无队长中转**,`lib/members.js:124-136`),邮件同样落 mailbox。
- 背压/合并写:无专门节流 —— 所有写通过进程内互斥队列串行;客户端轮询有 `inFlight` 防堆叠;成员唤醒即 FIFO 下一条消息,消息间串行。

### 1.6 客户端 UI 的 Slot / 面板

- **会话内卡片**:Slot 名 **`conversation.chat.node`**,key `'agent-teams'`(`lib/client.js:1217-1226`);注册方式 `ctx.conversationEvents.register(agentTeamsCardDefinition)` —— 折叠 `tool/call agent_teams_create`(role `start`)+ `tool/result`(role `update`)成一个聊天节点(`lib/client/agent-teams-card-definition.js:31-85`)。**start 锚定第一方事件,每队恰好一次 create 调用,天然无歧义**。
- **右上浮动面板**:web shell **没有 top-right slot**,用 body portal(`document.body.appendChild` + `createRoot`)挂载(`lib/client.js:1201-1215`);CSS 变量 `--agent-teams-panel-width/-right` 让会话列让位。
- 结论:workgraph **已经在复用同一个 slot**(`conversation.chat.node`,key `'workgraph'`,`packages/client/ui-workgraph/src/client/index.ts:26-33`),"面板式监控"可参照 body-portal + 轮询快照端点模式,但不必改 slot。

### 1.7 定点答疑(队长追问四项)

**Q1: STATE_URL 是哪个宿主端点?谁注册的?返回什么?多久轮询?有没有事件推送?**

| 问 | 答 | 证据 |
|---|---|---|
| 端点 | `GET /plugins/dsh-agent-teams/state`(面板与卡片共用);`?archived=1` 变体拉归档团队 | `lib/client.js:384`(STATE_URL 常量) |
| 谁注册 | host 半插件 `apply()` 里 `ctx.effect(() => webServer.register({kind:'exact', path:'/plugins/dsh-agent-teams/state', handler}))`;webServer/workspaceRegistry 服务**懒绑定**(先试一次,再在 `internal/service` 事件上补注册,headless profile 不挂路由) | `lib/index.js:87-118 / 165-171` |
| 返回什么 | `{ teams: snapshot[] }`,每个 snapshot 由 `assembleTeamSnapshot` 现装:`workspace / teamId / name / description / captainSessionId / members[](id,name,role,activity(working\|idle\|unknown),progress%,done,total,currentTask,unread) / tasks[](id,subject,status,state(completed\|running\|blocked\|open),assignee,dependencies,depth) / messageCount / captainInbox(最近5条)` | `lib/snapshot.js:29-95` |
| 轮询多久 | 浮动面板 **1000ms**(`POLL_MS = 1e3`,`lib/client.js:374`,`setInterval` `:913-915`);会话内卡片 **1500ms**(`:182-184`);均 `fetch(url, {cache:'no-store'})`,`inFlight` 守卫防请求堆叠(`:892-920`) | `lib/client.js` |
| 事件推送 | **没有**。该路由是普通 HTTP GET(请求-响应),无 SSE/WebSocket;`useSyncExternalStore`(:870)订阅的是 `sessionsList`(当前会话 id,用于过滤可见团队),不是团队数据;唯一的"事件"是窗口自定义事件 `agent-teams:open-panel`(卡片按钮唤起面板,纯本地 UI) | `lib/client.js:870 / 150-161 / 921-945` |

**Q2: 卡片(事件折叠)vs 面板(轮询)的分工,为什么?**

- **卡片 = 持久化锚点**:它要"重启存活、出现在会话转写里、能从历史会话重放",所以用会话日志里的**第一方事件** `tool/call agent_teams_create`(role=start)+ `tool/result`(role=update)折叠成节点(`lib/client/agent-teams-card-definition.js:31-85`)。第一方事件随会话持久化,不受"自定义类型不在 KNOWN 集"影响(AgentTeams 自己的 `agent-teams/*` 事件反而不落盘,`lib/events.js:26-47`)。卡片数据本身最小(teamId/name/members),**实况靠轮询补**。
- **面板 = 实时监视器**:它要"此刻谁在跑、任务卡在哪、未读几条",对持久化无要求,对**新鲜度**有要求 → 轮询服务端快照(磁盘真相 ⊕ 子代理实时活动),1s 一次,`no-store`。
- **分工本质**:**"锚定(身份/存在)走事件,内容(状态/活动)走轮询"**。事件通道给确定性(重放一致、跨重启),轮询通道给实时性 + 容错(推送全断也能显示磁盘真相)。二者解耦:卡片折叠失败只影响"会话里有没有这张卡",不影响面板;面板挂了不影响会话重放。

---

## 2. workgraph 现状(对照基线,含证据)

- **事件即真相**:每次图转移经 `commitWorkGraphChange` 提交 —— `agent.session.append('workgraph/change', change)`(全量快照)+ 发 agent 作用域 `workgraph/changed` 实时事件(`packages/workgraph/workgraph/src/commit.ts:20-28`;`domain.ts:12-26` 全量值规则、`:78-99` 事件声明)。**whole-value 规则:每个事件都带完整 post-change 快照,重放 last-wins**。
- **两种 start 形状**:`initializeGraph` 历史 `['created']`(`tracker.ts:107`);`dispatchSet` 路径用 `createPendingGraph`,历史 `['created','planning-started']`(`tracker.ts:141-144`、`scheduler.ts:693-712`)。history 封顶 `DEFAULT_HISTORY_MAX = 64`,从头部逐出(`config.ts:24`、`tracker.ts:43-45`)。
- **客户端折叠**:`workgraphDefinition`(`workgraph-definition.ts:244-296`)—— `match` 把 `workgraph/change` 解码后按 `isGraphStartChange` 定 role(`:189-194`,**本次修复点**:原来只认 `['created']`,现在双形状都认),`update` 整体替换快照、clear 变墓碑,`buildViewNode` 用 `layerNodes` 最长路径分层(`:202-241`)投影 `WorkGraphChatData`。
- **客户端事件通道**:打开会话时从 host `history` 拉窗口重放(`dsh-client-runtime/lib/client.js:7627-7646`),随后 `session/event` 帧**实时推送**,`acceptLiveEvent` 按 seq 去重、gap 走 repairGap 重拉(`:7654-7661`、`:7468-7469`);fold 引擎拒绝"update 先于 start"(`:6572-6575`)与"重复 start"(`:6539-6541`)。`workgraph/change` 在 harness 源码的 `known-event-types.ts:64` 已登记(打包版 dsh-session 的 KNOWN 集缺它,但 `Session.append` 不做类型校验(`dsh-session/lib/index.js:1440-1478`),事件照常落盘推流)。
- 因此 workgraph GUI 是**纯推送、无轮询兜底**:推送折叠失败 = 静默盲区(本次 bug 正是首事件被判定为 update → 折叠上下文永远没有 start → `buildViewNode` 返回 null → DAG 从不渲染,且无任何报错)。

---

## 3. 对 workgraph 实时 DAG 的借鉴点

### 3.1 整快照 checkpoint vs 增量节点状态
- workgraph **已是最优形态**:每次变更发全量快照(whole-value),客户端 last-wins 重放,与 AgentTeams"磁盘真相快照"同思路,但数据源更轻(无需另开投影文件;`.dsh/graph.jsonl` 投影只是降级缓存,`scheduler.ts:706-712` 明言"session log is the source of truth, never the file")。**保持**。
- 借鉴 AgentTeams 的**"服务器端组装快照"**思想:workgraph 若加 host 快照端点,可直接复用 scheduler 现成的 snapshot 结构,天然与事件流同构。

### 3.2 事件推送 vs 轮询
- workgraph 推送更实时、零轮询成本;AgentTeams 轮询更健壮(推送路径全断 UI 仍显示磁盘真相)。
- **建议:推送为主 + 低频轮询兜底校验**(见 §4.2.a)。

### 3.3 节点运行态细粒度更新
- AgentTeams 把**成员活动态**(subagent 正在跑 = working)与**任务状态**(claimed/in_progress/completed)解耦:成员已开工但还没 update_task 也显示"工作中",并可显示"正在执行 t2"(来自 `currentTaskOf`,snapshot.js:14-20)。
- workgraph 的 running 由 scheduler 的节点事件驱动;若 worker 执行长而 checkpoint 稀疏,UI 会长时间停在 ready。可借鉴:**worker 进入即发节点级 running 事件(细粒度活动信号),完成时再发正式状态事件**,两者解耦。

### 3.4 暂停/恢复的交换语义
- AgentTeams 无暂停概念(任务只有终态);workgraph 有 `user_paused/infra_paused/blocked/budget_limited/resume/retry`,每次都是全量快照事件。
- 借鉴点:暂停时**快照保持完整 DAG 与已达成节点**,只翻转 status 与 pauseReason;客户端已按 status 渲染状态徽标,语义正确。保持全量快照即可,无需特殊通道。

### 3.5 start 检测(与本次 bug 直接相关的新事实)
- **AgentTeams 的解法**:start 锚定第一方 `tool/call`(每次建队恰好一次),不靠推断,天然无歧义。
- **workgraph 的解法**(修复后):history 形状推断,双形状 `['created']` / `['created','planning-started']` 都是唯一 start(created 只 append 一次,后续每次变更至少追加一种新 kind,64 封顶从头部逐出 → 后续事件尾部永不等于这两种形状)。该不变式在 `historyMax ≥ 2` 下成立,但有一个**真实边界**(见 §4.1.e):`historyMax=1` 时 `createPendingGraph` 的**第一个事件** history 会被截成 `['planning-started']`(appendHistory 在持久化前就截断,`tracker.ts:43-45`),start 漏判。默认 64 无碍,但值得防御。
- **简化机会(关键)**:`graphId` 在 scheduler 里**只有一处构造** —— `WorkGraphId(randomUUID())`(`scheduler.ts:694`,dispatchSet),每个图都是全新 UUID。因此**"某个 graphId 的第一条 workgraph/change 事件" 按构造就是该图的 start**,无需 history 形状推断;fold 引擎本来就把上下文按 `(kind, id)` 键控(`dsh-client-runtime/lib/client.js:6539`),首个匹配即 start 与 AgentTeams 的 tool/call 锚定是同一思路。history 检查只是防御性判别(防 id 撞车/数据异常)。建议:start 规则简化为"该 key 的首个匹配",history 双形状保留为快路径判别 + 日志,两者兼得。
- **revive 路径的发现(issue 09 相关,非当前 bug 但同族)**:`status()` 在内存无图时会 `readProject(mainDir)` 复活投影(`scheduler.ts:728-738`),`restoreSnapshot` **原样保留 history**(只 promote ready 节点 + 把 status 降级为 user_paused,`tracker.ts:764-779`、`project.ts:159-177`)——但它**只读、不 commit**,不会往新会话日志写 `workgraph/change`。后果:复活的新会话里**没有任何 workgraph/change 事件 → DAG 卡根本不出现**(不是 start 误判,是"无事件可折叠"的可见性缺口);而 `resume()` 又因 `requireGraph`(内存无图)+ 排他锁拒绝复活图(`scheduler.ts:784-795`)。**设计警告**:若未来给 revive 加"自动提交恢复事件",被保留的长 history(非两种 start 形状)会立刻触发 update-before-start 静默失败 —— 这正是加快照端点/形状无关 start 规则的另一个理由。

---

## 4. 建议清单

### 4.1 立即可做(当前 bug 修复内)
- a. `isGraphStartChange` 双形状修复(工程师 t1 进行中,`workgraph-definition.ts:189-194`)——正确。
- b. 回归测试 fixture 覆盖三种形状:直接 set(`['created']`)、dispatchSet(`['created','planning-started']`)、后续变更(至少 3 条 kind,断言不是 start);再补一条"update 先于 start 的折叠错误被拒"测试(`dsh-client-runtime` 语义:6572-6575)。
- c. **消除静默盲区**:`buildViewNode` 返回 null 时(或 fold 抛 update-before-start)输出 `console.warn`/诊断(带 graphId 与原因),UI 上在会话里出现 `workgraph/change` 事件但无节点渲染时给空态提示。这是本次 bug 让人困惑 3 小时的根因。
- d. **start 判定的健壮替代项**(建议优先采用,彻底摆脱形状推断):既然 `graphId` 每次都是全新 `randomUUID()`(`scheduler.ts:694`),客户端 start 规则可直接改为"**该 graphId 的首个匹配**"(fold 引擎按 `(kind,id)` 键控,天然只认一次),history 双形状退化为快路径判别 + debug 日志;或要求 scheduler 在 `workgraph/change` 里显式带 `operation: 'set'`(commit 时已有该参数,`commit.ts:20-28`)。二者都让 `historyMax` 截断与未来 revive 自动提交事件不再成为风险。
- e. **historyMax 边界提醒**:`historyMax` 配置下限是 1(`config.ts:69`)。若有人把 historyMax 调成 1,dispatchSet 首个事件会变成 `['planning-started']`。建议:要么给 start 事件豁免截断,要么在文档/校验里明确 `historyMax ≥ 2`,要么用 d 的替代判别。
- f. **revive 可见性回归**(issue 09):复活路径只读不 commit(`status()`→`readProject`,`scheduler.ts:728-738`),新会话无 workgraph/change 事件 → 无 DAG 卡。建议补一个回归测试:复活后会话日志**不产生** start 形状(现状),并记录"复活图在 GUI 不可见"为已知缺口,配合 §4.2.a 快照端点解决;同时给 revive 未来的"自动提交恢复事件"立规则(必须能通过形状无关 start 判定,或归一化 history)。

### 4.2 设计变更(中期,独立 issue)
- a. **host 快照端点兜底**:仿 `/plugins/dsh-agent-teams/state`(`lib/index.js:98-118`)新增 `GET /plugins/dsh-workgraph/state`(或并入现有 web 服务),服务端从 scheduler/投影装配当前图快照(revive 的 `readProject` 结果天然可用);客户端 DAG 卡在推送之外加 3–5s 低频轮询校验(推送正常时不闪烁,异常时兜底渲染 + 标记"已从快照恢复")。该端点同时解决 §4.1.f 的 revive 可见性缺口。
- b. **细粒度活动信号**:worker 进入节点即发 `node-running`(活动信号,可含进度),完成 checkpoint 再发正式状态事件;UI 的 running 态由活动信号驱动,与状态提交解耦(参照 AgentTeams 活动态,§3.3)。
- c. **阻塞原因呈现**:AgentTeams 显示"等待 t3 · 工程师"链式原因(`lib/client.js:465-468`);workgraph 已有 `waitingOn`(blocks 里未 achieved 的依赖),可增强为显示"等待谁/哪条链"。
- d. **面板化监控**(可选):body-portal 浮动面板 + 按 `captainSessionId === current` 过滤(AgentTeams `:946-957`)——若未来想全局监控多个 workgraph 运行,照此模式;不改变现有 `conversation.chat.node` slot 方案。
- e. **增量节点状态交换**(可选,仅在事件率成为问题时):AgentTeams 没有增量(全量快照/全量文件),workgraph 的全量快照事件目前也够用;若未来节点数大、checkpoint 频繁,可加"增量补丁事件 + 基线快照"两段式(基线仍走 whole-value,补丁只带变化的节点),但客户端 fold 要保持 last-wins 语义与重放确定性。

---

## 5. 附:证据文件清单

| 事实 | 文件:行 |
|---|---|
| AgentTeams 挂载行 / stateDir / memberProvider | `~/.dsh/profiles/web/node_modules/@nanmicoder/dsh-agent-teams/cordis.patch.yml:10-21` |
| /state 轮询端点(no-store)+ 懒注册 | `lib/index.js:87-118`(包同上,下同) |
| 进程内互斥 + 原子写 + 状态机 | `lib/state.js:20-40 / 92-113 / 291-301` |
| 发送消息:落盘 → 解锁 → live steer / followup | `lib/tools.js:512-602 / 110-122`;`lib/members.js:124-136` |
| 状态快照(status 工具) | `lib/tools.js:603-676` |
| 快照装配:磁盘真相 ⊕ 子代理活动 | `lib/snapshot.js:29-95`;`lib/members.js:160-168` |
| taskVisualState / taskDepthsById(列) | `lib/state.js:446-457 / 461-488` |
| 客户端 1s/1.5s 轮询 + inFlight + 会话过滤 | `lib/client.js:374 / 892-920 / 946-957 / 170-189` |
| 会话事件跳过(KNOWN 集不认) | `lib/events.js:26-47` |
| 卡片折叠定义(tool/call start) | `lib/client/agent-teams-card-definition.js:31-85` |
| Slot `conversation.chat.node`(两插件共用) | AgentTeams `lib/client.js:1217-1226`;workgraph `packages/client/ui-workgraph/src/client/index.ts:26-33` |
| workgraph 提交通道(事件即真相) | `packages/workgraph/workgraph/src/commit.ts:20-28`;`domain.ts:12-26,78-99` |
| 两种 start 历史形状 | `packages/workgraph/workgraph-scheduler/src/tracker.ts:107 / 141-144`;`scheduler.ts:693-712` |
| history 封顶 64、从头部逐出 | `packages/workgraph/workgraph-scheduler/src/config.ts:24,69`;`tracker.ts:43-45` |
| start 检测(修复点)与分层 | `packages/client/ui-workgraph/src/client/workgraph-definition.ts:189-194 / 202-241` |
| 客户端重放 + live 推送 + fold 拒绝规则 | `dsh-client-runtime/lib/client.js:7627-7646 / 7654-7661 / 6539-6541 / 6572-6575` |
| workgraph/change 在 KNOWN 集(源码) | `packages/core/session/src/known-event-types.ts:64`(打包版 dsh-session 缺,但 append 不校验:`dsh-session/lib/index.js:1440-1478`) |
| STATE_URL 注册(webServer.register exact) | AgentTeams `lib/index.js:98-118 / 165-171`;无 SSE/WebSocket,纯 HTTP GET |
| graphId 唯一构造(randomUUID) | `packages/workgraph/workgraph-scheduler/src/scheduler.ts:694` |
| revive 只读不 commit、history 原样保留 | `scheduler.ts:728-738`;`project.ts:159-177`;`tracker.ts:764-779`(restoreSnapshot) |
| resume 拒绝复活图(requireGraph + 排他锁) | `scheduler.ts:784-795` |

> 说明:以上 @nanmicoder 包路径为当前机器安装位置;只读研究,未改动任何 @deepseek-ai / @nanmicoder 源码。
