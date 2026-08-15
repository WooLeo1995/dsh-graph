# Agent Note: Workgraph tool filters name registered tools

Status: implemented

English | [中文](2026-08-15-workgraph-deny-lists-registered-tools.zh.md)

## Problem

The worker and verifier deny lists ported from jxca named tools that are not
registered in the host harness: `jobs`, `todo`, and `code-runtime` have no
registry counterpart here (the job family is `job_list`/`job_output`/
`job_kill`, the todo tool is `todo_write`, delegation splits into
`subagent`/`subagent_fork`, and no code-runtime tool exists at all).
`tools.restrict()` validates every filter name against the registry and fails
loudly on unregistered names, so the first graph node spawn aborted the
`/graph` command — on the trial web instance the planner and optimizer ran
for minutes and then the command ended with
`tools.restrict() names unknown global tools "jobs", "todo", "code-runtime"`,
which the user experienced as a stuck message.

## Decision

The deny lists name only registered tools, preserving the original posture
(no children, no workflows, no job management, no skills, no todos; the
verifier additionally denies writes/edits and user prompts):

- worker: `subagent`, `subagent_fork`, `workflow`, `job_list`, `job_output`,
  `job_kill`, `skill`, `todo_write`
- verifier: `write`, `edit`, `subagent`, `subagent_fork`, `workflow`,
  `job_list`, `job_output`, `job_kill`, `skill`, `todo_write`,
  `ask_user_question`

A comment on `WORKER_DENY_LIST` records the rule: the lists must name tools
exactly as registered, because `tools.restrict()` is the loud guard against
stale capability assumptions.

## Alternatives considered

**Intersect the deny list with the registry at spawn time.** Rejected: the
static lists keep the worker/verifier posture explicit and reviewable, the
registry is stable across profiles of this repository, and a silently
shrinking filter would hide the intent when a name is misspelled.

**Relax `tools.restrict()` to ignore unknown names.** Rejected: the loud
failure is deliberate, tested core behavior — an unknown name is almost
always a typo or a stale capability assumption, and suppressing it would mask
future regressions of exactly this kind.
