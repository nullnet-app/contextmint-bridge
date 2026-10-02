# CLAUDE.md — contextmint-bridge

Guidance for Claude working in this repo.

## What this is

**ContextMint Bridge** — the browser extension half of
[fetchproxy](https://github.com/chrischall/fetchproxy). MCP servers built on
`@fetchproxy/server` (and the `fpx` CLI) dial it over a local WebSocket
(`127.0.0.1:37149`, plus any remote `wss://` bridge targets the user
configures), and it performs their authenticated fetches and declared
cookie / storage / IndexedDB / header / GraphQL reads inside the user's
signed-in browser tabs. In the stores it is ContextMint Bridge; the protocol
and the npm packages are fetchproxy.

The extension moved here from `chrischall/fetchproxy` with its git history.
The wire protocol, the MCP-side server, the threat model (`docs/SECURITY.md`)
and the protocol reference (`docs/PROTOCOL.md`) all still live in fetchproxy.

## Packages

| Package                                                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/extension-core` (`@fetchproxy/extension-core`)     | Browser-agnostic business logic: the service worker (`src/background/`), `handleServerHello` (the security-critical pair / auto-trust decision, `src/background/hello.ts`), the trust store and IndexedDB vault, session keys, the content scripts, popup rendering, badge logic. Tested under vitest with mocked `chrome.*` globals. `private`, never published.                                             |
| `packages/extension-chrome` (`@fetchproxy/extension-chrome`) | Thin Chrome MV3 wrapper: esbuild bundling (`build.ts`, over the entry points in `build-lib.ts` that extension-safari reuses), `manifest.json`, icons. Produces `packages/extension-chrome/dist/` for sideloading and the release `.zip`. `private`, never published.                                                                                                                                          |
| `packages/extension-safari` (`@fetchproxy/extension-safari`) | Safari web-extension resources, embedded by ContextMint's Apple apps (nullnet-app/mcp-host-app), never distributed alone. Reuses extension-chrome's esbuild entries (`build-lib.ts`); owns only `manifest.ts` (the Safari manifest GENERATED from Chrome's) and the `'safari'` platform. Produces `packages/extension-safari/dist/` (`manifest.json` at its root). Signs nothing. `private`, never published. |

## Commands

|                                                                 |                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm test`                                                      | `vitest run` over the whole repo, all mocked, no network. Must stay green.                                                                                                                                                                                                                                                                                                                                   |
| `npm run typecheck`                                             | `tsc -b packages/extension-core` (source), then `tsc -p tsconfig.tests.json` (every test file, plus the build scripts — extension-chrome's `build.ts`, `build-lib.ts` and `store-assets/` generator, extension-safari's `build.ts` and `manifest.ts` — and `vitest.config.ts`). vitest does not typecheck, so CI runs this before `npm test`. extension-chrome's source is typechecked by its esbuild build. |
| `npm run build`                                                 | `npm run build --workspaces --if-present`, in npm's alphabetical workspace order: extension-chrome's esbuild bundle (which bundles extension-core from source, so it does not need core built first), extension-core's `tsc -b`, then extension-safari (which reads Chrome's manifest and icons, never its `dist/`).                                                                                         |
| `npm run build --workspace=@fetchproxy/extension-chrome`        | Rebuild just the unpacked extension after a source edit, then reload it in `chrome://extensions/`. **No sourcemaps** — release is the default because this is the command that gets zipped.                                                                                                                                                                                                                  |
| `npm run build:dev --workspace=@fetchproxy/extension-chrome`    | Same with inline sourcemaps, for DevTools. Never what ships.                                                                                                                                                                                                                                                                                                                                                 |
| `npm run build --workspace=@fetchproxy/extension-safari`        | Rebuild just the Safari resources into `packages/extension-safari/dist/` (release, no sourcemaps). `build:dev` adds inline sourcemaps; point mcp-host-app's `BRIDGE_SAFARI_RESOURCES_DIR` at `dist/` to run it inside a signed ContextMint build.                                                                                                                                                            |
| `npm run store-assets --workspace=@fetchproxy/extension-chrome` | Rebuild the extension, then re-render the Chrome Web Store images in `docs/store-assets/` from the real popup in headless Chrome (needs a local Chrome; `CHROME_PATH` overrides). Run it after any popup change and commit the PNGs. Generator in `packages/extension-chrome/store-assets/`, dev-only.                                                                                                       |

