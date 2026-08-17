# dsh-graph —— DeepSeek Harness workgraph 插件源码

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **workgraph 能力族**的独立维护源码仓库:确定性工作图调度器、`/graph` 命令面与 Web 客户端活 DAG 视图。一个目标变成自主、自验证节点的依赖 DAG——planner 子代理规划,worker 子代理实现,对抗式 verifier 子代理审计,并行批次在隔离 git worktree 中运行并 3-way 合并回来,发现工作在 cap 下重规划,拓扑优化器在计划边界重塑图,图经会话事件与仓库根 `.dsh/graph.jsonl` 投影(排他锁)跨会话存活。

## 仓库结构

```
packages/
  workgraph/
    workgraph/             dsh-workgraph —— Service Definition(词汇、ctx.workGraph、workgraph/* 事件)
    workgraph-scheduler/   dsh-workgraph-scheduler —— provider:tracker、episodes、passes、worktrees、项目复活
    command-workgraph/     dsh-command-workgraph —— ctx.commands 上的 /graph 命令(无模型轮次)
  client/
    ui-workgraph/          dsh-client-ui-workgraph —— Web 客户端活 DAG 视图(会话事件的纯函数)
docs/subsystems/           workgraph 子系统页(服务面 + 事件范围目录)
.scratch/workgraph/        权威 phase-2 spec(spec.md)与 issue 01–09
.agents/notes/             Agent Notes v1–v9(已实现决策,中英双语)
CONTEXT.md                 设计 grilling 中确立的领域词汇表
```

## 与 DeepSeek Harness 的关系

本仓库是 `deepseek-harness` fork 内 workgraph 包的**源码镜像**,作为独立 GitHub 项目便于维护与评审。各包把 `@deepseek-ai/*` 内部依赖声明为 `workspace:^`——这些内部包(cordis、schemastery、dsh-session、dsh-agent、dsh-subagent……)在宿主仓库中 vendored 且未发布到 npm,因此**构建与测试需要宿主 checkout**:

- 宿主仓库:`/Users/wutianyu/Downloads/project/github/deepseek-harness`(分支 `master`)
- 工作区同步:`./sync.sh pull`(宿主 → 本仓库)/ `./sync.sh push`(本仓库 → 宿主)

逐包测试门(逐文件 100% 覆盖、i18n 三件套记录、staged lint)由宿主工具链执行。

## 用法

```
/graph <objective> [--budget <tokens>] | status | show | pause | resume [--budget <tokens>] | retry [node] | clear
```

`set`、`resume`、`retry` **派发后立即返回**:图由调度器在后台规划并驱动,命令通道不会为图的整个生命周期阻塞。进度通过 `/graph status`、`/graph show`、仓库投影(`.dsh/graph.jsonl`)与 Web 客户端活 DAG 视图观察;`pause` 仍等待有界子代理结算。规划或驱动失败时图以 `infra_paused` 暂停并携带原因——图绝不会"active 却无人驱动"。

## 本机安装(试用)

1. 在宿主 checkout 中构建调度器与客户端 bundle(workgraph 各包的 `lib/` 须为最新):
   ```bash
   cd /Users/wutianyu/Downloads/project/github/deepseek-harness
   node_modules/.bin/tsc -b packages/workgraph/workgraph packages/workgraph/workgraph-scheduler packages/workgraph/command-workgraph
   node_modules/.bin/tsdown           # host face;client face 覆盖 ui-workgraph
   ```
2. 把包链接进 dsh profile(用户插件工作区从 `~/.dsh/profiles/` 解析):
   ```bash
   cd ~/.dsh/profiles/node_modules/@deepseek-ai
   ln -s <host>/packages/workgraph/workgraph dsh-workgraph
   ln -s <host>/packages/workgraph/workgraph-scheduler dsh-workgraph-scheduler
   ln -s <host>/packages/workgraph/command-workgraph dsh-command-workgraph
   ln -s <host>/packages/client/ui-workgraph dsh-client-ui-workgraph
   ```
3. 把插件行加入 web profile patch(`~/.dsh/profiles/web/cordis.patch.yml`):
   ```yaml
   - insert:
       - id: workgraph
         name: '@deepseek-ai/dsh-workgraph-scheduler'
         config:
           workgraphDir: !!js dshHomePath('workgraph')
       - id: command-workgraph
         name: '@deepseek-ai/dsh-command-workgraph'
       - id: ui-workgraph
         name: '@deepseek-ai/dsh-client-ui-workgraph'
   ```
4. 启动独立试用实例(默认 3080 可能被既有实例占用):
   ```bash
   node apps/cli/lib/bin.js web --patch examples/web-graph.patch.yml
   ```
   试用实例监听 `http://127.0.0.1:3081`;打开后在会话中运行 `/graph <objective>`。卸载:从 `cordis.patch.yml` 移除这些行(或删除该文件)后重启。

端口覆盖见 [examples/web-graph.patch.yml](examples/web-graph.patch.yml)。`workgraphDir` 位于调度器的 cordis Config schema;loader 以包默认导出取用调度器类(class 插件惯例)。

经校验的 cordis.yml 配置:`concurrency`(3,钳 1–8)、`nodeRounds`(3,1–8)、`replanCap`(3,0–10)、`optimizer`(开)、`maxNodes`(24)、`historyMax`(64)、`planBytesMax`(256 KiB)、`childAwaitBudget`(600 秒,1–3600)。

## 文档

- [CONTEXT.md](CONTEXT.md) —— 领域词汇表(通用语言)。
- [.scratch/workgraph/spec.md](.scratch/workgraph/spec.md) —— 权威 phase-2 spec。
- [.scratch/workgraph/issues/](.scratch/workgraph/issues/) —— issue 01–09,每个都标 resolved 并附决议。
- [.agents/notes/implemented/feature/](.agents/notes/implemented/feature/) —— Agent Notes v1–v9(中英双语)。

## License

MIT。workgraph 实现是 jxca-cli `/graph` 契约的移植(行为契约带 provenance 移植,未复制代码);宿主 DeepSeek Harness 代码库 © 2026 DeepSeek,MIT 许可。
