#!/usr/bin/env bash
set -euo pipefail

# Sync source files between this standalone repo and the openclaw monorepo extension.
# Usage:
#   ./scripts/sync.sh pull   — copy from monorepo → standalone
#   ./scripts/sync.sh push   — copy from standalone → monorepo

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STANDALONE="$(dirname "$SCRIPT_DIR")"
MONOREPO="${STANDALONE}/../openclaw/extensions/b2-backup"

# Files to sync (relative to each root)
SHARED_FILES=(
  "index.ts"
  "index.test.ts"
  "openclaw.plugin.json"
  "src/types.ts"
  "src/b2-client.ts"
  "src/b2-client.test.ts"
  "src/gatherer.ts"
  "src/gatherer.test.ts"
  "src/manifest.ts"
  "src/manifest.test.ts"
  "src/snapshots.ts"
  "src/snapshots.test.ts"
  "src/sqlite-snapshot.ts"
  "src/push.ts"
  "src/pull.ts"
  "src/service.ts"
)

case "${1:-}" in
  pull)
    echo "Pulling from monorepo → standalone"
    for f in "${SHARED_FILES[@]}"; do
      if [ -f "$MONOREPO/$f" ]; then
        mkdir -p "$(dirname "$STANDALONE/$f")"
        cp "$MONOREPO/$f" "$STANDALONE/$f"
        echo "  ← $f"
      fi
    done
    echo "Done. Review changes with: git diff"
    ;;
  push)
    echo "Pushing from standalone → monorepo"
    for f in "${SHARED_FILES[@]}"; do
      if [ -f "$STANDALONE/$f" ]; then
        mkdir -p "$(dirname "$MONOREPO/$f")"
        cp "$STANDALONE/$f" "$MONOREPO/$f"
        echo "  → $f"
      fi
    done
    echo "Done. Review changes in monorepo with: cd $MONOREPO && git diff"
    ;;
  *)
    echo "Usage: $0 {pull|push}"
    echo "  pull  — monorepo extension → this repo"
    echo "  push  — this repo → monorepo extension"
    exit 1
    ;;
esac