## The protocol comes from npm

`@fetchproxy/protocol` is an ordinary npm dependency here (`^3.x`), not a
workspace. **Protocol changes land in `chrischall/fetchproxy` first**, get
published, and only then are consumed here by bumping the dependency. Never
patch frame shapes, validators or crypto locally — every inbound frame is
validated by the published package, and a local fork of the wire format is a
second protocol.

`packages/extension-core/tests/cross-version/v3-fixtures.ts` is a vendored,
frozen protocol-3 recording copied verbatim from fetchproxy's server tests.
Never edit it; re-copy it whole if upstream ever extends the corpus.

CI's `protocol-next` job (`.github/workflows/ci.yml`) re-runs typecheck and
tests against `@fetchproxy/protocol@next` (falling back to `latest` when
fetchproxy has no `next` dist-tag), so an unreleased protocol change shows red
here before it ships. It is not a required check.

## Releases

release-please (`release-please-config.json`, one root `node` package) bumps
every workspace `package.json` and `packages/extension-chrome/manifest.json`
in lockstep (the Safari manifest takes its version from Chrome's at build time;
`tests/release-workflow.test.ts` fails if a `packages/*/package.json` is missing
from `extra-files`) and tags `vX.Y.Z`. On each release `.github/workflows/release-please.yml`
builds `extension-chrome` and `extension-safari` from the tag and attaches
`contextmint-bridge-chrome-${VERSION}.zip`, `contextmint-bridge-safari-${VERSION}.zip`
and a `.sha256` for each to the GitHub Release, never overwriting an asset
already there. Both zips are made from inside `dist/`, so `manifest.json` is at
the zip root — nullnet-app/mcp-host-app unzips the Safari one straight into its
appex's `Resources/`, and downloads it from
`releases/download/v${VERSION}/contextmint-bridge-safari-${VERSION}.zip`, so the
`v` tag prefix and that asset name are a contract. A tag without
`packages/extension-safari` (v1.0.0) attaches Chrome only. If an attach fails
part-way, dispatch the workflow from main with `republish_tag`: assets already
there are left alone and the missing ones are added. Nothing is published to npm.
release-please never rewrites inter-workspace ranges, so extension-chrome depends
on extension-core as `"*"` — a pinned range would stop matching the workspace
after a bump and send `npm ci` to the registry for a package that is never
published.
The bridge's version line is its own (it started at 1.0.0), independent of
fetchproxy's; compatibility is the protocol number, not a version comparison.

## Icons

The extension icons in `packages/extension-chrome/icons/` are copies of the
ContextMint Bridge mark from `chrischall/nullnet-design-system`
(`system/assets/contextmint-bridge-icon-*`), which is the source of truth.
Never redraw or edit them here: change the design system, then re-copy.

## Testing

Tests live in `packages/<pkg>/tests/` (plus root `tests/` for doc guards).
Always mocked: the WebSocket is in-memory, `chrome.*` is stubbed. The
integration test is out of band: load `packages/extension-chrome/dist/`
unpacked, reload it, and make a real call from a fetchproxy-based MCP or `fpx`.

## Hot spots / gotchas

- **MV3 service-worker eviction.** Chrome kills an idle service worker after
  ~30s. `extension-core/src/keepalive.ts` registers a `chrome.alarms` alarm
  every 24s; each tick wakes the worker and re-runs `connect()` (idempotent).
  Without it the bridge silently dies between bursts of MCP traffic.
- **Reloading the extension after a pull is a REQUIREMENT across a protocol
  major**, not hygiene. Chrome keeps running the bundle "Load unpacked"
  loaded, so a pull that crosses a protocol major leaves the old extension
  talking to MCPs on the new protocol — and that pair is refused at the hello,
  not degraded: every call fails with `protocol version mismatch`, naming both
  versions. Rebuild `dist/`, then Reload. `packages/extension-chrome/README.md`
  §Install (developer / sideload) carries this.
