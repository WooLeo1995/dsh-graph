# Agent Note: Pause tests wait for the in-flight round (load-deterministic)

Status: implemented

English | [中文](2026-08-15-workgraph-pause-tests-in-flight-round.zh.md)

## Problem

Three workgraph pause tests used a fixed delay between `set()` and the
pause, and each asserted a premise that only holds when the pause lands
while the drive is inside its bounded settle wait: `paused.status` is
`user_paused` (parallel "stops the batch"), the render shows the paused
state ("pauses mid-episode"), and the pre-clear fallback view ("clear lands
during the pause settle"). Under full-suite load `set()`'s planning chain
(planner, optimizer probe, drive start) can take longer than the fixed
delay, so the pause landed before `trackEpisode` had replaced the initial
resolved `episodeSettled` — the bounded-settle race resolved instantly, the
pause returned the pre-drive view, and a later plan commit even overwrote
the pause in `latest`. The assertions then failed intermittently
(`expected 'active' to be 'user_paused'`), one test per run, rotating
across the three tests.

## Decision

Each pause test now waits for the in-flight round before pausing — the
same load-deterministic pattern the minting test already used. The gated
worker round signals a `started` promise (command spec) or bumps a `calls`
counter (parallel spec) that the test polls with a 5 s budget; only then
does the pause run. With the round gated, the drive is awaiting it by
construction, `episodeSettled` is the live drive promise, and the pause's
bounded settle wait genuinely spans the clear/release that follows. A
leftover `DBG git run` console log in the parallel spec's fake git seam was
removed with the same commit.

## Alternatives considered

**Make `planAndInstall` abort-aware so a pause mid-planning cannot be
overwritten by the plan commit.** Deferred: with a real planner the abort
signal kills the planner child, so the episode fails closed and the pause
sticks; the overwrite window is the microtask gap between the child's
settlement and the plan commit. The tests hit it only because their fake
planner ignores the signal. The narrow window is noted here rather than
widened into a new code path tonight.

**Lengthen the fixed delay.** Rejected: a delay is a probabilistic fix and
the suite already converted this family to polling for exactly that reason.
