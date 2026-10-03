# Changelog

## [1.4.2](https://github.com/nullnet-app/contextmint-bridge/compare/v1.4.1...v1.4.2) (2026-10-02)


### Bug Fixes

* **vault:** never let the popup reset pairings, and announce a lost vault ([#56](https://github.com/nullnet-app/contextmint-bridge/issues/56)) ([8228f93](https://github.com/nullnet-app/contextmint-bridge/commit/8228f933c0dafd2784d393952e67b62fb24d602a))
* **vault:** request unlimitedStorage so pairing keys are not evicted ([#59](https://github.com/nullnet-app/contextmint-bridge/issues/59)) ([3dbd5d0](https://github.com/nullnet-app/contextmint-bridge/commit/3dbd5d03aef48776df0ac1c110b892c5612f4346))

## [1.4.1](https://github.com/nullnet-app/contextmint-bridge/compare/v1.4.0...v1.4.1) (2026-10-02)


### Documentation

* **store-assets:** name the popup's real Connect button in the listing ([#54](https://github.com/nullnet-app/contextmint-bridge/issues/54)) ([b226279](https://github.com/nullnet-app/contextmint-bridge/commit/b226279c984991e26b15c848debfb166ff5c035e)), closes [#43](https://github.com/nullnet-app/contextmint-bridge/issues/43)

## [1.4.0](https://github.com/nullnet-app/contextmint-bridge/compare/v1.3.0...v1.4.0) (2026-09-30)


### Features

* **extension-core:** add account labels and approval notices ([#49](https://github.com/nullnet-app/contextmint-bridge/issues/49)) ([0314bdc](https://github.com/nullnet-app/contextmint-bridge/commit/0314bdc4dfde2abeafcd56b91d0264c37066a43b))
* **extension-core:** honor account attestations in hello decisions ([#47](https://github.com/nullnet-app/contextmint-bridge/issues/47)) ([6e9f9d2](https://github.com/nullnet-app/contextmint-bridge/commit/6e9f9d260c09f266289e2e1339fd0a430cadcdf7))
* **extension-core:** store trusted accounts in vault ([#44](https://github.com/nullnet-app/contextmint-bridge/issues/44)) ([4737078](https://github.com/nullnet-app/contextmint-bridge/commit/4737078711cd4184c1c922de541fb32ef7fe2c6c))
* **extension:** connect browser pairing from the popup ([#39](https://github.com/nullnet-app/contextmint-bridge/issues/39)) ([bb2ef10](https://github.com/nullnet-app/contextmint-bridge/commit/bb2ef10d4d80118aaf9132c14805c44531b5e7ee))


### Bug Fixes

* **extension-core:** clean account derived records on token removal ([#46](https://github.com/nullnet-app/contextmint-bridge/issues/46)) ([08de409](https://github.com/nullnet-app/contextmint-bridge/commit/08de409bb728ba5d8490b6fc63e5160b038ed90d))
* **extension-core:** finish account-forget follow-ups ([#51](https://github.com/nullnet-app/contextmint-bridge/issues/51)) ([8b8a7b7](https://github.com/nullnet-app/contextmint-bridge/commit/8b8a7b78cfbfc388275168983d5d07997eeddbbe))


### Documentation

* **extension:** retire obsolete pairing flows ([#42](https://github.com/nullnet-app/contextmint-bridge/issues/42)) ([ff1d54d](https://github.com/nullnet-app/contextmint-bridge/commit/ff1d54d2b96b1e4088af8f0b735f83777e611d39))

## [1.3.0](https://github.com/nullnet-app/contextmint-bridge/compare/v1.2.0...v1.3.0) (2026-09-28)


### Features

* **extension-core:** wake on a page load of an approved site, so a Safari session refresh runs in one tap ([#36](https://github.com/nullnet-app/contextmint-bridge/issues/36)) ([7a8d867](https://github.com/nullnet-app/contextmint-bridge/commit/7a8d8672ce6ee8f05400191fdfd5c8cf4810d5bf)), closes [#32](https://github.com/nullnet-app/contextmint-bridge/issues/32)


### Bug Fixes

* **extension-core:** stop a page-load wake from waiting forever when boot fails, and pin its sender check ([#38](https://github.com/nullnet-app/contextmint-bridge/issues/38)) ([b83e685](https://github.com/nullnet-app/contextmint-bridge/commit/b83e685da8c23d7866d514eaf33a178f4b8705ca))

## [1.2.0](https://github.com/nullnet-app/contextmint-bridge/compare/v1.1.1...v1.2.0) (2026-09-27)


### Features

* **extension-core:** bind the extension identity at redeem and on connect ([#33](https://github.com/nullnet-app/contextmint-bridge/issues/33)) ([0909586](https://github.com/nullnet-app/contextmint-bridge/commit/0909586aba5d5365438d32841c4a4bf7aef055b8))
* **extension-core:** confirm this browser for its account from the popup ([#35](https://github.com/nullnet-app/contextmint-bridge/issues/35)) ([d23a759](https://github.com/nullnet-app/contextmint-bridge/commit/d23a759b42d7021eecefb570d1176f0909ebf396))

## [1.1.1](https://github.com/nullnet-app/contextmint-bridge/compare/v1.1.0...v1.1.1) (2026-09-27)


### Bug Fixes

* **safari:** keep the extension description within the App Store's 112-character limit ([#31](https://github.com/nullnet-app/contextmint-bridge/issues/31)) ([4800925](https://github.com/nullnet-app/contextmint-bridge/commit/48009251ac19ba48f5b5609e2c7d73d4561c4bfa))


### Documentation

* **plan:** record the second live Safari check ([#26](https://github.com/nullnet-app/contextmint-bridge/issues/26)) ([d614c31](https://github.com/nullnet-app/contextmint-bridge/commit/d614c310f5d42d883255fdd0c7745a0ba0b9d98e))
* **store:** Chrome Web Store listing assets for ContextMint Bridge ([#29](https://github.com/nullnet-app/contextmint-bridge/issues/29)) ([f709642](https://github.com/nullnet-app/contextmint-bridge/commit/f709642058486d39063560b6dfa3c665d7a61709))

## [1.1.0](https://github.com/nullnet-app/contextmint-bridge/compare/v1.0.0...v1.1.0) (2026-09-27)


### Features

* **extension:** grant the capabilities this browser can serve instead of refusing the MCP ([#25](https://github.com/nullnet-app/contextmint-bridge/issues/25)) ([9d5f0fc](https://github.com/nullnet-app/contextmint-bridge/commit/9d5f0fc961988ec472031a09cafe60b31cb48339))
* **extension:** refuse capabilities this browser cannot serve when an MCP says hello ([#18](https://github.com/nullnet-app/contextmint-bridge/issues/18)) ([da9f889](https://github.com/nullnet-app/contextmint-bridge/commit/da9f88955dd0bb4f41b874196c283d837efc9ace))
* **safari:** build ContextMint Bridge as a Safari web extension ([#15](https://github.com/nullnet-app/contextmint-bridge/issues/15)) ([939cf33](https://github.com/nullnet-app/contextmint-bridge/commit/939cf331f053b3ef0a4366e2989b4e47e97ef906))
* **safari:** take the ContextMint bridge target from the app ([#22](https://github.com/nullnet-app/contextmint-bridge/issues/22)) ([bfbb444](https://github.com/nullnet-app/contextmint-bridge/commit/bfbb44422cd9bccff57505059c83354c6a98b14f))


### Bug Fixes

* **extension:** give each ContextMint hand-off failure its own advice ([#23](https://github.com/nullnet-app/contextmint-bridge/issues/23)) ([44ad014](https://github.com/nullnet-app/contextmint-bridge/commit/44ad0143cc93ceab62f6bcef00d3420dcfdb9e3e))
* **extension:** keep the identity keys where Safari's IndexedDB can hold them ([#11](https://github.com/nullnet-app/contextmint-bridge/issues/11)) ([04bdf0e](https://github.com/nullnet-app/contextmint-bridge/commit/04bdf0e2e7b11065d3a9defd1a517d0687f26dc4))
* **extension:** stop keeping the unused X25519 private key ([#21](https://github.com/nullnet-app/contextmint-bridge/issues/21)) ([3eec5c4](https://github.com/nullnet-app/contextmint-bridge/commit/3eec5c4e95ad198921232c6966e5c443498b114d))
* **safari:** require Safari 27, the version the build was proven on ([#20](https://github.com/nullnet-app/contextmint-bridge/issues/20)) ([5f9f9b6](https://github.com/nullnet-app/contextmint-bridge/commit/5f9f9b63ceb8f2189bd43154a89be2efbd28c6e1))


### Refactor

* **extension:** make the hand-off advice mapping exhaustive ([#24](https://github.com/nullnet-app/contextmint-bridge/issues/24)) ([d120e31](https://github.com/nullnet-app/contextmint-bridge/commit/d120e31f72e3c0ba82689836b9facd6048d0961d))
* **extension:** share the esbuild entry points between browser builds ([#13](https://github.com/nullnet-app/contextmint-bridge/issues/13)) ([3d4cf33](https://github.com/nullnet-app/contextmint-bridge/commit/3d4cf333dd3460f6f608076a18ec8d76c572a559))


### Documentation

* **claude:** name every build script the tests typecheck covers ([#19](https://github.com/nullnet-app/contextmint-bridge/issues/19)) ([f691063](https://github.com/nullnet-app/contextmint-bridge/commit/f691063cdb66ff2154d4471bac55aff0654a4cde))
* **plan:** the Safari target for ContextMint Bridge ([#9](https://github.com/nullnet-app/contextmint-bridge/issues/9)) ([b407322](https://github.com/nullnet-app/contextmint-bridge/commit/b407322c06a71d1a8816a6bd1917531afbe3dc13))

## 1.0.0 (2026-09-25)


### Features

* **extension:** rename the extension to ContextMint Bridge ([#2](https://github.com/nullnet-app/contextmint-bridge/issues/2)) ([a1b3b7a](https://github.com/nullnet-app/contextmint-bridge/commit/a1b3b7a145c3798ff7d2d94c9f4571f0625b2a7c))
* **extension:** use the ContextMint Bridge icon ([#6](https://github.com/nullnet-app/contextmint-bridge/issues/6)) ([72a11e4](https://github.com/nullnet-app/contextmint-bridge/commit/72a11e428d05f51d8ee0a93572315982969c4ae1))


### Bug Fixes

* **extension:** call chrome APIs bound so Safari's tabs.query returns tabs ([#7](https://github.com/nullnet-app/contextmint-bridge/issues/7)) ([17dead7](https://github.com/nullnet-app/contextmint-bridge/commit/17dead752c9049d3aca66c45c4c984eb58a148c2))


### Refactor

* **extension:** take the hello's platform from the build target ([#1](https://github.com/nullnet-app/contextmint-bridge/issues/1)) ([da4d5c8](https://github.com/nullnet-app/contextmint-bridge/commit/da4d5c8183ca99e9de8cacff132230407bc8552c))


### Documentation

* add a CLAUDE.md for the bridge repo ([51c1345](https://github.com/nullnet-app/contextmint-bridge/commit/51c1345cafeb38800db70d3c26b88175415ddf4c))
* qualify the remaining chrischall/fetchproxy path references ([f540255](https://github.com/nullnet-app/contextmint-bridge/commit/f54025508b92dd63be1f3b92109c3301c6926ba1))