- **The hello's `platform` is a build-time define.** extension-core reads it
  through `src/platform.ts` (`currentPlatform()`), which throws when the
  bundle was built without esbuild `define: { __FETCHPROXY_PLATFORM__: … }` —
  there is no `'chrome'` default. Every browser package's `build.ts` must pass
  it on every entry; vitest sets it in `tests/setup/platform.ts`.
- **`chrome.action.openPopup()` is restricted.** It generally needs a recent
  user gesture and only works from an MV3 background on recent Chromes; older
  ones throw sync or async. `background/badge.ts` swallows the failure; the
  **badge** is the reliable surface for a pending pair.
- **Writes prefer a relay tab that can inject `x-csrf-token`.** The content
  script sends the header from `window.__CSRF_TOKEN__`, asked of the MAIN-world
  logger on demand per approved fetch (`readPageCsrfToken` ⇄
  `installCsrfBridge`; never written to the DOM), and only a site's _app_
  pages define that global. `handleFetchRequest` sends non-GETs with
  `requireCsrf` first; a token-less tab answers the typed soft miss
  (`lib/csrf-soft-miss.ts`) and the walk continues; only if EVERY tab misses
  does a second pass re-send without the marker. GETs never walk. If a site
  403s writes through the bridge, check which tab relayed them before
  suspecting the isolated world.
- **Safari runs the background as a non-persistent event page built as a
  classic script.** Keep background code free of top-level await,
  `import.meta` and service-worker-only globals (`self.registration`,
  `clients`, `skipWaiting`) — `extension-safari/tests/classic-scripts.test.ts`
  guards the first two. The Safari manifest is generated from Chrome's
  (`extension-safari/manifest.ts`): never hand-keep a second manifest.
