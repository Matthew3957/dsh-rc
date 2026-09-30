#!/usr/bin/env bash
# Fail if any commit subject in <base>..HEAD is not a Conventional Commit.
# Usage: scripts/commit-check.sh <base-ref>   (also checks a PR title given as $PR_TITLE)
set -uo pipefail
base="${1:?base ref required}"
TYPES='feat|fix|perf|revert|docs|style|chore|refactor|test|build|ci|deps'
RE="^($TYPES)(\([a-z0-9._/-]+\))?!?: [^ ].{0,98}$"   # summary under 100 characters
# Resolve the range first: a failed git log must fail the check, not pass it with nothing checked.
git rev-parse --verify --quiet "$base" >/dev/null || { echo "commit-check: cannot resolve $base"; exit 1; }
commits=$(git log --format='%h %s' "$base"..HEAD) || { echo "commit-check: git log failed for $base..HEAD"; exit 1; }
bad=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  sha="${line%% *}"; subject="${line#* }"
  # Merge commits and GitHub's own revert subjects are left alone.
  [[ "$subject" =~ ^(Merge|Revert\ \") ]] && continue
  if ! [[ "$subject" =~ $RE ]]; then echo "commit-check: $sha: \"$subject\""; bad=1; fi
done <<< "$commits"
if [ -n "${PR_TITLE:-}" ] && ! [[ "$PR_TITLE" =~ $RE ]]; then echo "commit-check: PR title: \"$PR_TITLE\""; bad=1; fi
if [ $bad -ne 0 ]; then
  echo "Use <type>(<optional scope>)!: <summary>, types: ${TYPES//|/, }. See AGENTS.md."
  exit 1
fi
echo "commit-check: ok"
