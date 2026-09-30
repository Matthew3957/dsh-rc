# Changelog

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
