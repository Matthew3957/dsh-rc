# Working on dsh-rc

This repo is public. Everything committed here is published.

- Never push to `main`. Branch, open a pull request, and merge only after the `leak-check`
  workflow passes and the diff has been read for private data.
- Run `scripts/leak-check.sh` before pushing. Commit with a GitHub no-reply email.
- Use placeholders in docs and examples: `<machine>.<tailnet>.ts.net`, `<profile>`, `%h` in units.
- No hostnames, IPs, home paths, emails, keys, session ids or screenshots of a real instance.
- Third-party code goes in `public/vendor/` with its license header intact. No CDN scripts.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), checked in CI on every commit and on
the PR title (`scripts/commit-check.sh`). PRs merge by rebase, so each commit lands on `main` as
written.

    <type>(<optional scope>)!: <summary>

- Types: `feat` (new behavior), `fix` (bug fix), `perf`, `refactor`, `docs`, `style`, `test`,
  `build`, `ci`, `deps`, `chore`, `revert`.
- Scope is optional, lowercase, one word for the area: `ui`, `server`, `push`, `proxy`, `auth`,
  `queue`, `status`.
- Summary: imperative, lowercase start, no trailing period, under 100 characters.
- `!` after the type, plus a `BREAKING CHANGE:` line in the body, for anything that breaks an
  existing setup (a new required flag, a changed URL, a removed option).
- Put the issue in the body: `Closes #12`.

`feat` and `fix` are what release-please turns into a version bump and a changelog entry, so
pick them only for changes a user would notice.

Examples:

    feat(queue): edit or remove queued messages
    fix(ui): keep the copy button label on a double tap
    feat(proxy)!: serve as a standalone front door with passphrase login
