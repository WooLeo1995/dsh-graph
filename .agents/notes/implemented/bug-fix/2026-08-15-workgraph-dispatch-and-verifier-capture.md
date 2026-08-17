# Agent Note: /graph dispatches immediately; verifier verdicts use structured capture

Status: implemented

English | [中文](2026-08-15-workgraph-dispatch-and-verifier-capture.zh.md)

## Problem

Two defects made the `/graph` command look stuck on the trial web instance:

1. **The command blocked for the graph's whole lifetime.** `set`/`resume`/
   `retry` returned `trackEpisode(this.drive(...))` — the drive runs every
   node serially with workers, verifiers, and rounds (minutes to hours), and
   the command channel renders nothing until it settles. In the observed run
   (`/graph 检查一下这个插件`), the command aborted after ~11 s with
   `This operation was aborted`, but the abandoned `set()` chain kept going:
   the plan installed, the drive dispatched workers, and the graph ran
   invisible in the background — active, lock held, no driver visible to the
   user. A second `/graph set` then refused with "already set".
2. **The verifier prompt taught the worker's `REPORT:` text envelope, but the
   verdict is captured through the structured-output tool.** The verifier
   spawn carries `VERIFIER_OUTPUT_SCHEMA`; a model that follows the prompt
   writes `REPORT: {...}` as plain text and never calls the capture tool, so
   the spawn result can never settle. Observed: the first verifier child
   finished with `REPORT: {"verdict":"achieved",...}` in its final text and
   the drive wedged forever on the pending result — the graph stayed
   `running` with no further checkpoint.

## Decision

- **Dispatch, not blocking.** The engine gains `dispatchSet`/
  `dispatchResume`/`dispatchRetry`/`dispatchRetryAll`: validate, commit the
  durable transition, and hand the planning+drive chain to the scheduler
  DETACHED (`runEpisode`: re-plan a pending graph, plan-boundary optimizer,
  drive to settlement). The blocking forms (`set`/`resume`/`retry`/
  `retryAll`) remain as `dispatch*` + `settled()` for programmatic callers
  and tests. The command surface uses the dispatch forms and renders the
  durable snapshot immediately (a pending graph carries a progress hint).
  Failure containment: an episode failure pauses the graph `infra_paused`
  with the reason (never an active-but-undriven graph) and is rethrown for
  blocking callers; a pause/clear landing during planning abandons the plan
  install, so a cleared graph cannot resurrect through a late planner result.
- **The node's `running` transition commits at worker spawn.** The round seam
  gains `onSpawned`, invoked when the child is published before its epoch is
  awaited; status and the DAG show `running` while the worker actually works
  (the old post-round commit hid a minutes-long worker run).
- **The verifier prompt teaches the structured-result contract** (exactly one
  structured result of shape `{"verdict","gaps","discovered"}`), mirroring
  the planner; the worker keeps its `REPORT:` envelope because continuation
  rounds carry no structured capture.

## Alternatives considered

**Keep the blocking contract and only pause the graph when the command is
aborted.** Rejected: the command still blocks the conversation channel for
the whole graph run — the hang itself is the bug.

**Let the verifier accept both capture paths (envelope and structured).**
Rejected: two capture paths for one verdict invite spoofing confusion and
keep the contradiction that produced the wedge; the structured tool is the
single authoritative channel for one-shot spawns.
