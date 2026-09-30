# Working on dsh-rc

This repo is public. Everything committed here is published.

- Never push to `main`. Branch, open a pull request, and merge only after the `leak-check`
  workflow passes and the diff has been read for private data.
- Run `scripts/leak-check.sh` before pushing. Commit with a GitHub no-reply email.
- Use placeholders in docs and examples: `<machine>.<tailnet>.ts.net`, `<profile>`, `%h` in units.
- No hostnames, IPs, home paths, emails, keys, session ids or screenshots of a real instance.
- Third-party code goes in `public/vendor/` with its license header intact. No CDN scripts.