- **Capabilities this browser cannot serve are found by runtime API detection,
  and the servable subset is granted (fetchproxy#418).**
  `extension-core/src/capabilities.ts` (`unavailableCapabilities`) reads which
  `chrome.*` APIs exist — never `currentPlatform()` or a user agent. The
  extension hello lists them (`unavailableCapabilities`, sorted, only when
  non-empty, so Chrome's wire is unchanged). `handleServerHello` subtracts them
  from what the MCP declared, after the signature check and before trust: the
  pair prompt, the trust record (`approval.ts` filters too), the auto-trust
  grant and any scope-update offer see only the servable set, and the popup
  shows the rest greyed as "not available in this browser". Only an MCP of
  which NOTHING is servable is refused, with the stable reason
  `unsupported-capability: <sorted, comma-separated> (not available in this browser)`.
  `handlers/dispatch.ts` checks availability per request BEFORE the grant (so
  the answer never says "not granted") and answers
  `code: 'capability_unavailable'` with `capabilityUnavailableMessage()` from
  `@fetchproxy/protocol`, from its own probe — never from anything on the wire.
  A new capability whose API can be absent in some browser MUST be added to
  `capabilities.ts`, or it is treated as always available.
- **Safari takes a bridge target from ContextMint over native messaging.**
  `extension-core/src/native-handoff.ts` implements nullnet-app/mcp-host-app
  `docs/BRIDGE-HANDOFF.md` (that contract wins over any summary here): at each
  wake, on a 5-minute `contextmint-handoff` alarm, and when the link opens or
  drops. It runs only where `sendNativeMessage` exists (the Safari manifest's
  `nativeMessaging`), so Chrome is inert. The handed-off target is a
  `contextmint:<brt id>` link held IN MEMORY beside the vault's targets
  (`background/socket.ts` `setHandoffTarget`), re-validated like a typed-in
  one, never persisted or logged, and shown read-only in the popup.
- **A page load on an approved site wakes the background** (contextmint-bridge#32,
  for mcp-host-app's iOS "Refresh from Safari"). `page-load-wake.js` is
  registered at runtime beside the MAIN-world bridge, on the same approved-host
  patterns (`syncMainWorldBridgeFromTrust` keeps both), never in the manifest:
  waking Safari's event page runs boot, and boot runs the hand-off, so a
  manifest `<all_urls>` wake would lift on every site. The background still
  judges each wake by the browser's `sender` (tab, top frame, approved host;
  `background/page-load-wake.ts`), and `createWakeLift` joins a lift in flight
  and never repeats one while its link is open or dialling, nor within 30 s.
  Boot's own "at every wake" run goes through the same lift.
- **Account pairing starts at the extension popup.** The person chooses a
  configured gateway and browser name; the background signs a Connect request,
  opens that gateway's Connect page, and accepts its approval only from the
  exact tab, top frame, URL, origin, request and unexpired one-time approval
  (background/bridge-connect.ts). The resulting credential is saved only
  through the vault. The popup has no token-paste form or standalone browser
  confirmation action. For Chrome, enterprise policy may extend the default
  gateway through chrome.storage.managed.bridgeConnectOrigins; the schema is
  packages/extension-chrome/managed-schema.json, and both the background and
  relay validate origins before use. The native ContextMint hand-off remains a
  separate, in-memory path for Safari.
- **A refused remote browser is not retried forever.** A 4004
  EXTENSION_MISMATCH close stops that link for good (link.refusal, shown in
  the popup); only a new credential creates a fresh link. A 4005
  ACCOUNT_CONFIRMED or 4006 FACTS_CHANGED close re-dials at once, at most
  once per five seconds, then uses normal backoff. The immediate re-dial does
  not reset the backoff; only an open does.
- **Only the background initialises the vault** (fleet-audit #1001). Boot
  calls `claimVaultOwnership()`; every other context (the popup) is a reader:
  on an empty vault it sends `ensure-vault` to the background and never mints,
  imports or purges, because only the background sees `onInstalled` and can
  tell an upgrade from a fresh install. Unit tests run as the owner
  (`tests/setup/vault-owner.ts`); reader tests switch with
  `__setVaultRoleForTests`.
- **A lost vault is announced, not silently replaced** (fleet-audit #1002).
  The owner leaves `vaultInitialisedAt` (a bare timestamp) in `storage.local`,
  which IndexedDB eviction does not touch; an empty vault beside it records
  `vaultLoss`, and the popup shows "Pairings were reset" until it is dismissed.
  It is a tripwire, never an authorisation: content scripts can write it.
  Eviction is prevented by the manifest's `unlimitedStorage` (no permission
  warning; Safari passes it through but reportedly ignores it for IndexedDB)
  plus `navigator.storage.persist()` (popup, and any background that has it).
- **Multi-domain tab opening — every declared domain, one tab each.**
  `background/server-hello.ts` and `background/approval.ts` both loop over
  `result.domains` calling `ensureDomainTab(d)` fire-and-forget. The fan-out is
  why the cold-open registry (`lib/cold-open.ts`) is keyed by HOST rather than
  by "something is opening": one domain loading must not make a request for a
  different one wait, or be told a tab is arriving for it.

## What not to do

- Don't introduce new `chrome.*` API usage without adding the permission to
  `packages/extension-chrome/manifest.json` AND documenting it in
  `packages/extension-chrome/README.md`'s manifest highlights (and in
  `docs/store-assets/permission-justifications.md` for the store listing).
  A permission only Safari needs goes in `extension-safari/manifest.ts`, never
  in Chrome's manifest, and its justification says "Safari only".
- Don't put anything security-relevant in `chrome.storage.local` — every
  site's content script can read AND write it. Keys, trust records, remote
  bridge targets and dismissed scope hashes live in the extension-origin
  IndexedDB vault (`extension-core/src/vault.ts`, reached through
  `TrustStore` / `vault-records.ts` / `loadOrCreateExtensionIdentity`); the
  pairing queue lives in `storage.session`. `vault-migration.ts` is the only
  reader of the legacy `storage.local` keys, and only once. The identity
  keeps NO X25519 private key (protocol 4 never uses one; the X25519 pub is
  only the handle pairings are pinned to), so its vault record holds no X25519
  `CryptoKey` — the one thing WebKit's IndexedDB silently nulls — and is the
  same in every browser. Don't reintroduce one; `identity-storage.ts` only
  strips the private material earlier versions kept.
- Don't make `handleServerHello` impure. It is the security-critical decision
  point and stays under unit-test discipline.
