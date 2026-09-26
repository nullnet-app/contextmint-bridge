# @fetchproxy/extension-safari

Safari web-extension resources for **ContextMint Bridge**, the [fetchproxy](https://github.com/chrischall/fetchproxy) browser extension.

Workspace-internal, and **not distributed on its own**. ContextMint's Apple apps
([nullnet-app/mcp-host-app](https://github.com/nullnet-app/mcp-host-app)) embed
these resources in their Safari web-extension appex: the app's build unzips them
straight into the appex's `Resources/`. This package owns no source of its own —
it reuses `extension-chrome`'s esbuild entry points (`../extension-chrome/build-lib.ts`)
and owns only its manifest generator and the `'safari'` platform constant.

## Build

From the repo root:

```sh
npm ci
npm run build --workspace=@fetchproxy/extension-safari      # release: no sourcemaps
npm run build:dev --workspace=@fetchproxy/extension-safari  # inline sourcemaps, for Web Inspector
```

Output lands in `packages/extension-safari/dist/`, with `manifest.json` at the
root — the layout the appex expects:

```
dist/
  manifest.json       generated from ../extension-chrome/manifest.json
  background.js       non-persistent event page (classic script)
  content.js          isolated-world content script
  capture-logger.js   page-main-world bridge; registered at runtime on approved hosts only
  popup.html
  popup.js
  icons/              copied from ../extension-chrome/icons/
```

## How it differs from the Chrome build

Every difference comes from the macOS Safari 27 spike (chrischall/fetchproxy
`docs/superpowers/specs/2026-09-25-contextmint-bridge-chrome-safari-design.md`,
_Spike results — macOS_):

- **Event-page background.** Safari ran the background only as
  `"background": {"scripts": ["background.js"], "persistent": false}`; a
  `service_worker` background never ran.
- **Classic background script.** `background.js` is built with esbuild
  `format: 'iife'` — no top-level `import`/`export`, no `import.meta`.
  `tests/classic-scripts.test.ts` guards it.
- **No `downloads`, no `tabGroups`.** Neither API exists in Safari, so both
  permissions are dropped.
- **`nativeMessaging`** is added (Safari only): the extension asks ContextMint,
  the app that contains it, for the bridge target the user set up there.
- **No manifest `world` key.** Safari does not support it; content scripts run
  in the isolated world by default, and MAIN-world code is registered at
  runtime, which Safari runs.

The manifest is **generated** from Chrome's (`manifest.ts`), so name, version,
icons, popup, content scripts and host permissions cannot drift;
`tests/manifest-parity.test.ts` pins that nothing else changes, and
`tests/manifest-consumer-contract.test.ts` restates the checks mcp-host-app's
build applies to it.

## Signing

This package signs nothing. Safari never runs an ad-hoc-signed web extension:
the containing app and its appex must be signed with an Apple Development (or
distribution) identity, which is mcp-host-app's job.

## Development loop

```sh
npm run build:dev --workspace=@fetchproxy/extension-safari
```

then point mcp-host-app's `BRIDGE_SAFARI_RESOURCES_DIR` at
`packages/extension-safari/dist` and build the app there (its `ios/README.md`
has the signed-build command). Release builds of the app instead download the
`contextmint-bridge-safari-${VERSION}.zip` attached to this repo's GitHub
Releases.
