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

mapfile -t PAIRS < <(cat <<'EOF'
packages/workgraph/workgraph
packages/workgraph/workgraph-scheduler
packages/workgraph/command-workgraph
packages/client/ui-workgraph
.scratch/workgraph
.agents/notes/implemented/feature
docs/subsystems/workgraph.md
docs/subsystems/workgraph.zh.md
docs/subsystems/workgraph.i18n.yaml
EOF
)

case "${1:-}" in
  pull)
    for rel in "${PAIRS[@]}"; do
      mkdir -p "$HERE/$(dirname "$rel")"
      rsync -a "${EXCLUDES[@]}" "$HOST/$rel" "$HERE/$(dirname "$rel")/"
    done
    rsync -a "${EXCLUDES[@]}" "$HOST/packages/workgraph/README.md" "$HOST/packages/workgraph/README.zh.md" "$HOST/packages/workgraph/README.i18n.yaml" "$HERE/packages/workgraph/"
    echo "pulled from $HOST"
    ;;
  push)
    for rel in "${PAIRS[@]}"; do
      mkdir -p "$HOST/$(dirname "$rel")"
      rsync -a "${EXCLUDES[@]}" "$HERE/$rel" "$HOST/$(dirname "$rel")/"
    done
    rsync -a "${EXCLUDES[@]}" "$HERE/packages/workgraph/README.md" "$HERE/packages/workgraph/README.zh.md" "$HERE/packages/workgraph/README.i18n.yaml" "$HOST/packages/workgraph/"
    echo "pushed to $HOST"
    ;;
  *)
    echo "usage: $0 {pull|push}"
    exit 2
    ;;
esac
