# @deepseek-ai/dsh-command-workgraph

[English](README.md) | 中文

面向 [`ctx.workGraph`](../workgraph/README.md) 的人工 `/graph` 控制。插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令，每个组合的命令适配器无需模型回合即可发现并执行它。语法与渲染忠实移植自 jxca-cli 的 `/graph`（[work-graph spec](../../../.scratch/workgraph/spec.md) 持有契约）。

## 命令契约

| 输入 | 结果 |
|---|---|
| `/graph` 或 `/graph status` | 渲染逐节点状态树：字形、等待、轮次、token 消耗、预算行、挂起发现与暂停原因。 |
| `/graph show` | 渲染分层 box-drawing DAG（状态字形与图例），当排布超出宽度预算时降级为状态树。 |
| `/graph <objective> [--budget <tokens>]` | 把目标规划并执行为依赖图；末尾独立 `--budget` 设置 token 预算。 |
| `/graph pause` | 暂停进行中的回合；命令在返回前等待有界的子结算（per-child await budget）。 |
| `/graph resume [--budget <tokens>]` | 恢复暂停/阻塞的图；补额可重新进入 budget-limited 图，而 `budget_limited` 上的普通 resume 打印补额提示。 |
| `/graph retry [node]` | 按节点 id 重试一条失败链，或（裸）把每个失败链作为**一个**联合批次重试——被兄弟失败阻塞的共享终节点会拒绝任何单根重置。 |
| `/graph clear` | 清空图及其持久 tombstone；已清空的图不可复活。 |

控制词仅在占据完整输入时大小写不敏感。任何以 `resume` 或 `retry` 开头的输入都解析为该命令，**绝不**落入 set——拼错的补额不得悄悄替换一个可恢复的 budget-limited 图。只有末尾、独立、值为全数字正 token 的 `--budget` 标志才会被消费；其余内容保留在目标中。预期的域拒绝（已设置、不可重试、预算提示、未知节点）变成稳定的直接命令错误；意外的实现失败仍然拒绝分派，让适配器报告命令失败。

## 组合

生产者注入 `commands` 与 `workGraph`。自定义应用挂载其属主与插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: workgraph
  name: '@deepseek-ai/dsh-workgraph-scheduler'
- id: command-workgraph
  name: '@deepseek-ai/dsh-command-workgraph'
```

调度器 provider 拥有持久图；命令是 `ctx.workGraph` 之上的纯适配器。

## Model Experience

### 人工 `/graph` 控制

#### 模型看到什么

斜杠输入、变更与直接状态/错误输出不出现在模型请求中。引擎把每个被接受的转换记录为 `workgraph/change`；GUI（issue 08）从这些事件渲染活 DAG。展示文本永不记入日志。

#### Token 影响

读取状态、变更图或收到直接命令错误不增加模型 token。图的 worker 与 verifier 子代理花费各自 token，经会话 usage 记录计入图预算。

#### KV Cache 影响

命令发现、变更与直接输出不影响缓存。子请求走各自的全新会话。

## Known Limitations and Deferred Work

- **阻塞式 set** —— `/graph <objective>` 运行回合直到首次结算（complete、paused 或 blocked）才返回，占用代理的命令循环；父会话仍不花模型回合。分离式启动留待后续。
- **仅纯文本交互** —— 通用命令注册表没有模态表单；内联 `--budget` 标志与显式控制词在各适配器间保持意图确定。
- **无连续状态组件** —— 裸 `/graph` 是可移植的观察 API；活 DAG 视图随 issue 08 落地。
