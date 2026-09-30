# Changelog

## [0.3.0](https://github.com/Matthew3957/dsh-rc/compare/v0.2.0...v0.3.0) (2026-09-30)


### Features

* **ui:** complete [@file](https://github.com/file) mentions from the session folder ([b27b800](https://github.com/Matthew3957/dsh-rc/commit/b27b800c1349138d03d4454d97032c4a1728ef96)), closes [#9](https://github.com/Matthew3957/dsh-rc/issues/9)
* **ui:** dictate the composer with the browser's Web Speech API ([efc4f6d](https://github.com/Matthew3957/dsh-rc/commit/efc4f6d4f6015f3def93fd2da91f5a73a5fdf36f)), closes [#33](https://github.com/Matthew3957/dsh-rc/issues/33)
* **ui:** fork, export and archive a session from the menu ([82108de](https://github.com/Matthew3957/dsh-rc/commit/82108de57649a144d9823f9b79b6fb5b827dc27a)), closes [#11](https://github.com/Matthew3957/dsh-rc/issues/11)
* **ui:** show the tunnel URL as a QR code in the terminal and on the page ([18069ce](https://github.com/Matthew3957/dsh-rc/commit/18069ce02d443ec72a6d15409c0b997f32db50e5)), closes [#34](https://github.com/Matthew3957/dsh-rc/issues/34)
* **ui:** simplify the session list with one row per session and floating actions ([1f53e91](https://github.com/Matthew3957/dsh-rc/commit/1f53e915c5060649b488f910f0e6f7e983f3dfff)), closes [#45](https://github.com/Matthew3957/dsh-rc/issues/45)


### Bug Fixes

* **ui:** archive guard covers live subagents, guard the remaining action calls, grow-only archive set ([e0c1149](https://github.com/Matthew3957/dsh-rc/commit/e0c1149246c5b908642a4b11ebc6ff4e5115019c))
* **ui:** credit the QR encoder's source, guard it, and draw whole pixels per module ([c6fa5b8](https://github.com/Matthew3957/dsh-rc/commit/c6fa5b8c3cba0984b0ef86b689e0a73fb582d097))
* **ui:** guard session actions, export inside the tap, never archive a working session ([78b1f55](https://github.com/Matthew3957/dsh-rc/commit/78b1f5507dec7ba9a764164d25a2959f240716e2))
* **ui:** list menu shows the dsh web UI link only where it exists, and handles a failed push-state check ([9d45c2f](https://github.com/Matthew3957/dsh-rc/commit/9d45c2f00d4585cd13bf4aa54883149ff29f885a))
* **ui:** re-check the mention at the caret before inserting, guard list entries ([e77b937](https://github.com/Matthew3957/dsh-rc/commit/e77b93710ace2714c7ac9520caeb7b66566b9127))
* **ui:** say when dsh is too new or unreachable, and stop reading dsh's 401 as a login expiry ([f82aa84](https://github.com/Matthew3957/dsh-rc/commit/f82aa848fac9e29226e725381dd88646bca38e8a)), closes [#12](https://github.com/Matthew3957/dsh-rc/issues/12)
* **ui:** show Running now progress bars by default and tighten text sizes ([78111b9](https://github.com/Matthew3957/dsh-rc/commit/78111b98c5c9acba0b291278a8cc42f6546dffc2))


### Documentation

* **readme:** add screenshots from a mock dsh with demo sessions ([ca1435a](https://github.com/Matthew3957/dsh-rc/commit/ca1435afd1dd00d8e24865380117068d4861ba5c)), closes [#13](https://github.com/Matthew3957/dsh-rc/issues/13)
* **readme:** regenerate screenshots for the simpler list, and harden the screenshot tooling ([1b4b4df](https://github.com/Matthew3957/dsh-rc/commit/1b4b4df8625dd1bbfebb72a7763ac5d8f04a1e32))


### Tests

* **scripts:** add an RPC smoke test for the methods the page calls ([d1c2ee2](https://github.com/Matthew3957/dsh-rc/commit/d1c2ee23aa796b2b9fa763525176b88cf0de05a2)), closes [#15](https://github.com/Matthew3957/dsh-rc/issues/15)
* **scripts:** probe fileReferences/list in the smoke test ([98fc6c9](https://github.com/Matthew3957/dsh-rc/commit/98fc6c96f6e6726c3184633bda24badbd80fead2))

## [0.2.0](https://github.com/Matthew3957/dsh-rc/compare/v0.1.0...v0.2.0) (2026-09-30)


### ⚠ BREAKING CHANGES

* **proxy:** in standalone mode dsh must be started with --trusted-host dsh-rc.internal. The proxy presents that Host instead of a loopback one, because dsh keeps settings, credentials and host.openPath for loopback Hosts only.

### Features

* **proxy:** serve as a standalone front door with passphrase login, quick tunnel and HTTPS ([10f91d1](https://github.com/Matthew3957/dsh-rc/commit/10f91d1bc27c924e1601dde8aeb38711796c36c6)), closes [#4](https://github.com/Matthew3957/dsh-rc/issues/4)
* **push:** name a plan-mode review "Plan ready for review" with its heading ([277bfca](https://github.com/Matthew3957/dsh-rc/commit/277bfcada6f761ad416940e11ff06bac0144006a)), closes [#6](https://github.com/Matthew3957/dsh-rc/issues/6)
* **status:** add a session status line with model, context fill, tokens and estimated cost ([d5708d6](https://github.com/Matthew3957/dsh-rc/commit/d5708d6434eab39fe18b7ccab54d516a0c031852)), closes [#3](https://github.com/Matthew3957/dsh-rc/issues/3)
* **ui:** add a running now dashboard for active sessions ([b59a07f](https://github.com/Matthew3957/dsh-rc/commit/b59a07fae1a8be27a8766f52b69face9799cbb60)), closes [#5](https://github.com/Matthew3957/dsh-rc/issues/5)
* **ui:** review the work with diffs, turn summaries and plan approval cards ([38c6685](https://github.com/Matthew3957/dsh-rc/commit/38c668584f011d4cdfeed907fe7406cb871a1a13)), closes [#6](https://github.com/Matthew3957/dsh-rc/issues/6)


### Bug Fixes

* **ci:** fail commit-check when the base can't be resolved; cap summary under 100 ([577eb3c](https://github.com/Matthew3957/dsh-rc/commit/577eb3cee6dc64fc1d6371ec91839a472f25db75))
* **ci:** pass base_ref through env and neutralize workflow commands in echoed subjects ([a4da112](https://github.com/Matthew3957/dsh-rc/commit/a4da11245089a08cece6997d6150132a21807149))
* **ci:** pin release-please-action to a commit SHA ([d81e6bc](https://github.com/Matthew3957/dsh-rc/commit/d81e6bcadc9e3f734e63b9c43c4fc912f1f0a96d))
* **ci:** serialize release-please runs and document the token tradeoff ([ed6e21b](https://github.com/Matthew3957/dsh-rc/commit/ed6e21b4c83b68db619fb2d509a9ec7485c4e02e))
* **ui:** bound diff work on huge files and leave interrupted edits out of turn summaries ([e643c92](https://github.com/Matthew3957/dsh-rc/commit/e643c9280a177e1eadc0a727830b0c1e890ed596))
* **ui:** honest marks for commands with no result, one plan-review rule, keep the plan feedback box ([6cd9031](https://github.com/Matthew3957/dsh-rc/commit/6cd90319ec9fe5467454180384a88ca8a60fbe3f))
* **ui:** name the right host in the 403 card behind the proxy ([ca7c3cd](https://github.com/Matthew3957/dsh-rc/commit/ca7c3cd51ad6a81a3a4c8a0adbe2cef5b5b09b60))


### Documentation

* Node setup, notifications section, unit; drop roadmap item ([e6609e0](https://github.com/Matthew3957/dsh-rc/commit/e6609e02392e89e48161d1c4bd715903a79841cd))


### Tests

* cover notify mapping, static server, push validation ([ac0749d](https://github.com/Matthew3957/dsh-rc/commit/ac0749d9ff9be689ebfd3b02e2c17ec79c81deef))


### Continuous Integration

* add release-please for versioned releases and a changelog ([4e2c03a](https://github.com/Matthew3957/dsh-rc/commit/4e2c03accadeb4fd85ed2fe515aec69bd4955930))
* enforce Conventional Commits on commits and PR titles ([b66ec8c](https://github.com/Matthew3957/dsh-rc/commit/b66ec8c30abd35e98bbb556d72a797d59181b1d7))
