# Agent Note: workgraph UI 深色主题失配 —— 虚构 token 全面映射到宿主主题词汇

Status: implemented

English | [中文](2026-08-17-workgraph-dark-theme.zh.md)

## Problem

The workgraph chat card and the floating activity panel never adapted to the dark theme. Root causes, verified against the harness theme (`@deepseek-ai/dsh-client-ui-theme/lib/styles/design-platform.css`, which defines the full `--dsw-alias-*` vocabulary with a `body[data-ds-dark-theme]` block):

1. **The card (`WorkGraphNode.module.css`) referenced fictional `--dsh-color-*` tokens** — 36 references to names that do not exist anywhere in the host (zero occurrences in the web dist). Every declaration silently resolved to its light fallback (`#fff`, `#ddd`, `#222`, …), so the card was permanently light.
2. **The panel (`ActivityPanel.module.css`) carried an upstream token-bridge block** that invented aliases (`--dsw-alias-line-normal`, `--dsw-alias-bg-module`, `--dsw-alias-bg-fill-*`, `--dsw-alias-state-success/warning/danger`, `--dsw-alias-label-on-fill`) backed by static light values (`--dsw-static-neutral-bluish-*`). Those aliases are not part of this harness's vocabulary either, so the panel was light-only as well — the upstream bridge was written for a different harness release.

## Decision

- **The card maps onto the real themed tokens**: surface→`bg-layer-1`, border→`border-l1`, text→`label-primary`, muted→`label-tertiary`, muted bg→`bg-layer-2`, primary→`state-business-primary`, success/warning/error→`state-*-primary`, soft fills→`state-*-tertiary` (success/warn/business have tertiary; error has none, so the failed-node soft fill uses `color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, var(--dsw-alias-bg-layer-1))`, which follows both themes).
- **The panel drops the bridge block entirely** and its usage sites reference the real tokens directly: `line-normal`→`border-l1`, `line-strong`→`border-l2`, `bg-module`→`bg-layer-1` (taking care not to rewrite the real `bg-module-platform`), `bg-fill-neutral`→`bg-layer-2`, `bg-fill-*`→`state-*-primary`, `state-success/warning/danger`→`state-*-primary`, `label-on-fill`→`label-primary-inverted`.
- **A static audit regression test (`tests/css-theme.client.spec.ts`)** pins the contract: no `--dsh-color-*` references, every `--dsw-alias-X` reference in the 78-name verified allowlist, no `--dsw-static-*` references, and color literals allowed only as `var()` fallbacks. Red before the fix (2/3 failing), green after.

## Verification

101/101 ui-workgraph tests green (98 existing + 3 new audit); per-file src coverage 100/100/100/100; `tsc -b` clean; oxlint 0 findings on touched files; client bundle rebuilt and grep-verified (`dsh-color` 0, `dsw-static` 0, real tokens present). Dark/light adaptation now flows from the harness theme variables themselves.

## Alternatives considered

**Keep the bridge but switch its backing values to themed tokens.** Rejected: the bridge aliases are not part of the vocabulary and would remain an indirection layer with no benefit; direct references keep every declaration auditable by the static test.
