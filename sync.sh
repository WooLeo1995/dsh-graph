#!/usr/bin/env bash
# Bidirectional source sync between this mirror and the deepseek-harness fork.
#
#   ./sync.sh pull   host fork  ->  this repository
#   ./sync.sh push   this repo  ->  host fork
#
# Excludes build outputs (lib/), installed deps (node_modules/), and runtime
# artifacts (.dsh/). The host is where building and testing actually happen.
set -euo pipefail

HOST="${DSH_GRAPH_HOST:-/Users/wutianyu/Downloads/project/github/deepseek-harness}"
HERE="$(cd "$(dirname "$0")" && pwd)"

EXCLUDES=(--exclude lib --exclude node_modules --exclude .dsh --exclude '*.tsbuildinfo')

PAIRS=(
  packages/workgraph/workgraph
  packages/workgraph/workgraph-scheduler
  packages/workgraph/command-workgraph
  packages/client/ui-workgraph
  .scratch/workgraph
  docs/subsystems/workgraph.md
  docs/subsystems/workgraph.zh.md
  docs/subsystems/workgraph.i18n.yaml
)

# The workgraph Agent Notes only (the host feature dir holds many other notes).
NOTES_DIR=.agents/notes/implemented/feature
NOTES_FILTERS=(--include '2026-08-14-workgraph-v*' --exclude '*')

# The workgraph bug-fix notes (the host bug-fix dir holds many other notes).
BUGFIX_NOTES_DIR=.agents/notes/implemented/bug-fix
BUGFIX_NOTES_FILTERS=(--include '2026-08-15-workgraph-*' --exclude '*')

case "${1:-}" in
  pull)
    for rel in "${PAIRS[@]}"; do
      mkdir -p "$HERE/$(dirname "$rel")"
      rsync -a "${EXCLUDES[@]}" "$HOST/$rel" "$HERE/$(dirname "$rel")/"
    done
    rsync -a "${EXCLUDES[@]}" "$HOST/packages/workgraph/README.md" "$HOST/packages/workgraph/README.zh.md" "$HOST/packages/workgraph/README.i18n.yaml" "$HERE/packages/workgraph/"
    mkdir -p "$HERE/$NOTES_DIR"
    rsync -a "${EXCLUDES[@]}" "${NOTES_FILTERS[@]}" "$HOST/$NOTES_DIR/" "$HERE/$NOTES_DIR/"
    mkdir -p "$HERE/$BUGFIX_NOTES_DIR"
    rsync -a "${EXCLUDES[@]}" "${BUGFIX_NOTES_FILTERS[@]}" "$HOST/$BUGFIX_NOTES_DIR/" "$HERE/$BUGFIX_NOTES_DIR/"
    echo "pulled from $HOST"
    ;;
  push)
    for rel in "${PAIRS[@]}"; do
      mkdir -p "$HOST/$(dirname "$rel")"
      rsync -a "${EXCLUDES[@]}" "$HERE/$rel" "$HOST/$(dirname "$rel")/"
    done
    rsync -a "${EXCLUDES[@]}" "$HERE/packages/workgraph/README.md" "$HERE/packages/workgraph/README.zh.md" "$HERE/packages/workgraph/README.i18n.yaml" "$HOST/packages/workgraph/"
    mkdir -p "$HOST/$NOTES_DIR"
    rsync -a "${EXCLUDES[@]}" "${NOTES_FILTERS[@]}" "$HERE/$NOTES_DIR/" "$HOST/$NOTES_DIR/"
    mkdir -p "$HOST/$BUGFIX_NOTES_DIR"
    rsync -a "${EXCLUDES[@]}" "${BUGFIX_NOTES_FILTERS[@]}" "$HERE/$BUGFIX_NOTES_DIR/" "$HOST/$BUGFIX_NOTES_DIR/"
    echo "pushed to $HOST"
    ;;
  *)
    echo "usage: $0 {pull|push}"
    exit 2
    ;;
esac
