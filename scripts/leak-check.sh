#!/usr/bin/env bash
# Scan the commits between BASE and HEAD for things that should not land in a public repo:
# real tailnet hostnames, home paths, private IPs, non-noreply author emails, and key-shaped strings.
# Usage: scripts/leak-check.sh [base-ref]   (default origin/main)
# Extra patterns (one extended regex per line) are read from $DSH_RC_PRIVATE_PATTERNS if set,
# so personal names and hosts can be checked locally without committing them.
set -euo pipefail
base="${1:-origin/main}"
range="$base..HEAD"
fail=0

added="$(git diff --unified=0 --no-color "$base"...HEAD -- . ':!public/vendor/*' | grep -E '^\+[^+]' | cut -c2- || true)"

check() { # label, regex
  local hits
  hits="$(printf '%s\n' "$added" | grep -nEi -- "$2" | grep -vEi '<machine>|<tailnet>|example\.(com|org)' || true)"
  if [ -n "$hits" ]; then echo "LEAK? $1:"; printf '%s\n' "$hits" | head -20; fail=1; fi
}

check "tailnet hostname"   '[a-z0-9-]+\.[a-z0-9-]*tail[0-9a-f]+\.ts\.net'
check "home path"          '(/home/|/Users/|C:\\\\Users\\\\)[A-Za-z0-9._-]+'
check "tailscale/LAN IP"   '\b(100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+|10\.[0-9]+\.[0-9]+\.[0-9]+)\b'
check "email address"      '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
check "key-shaped secret"  '(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
check "tailscale auth key" 'tskey-[A-Za-z0-9-]{10,}'

if [ -n "${DSH_RC_PRIVATE_PATTERNS:-}" ] && [ -f "$DSH_RC_PRIVATE_PATTERNS" ]; then
  while IFS= read -r pat; do
    [ -z "$pat" ] || [ "${pat#\#}" != "$pat" ] && continue
    check "private pattern" "$pat"
  done < "$DSH_RC_PRIVATE_PATTERNS"
fi

bad_authors="$(git log --format='%ae%n%ce' "$range" | sort -u | grep -vE '@users\.noreply\.github\.com$|^noreply@github\.com$' || true)"
if [ -n "$bad_authors" ]; then echo "LEAK? commit author/committer email:"; echo "$bad_authors"; fail=1; fi

if [ "$fail" = 0 ]; then echo "leak-check: clean ($range)"; fi
exit "$fail"
