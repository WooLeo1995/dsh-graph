# Agent Note: 工作图工具过滤器只允许注册的工具名

Status: implemented

[English](2026-08-15-workgraph-deny-lists-registered-tools.md) | 中文

## Problem

从 jxca 移植过来的 worker 与 verifier deny 列表引用了本宿主中并不存在的
工具名：`jobs`、`todo`、`code-runtime` 在此处没有注册表对应项（任务族是
`job_list`/`job_output`/`job_kill`，todo 工具是 `todo_write`，委派拆分为
`subagent`/`subagent_fork`，且根本不存在 code-runtime 工具）。
`tools.restrict()` 会针对注册表校验每一个过滤器名字，遇到未注册名字时大声
失败，因此第一个图节点 spawn 就中止了 `/graph` 命令——在试用 web 实例上，
planner 与 optimizer 运行了数分钟，随后命令以
`tools.restrict() names unknown global tools "jobs", "todo", "code-runtime"`
结束，用户在界面上感知为消息卡住。

## Decision

deny 列表只列出已注册的工具名，同时保留原有的姿态（不允许子代理、工作流、
任务管理、技能、todo；verifier 额外拒绝写/编辑与用户提问）：

- worker：`subagent`、`subagent_fork`、`workflow`、`job_list`、
  `job_output`、`job_kill`、`skill`、`todo_write`
- verifier：`write`、`edit`、`subagent`、`subagent_fork`、`workflow`、
  `job_list`、`job_output`、`job_kill`、`skill`、`todo_write`、
  `ask_user_question`

`WORKER_DENY_LIST` 上的注释记录了规则：列表必须与注册表中的工具名完全一致，
因为 `tools.restrict()` 是对陈旧能力假设的大声守卫。

## Alternatives considered

**在 spawn 时与注册表求交集。** 否决：静态列表让 worker/verifier 的姿态明确
且可审查，本仓库各 profile 的注册表稳定，而静默收缩的过滤器会在名字写错时
隐藏意图。

**放宽 `tools.restrict()` 以忽略未知名字。** 否决：大声失败是刻意且经过测试
的核心行为——未知名字几乎总是拼写错误或陈旧的能力假设，压制它只会掩盖此类
回归。
