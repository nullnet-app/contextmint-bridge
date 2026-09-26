# Changelog

## [1.1.0](https://github.com/nullnet-app/contextmint-bridge/compare/v1.0.0...v1.1.0) (2026-09-26)


### Features

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
