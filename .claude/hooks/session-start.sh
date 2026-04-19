#!/bin/bash
# Print how far the current branch is behind origin/main so that
# Claude Code sessions don't plan or code against a stale base.
set -euo pipefail

REPO="${CLAUDE_PROJECT_DIR:-$(pwd)}"

if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

cd "$REPO"

git fetch origin --quiet 2>/dev/null || {
  echo "[session-start] git fetch origin failed (offline?). Skipping branch-freshness check."
  exit 0
}

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "DETACHED")

if ! git rev-parse --verify origin/main >/dev/null 2>&1; then
  echo "[session-start] origin/main not found; cannot verify branch freshness."
  exit 0
fi

BEHIND=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)

if [ "$BEHIND" -eq 0 ]; then
  echo "[session-start] Branch '$BRANCH' is up to date with origin/main."
  exit 0
fi

cat <<EOF
================================================================
STALE BRANCH: '$BRANCH' is $BEHIND commit(s) behind origin/main.
Rebase BEFORE planning or coding: git rebase origin/main
Reasoning against a stale base produces wrong plans.

Missing commits (up to 20 shown):
EOF
git log --oneline HEAD..origin/main | head -20
echo "================================================================"
