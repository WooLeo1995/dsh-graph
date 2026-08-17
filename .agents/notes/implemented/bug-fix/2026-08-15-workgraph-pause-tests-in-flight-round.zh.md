# Agent Note: 暂停测试等待在途 round（负载确定性）

Status: implemented

[English](2026-08-15-workgraph-pause-tests-in-flight-round.md) | 中文

## Problem

三个 workgraph 暂停测试在 `set()` 与暂停之间使用固定延时，且每个测试都
断言一个仅在暂停落在 drive 的有界 settle 等待期间才成立的先决条件：
`paused.status` 为 `user_paused`（parallel 的 "stops the batch"）、渲染为
暂停状态（"pauses mid-episode"）、以及 clear 前回退视图（"clear lands
during the pause settle"）。在完整套件负载下，`set()` 的规划链（planner、
optimizer 探测、drive 启动）可能超过固定延时，于是暂停落在
`trackEpisode` 用真实 drive promise 替换初始已 resolve 的 `episodeSettled`
之前——有界 settle race 立即返回，暂停拿到的是 drive 之前的视图，后续的
plan commit 甚至会把 `latest` 中的暂停覆盖掉。断言随即间歇性失败
（`expected 'active' to be 'user_paused'`），每次跑一个测试，三个测试轮流。

## Decision

每个暂停测试现在都在暂停前等待在途 round——与 minting 测试已使用的
负载确定性模式相同。被 gate 住的 worker round 会触发一个 `started`
promise（command spec）或递增 `calls` 计数（parallel spec），测试以 5 秒
预算轮询之；随后才执行暂停。由于 round 被 gate 住，drive 必然正 await
它，`episodeSettled` 是活的 drive promise，暂停的有界 settle 等待确实跨越
随后的 clear/release。parallel spec 的 fake git seam 中残留的 `DBG git
run` console 日志也在同一提交中移除。

## Alternatives considered

**让 `planAndInstall` 感知 abort，使规划中的暂停不被 plan commit 覆盖。**
推迟：真实 planner 下 abort 信号会杀死 planner 子进程，episode 以
fail-closed 结束、暂停保留；覆盖窗口只是子进程 settle 与 plan commit 之间
的微任务间隙。测试之所以命中它，只是因为 fake planner 忽略了信号。这个
窄窗口在此记录，而不是今晚扩成新的代码路径。

**延长固定延时。** 否决：延时是概率性修复，而本套件此前正是为此把这
一族测试改成了轮询。
