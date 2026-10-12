#!/usr/bin/env bash
# Pre-merge sync report for fork/upstream workflow.
# Usage: bash scripts/pre-merge-report.sh
#
# On Windows PowerShell, run via Git Bash:
#   bash scripts/pre-merge-report.sh

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Not inside a git repository."
  exit 1
}
cd "$ROOT"

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
FORK_REMOTE="${FORK_REMOTE:-origin}"
BASE_BRANCH="${BASE_BRANCH:-main}"

if ! git remote get-url "$UPSTREAM_REMOTE" &>/dev/null; then
  echo "No '$UPSTREAM_REMOTE' remote found."
  echo ""
  echo "Add upstream with:"
  echo "  git remote add upstream https://github.com/growthenginenowoslawski/coldoutboundskills.git"
  exit 1
fi

echo "Fetching $UPSTREAM_REMOTE/$BASE_BRANCH..."
git fetch "$UPSTREAM_REMOTE" "$BASE_BRANCH" --quiet

if git remote get-url "$FORK_REMOTE" &>/dev/null; then
  echo "Fetching $FORK_REMOTE/$BASE_BRANCH..."
  git fetch "$FORK_REMOTE" "$BASE_BRANCH" --quiet 2>/dev/null || true
fi

UPSTREAM_REF="$UPSTREAM_REMOTE/$BASE_BRANCH"
FORK_REF="$FORK_REMOTE/$BASE_BRANCH"

if ! git show-ref --verify --quiet "refs/remotes/$UPSTREAM_REF"; then
  echo "Remote branch '$UPSTREAM_REF' not found after fetch."
  exit 1
fi

COMPARE_REF="$FORK_REF"
if git show-ref --verify --quiet "refs/remotes/$FORK_REF"; then
  COMPARE_REF="$FORK_REF"
elif git show-ref --verify --quiet "refs/heads/$BASE_BRANCH"; then
  COMPARE_REF="$BASE_BRANCH"
  echo "Note: using local '$BASE_BRANCH' (no '$FORK_REF' remote branch found)."
else
  echo "No '$FORK_REF' or local '$BASE_BRANCH' branch to compare against."
  exit 1
fi

echo ""
echo "=== Pre-merge report ==="
echo "Compare:  $COMPARE_REF"
echo "Upstream: $UPSTREAM_REF"
echo ""

echo "--- Commits on upstream not in your branch ---"
UPSTREAM_ONLY="$(git log --oneline "$COMPARE_REF..$UPSTREAM_REF" 2>/dev/null || true)"
if [ -z "$UPSTREAM_ONLY" ]; then
  echo "(none — your branch includes all upstream commits)"
else
  echo "$UPSTREAM_ONLY"
fi
echo ""

echo "--- Commits on your branch not in upstream ---"
LOCAL_ONLY="$(git log --oneline "$UPSTREAM_REF..$COMPARE_REF" 2>/dev/null || true)"
if [ -z "$LOCAL_ONLY" ]; then
  echo "(none — no local-only commits)"
else
  echo "$LOCAL_ONLY"
fi
echo ""

echo "--- File diff ---"
FILE_DIFF="$(git diff --stat "$COMPARE_REF" "$UPSTREAM_REF" 2>/dev/null || true)"
if [ -z "$FILE_DIFF" ]; then
  echo "(no file differences)"
else
  echo "$FILE_DIFF"
fi
echo ""

UPSTREAM_AHEAD="$(git rev-list --count "$COMPARE_REF..$UPSTREAM_REF" 2>/dev/null || echo 0)"
LOCAL_AHEAD="$(git rev-list --count "$UPSTREAM_REF..$COMPARE_REF" 2>/dev/null || echo 0)"

echo "=== Summary ==="
echo "Upstream commits to merge: $UPSTREAM_AHEAD"
echo "Your commits not upstream:   $LOCAL_AHEAD"

if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "Working tree:                dirty (commit or stash before merging)"
fi

echo ""
if [ "$UPSTREAM_AHEAD" -eq 0 ] && [ "$LOCAL_AHEAD" -eq 0 ]; then
  echo "Status: In sync — nothing to merge."
elif [ "$UPSTREAM_AHEAD" -gt 0 ] && [ "$LOCAL_AHEAD" -eq 0 ]; then
  echo "Status: Upstream has new commits. Merge with:"
  echo "  git merge $UPSTREAM_REF"
elif [ "$UPSTREAM_AHEAD" -gt 0 ] && [ "$LOCAL_AHEAD" -gt 0 ]; then
  echo "Status: Branches diverged. Merge upstream with:"
  echo "  git merge $UPSTREAM_REF"
  echo "Or rebase your commits on top:"
  echo "  git rebase $UPSTREAM_REF"
else
  echo "Status: Your branch is ahead of upstream."
fi
