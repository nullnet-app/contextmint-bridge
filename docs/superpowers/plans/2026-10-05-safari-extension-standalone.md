# ContextMint Bridge for Safari as its own App Store app (implementation plan)

**Goal (owner, 2026-10-05).** A person installs ContextMint Bridge entirely from
Safari: **Safari → Settings → Extensions → More Extensions…** (macOS) or **Settings →
Apps → Safari → Extensions → More Extensions** (iOS) opens the App Store, they get
"ContextMint Bridge", turn it on, and pair it from the popup's **Connect**. They do not
need the ContextMint app at all, and the extension never calls it at runtime.

**The constraint we can't avoid.** Apple requires every Safari web extension to ship
inside a containing app ("Safari web extensions need to be packaged within a containing
app", WWDC26 session 216). So "no app" really means **one dedicated, close-to-empty
container app with its own App Store listing.** It **replaces** the copy that
nullnet-app/mcp-host-app embeds today (appex `app.nullnet.mcphost.bridge`); we don't
run both.

**What this reverses.** chrischall/fetchproxy
`docs/superpowers/specs/2026-09-25-contextmint-bridge-chrome-safari-design.md`,
*Decisions* 1 and *Safari: signing, distribution, release* ("Safari ships inside
ContextMint … There is no standalone ContextMint Bridge Apple app"). Task 9 records the
reversal there.

**Why now is cheap.** Most of the coupling is already gone:

- **Pairing doesn't go through the app.** Connect starts in the popup and
  authenticates against the gateway (`background/bridge-connect.ts`).
  mcp-host-app `docs/BRIDGE-HANDOFF.md` retired the native hand-off on 2026-09-29.
  Its appex now answers every `bridge-target` with `{"error":"retired"}`, which
  `native-handoff.ts` parses as `malformed`. That means today's extension logs "update
  the ContextMint app…" every 5 minutes, which is advice that no longer applies.
- **The iOS appex has never shipped.** `McpHostBridgeIOS` is built in CI but isn't
  embedded (mcp-host-app `ios/project.yml`; that repo's iOS plan T6, gated on owner
  steps O1–O4). iOS has nothing to migrate.
- **Only macOS has an embedded copy:** `McpHostMac` embeds `McpHostBridge` and ships it
  to TestFlight on every mcp-host-app tag (`deploy-testflight-mac.yml`). The pin is
  `ios/bridge.lock.json` = 1.4.0.
- **The bundle IDs are free.** `app.nullnet.contextmint.bridge[.extension]` was proposed
  and withdrawn on 2026-09-25 and never registered (spec decision 1).

---

## Decisions this plan makes (owner may overrule before T1)

### D1 — Packaging: a checked-in XcodeGen project in this repo, generated once from Apple's template

| Option | Verdict |
| --- | --- |
| **App Store Connect's Safari Web Extension Packager** (web: upload the extension zip, Apple builds and signs the container) | **No for steady state.** It's a person in a web UI on every release. As far as we know it has no API we can drive from CI (**unverified**; check it during O3). We can't run it on our runner, can't diff or review the container it builds, and its version and build numbers are typed by hand, not taken from release-please. Keep it as the **fallback**: if App Review rejects our container under 4.2, Apple's own generated container is the strongest answer. |
| **`xcrun safari-web-extension-packager` CLI at every build** | **No.** It regenerates a whole Xcode project each run, so nothing in it is reviewable or stable between releases, and every customisation (entitlements, privacy manifest, icon, copy) would have to be re-applied by script. |
| **Generate once with the packager CLI, then check in an XcodeGen `project.yml` + sources under `apple/`** | **Yes.** |

Why the checked-in project:

- **Reproducible CI on the self-hosted Mac.** It's the same toolchain and pattern
  mcp-host-app already runs (`xcodegen generate` → `xcodebuild archive` → export →
  `asc` upload) on the same `[self-hosted, macOS]` runner. The `.xcodeproj` isn't
  checked in, as in mcp-host-app.
- **The resources come from the tagged tree.** The appex's build phase runs
  `npm run build --workspace=@fetchproxy/extension-safari` and copies `dist/` in. There's
  no zip download and no SHA pin, because the extension and the container are the same
  commit.
- **Signing.** Manual signing with profiles resolved by name, and no
  `-allowProvisioningUpdates`, which mirrors `deploy-testflight-mac.yml` difference 2.
  The certificates are the fleet's shared Apple Distribution certificate and the Mac
  installer certificate, which are already nullnet org secrets.
- **Versioning.** `MARKETING_VERSION` in `apple/project.yml` carries an inline
  `x-release-please-version` and joins `release-please-config.json` `extra-files`. The
  container, the appex and `manifest.json` therefore always carry the extension's
  release version, as App Store validation requires. `CURRENT_PROJECT_VERSION` is the
  deploy workflow's `run_number*100+run_attempt`, and release-please never touches it.
- **Universal purchase.** One App Store Connect record with iOS and macOS platforms. Both
  platforms' containers share one bundle ID, and both appexes share one bundle ID (D2).
  It's one `project.yml` with an iOS and a macOS target pair, laid out like
  mcp-host-app's `McpHostBridge` / `McpHostBridgeIOS`: two targets, because xcodegen's
  multi-platform form renames them.

### D2 — Identifiers

| What | Bundle ID | Platforms |
| --- | --- | --- |
| Container app | `app.nullnet.contextmint.bridge` | iOS + macOS (one ASC record, universal purchase) |
| Safari web extension (appex) | `app.nullnet.contextmint.bridge.extension` | iOS + macOS |

- **No App Group, no keychain access group, no restricted entitlement.** Nothing passes
  between the container and the appex. The extension's state lives in Safari's own
  extension storage (the IndexedDB vault). The entitlements are just the App Sandbox on
  both macOS targets (Mac App Store, and Safari appexes must be sandboxed), and nothing
  on iOS.
- **No App ID capabilities at all.** With none, there are no capability-change profile
  invalidations, and the profiles are plain ones.
- The appex keeps a `SafariWebExtensionHandler` principal class because the extension
  point requires one. It's a stub that answers nothing. The manifest drops
  `nativeMessaging` (T2), so Safari never routes a message to it.

### D3 — No runtime link to the ContextMint app

The extension stops using native messaging entirely (T2). The account's own presence API
already gives the ContextMint app its "is Safari connected" view (mcp-host-app
`docs/BRIDGE-HANDOFF.md`, "owner-only presence API"), so nothing on either side needs
the hand-off back.

---

## Owner steps (Apple account work no task may do)

Every `asc` call uses `--profile Nullnet`, team `5A673K24X6`. Each step has a read-only
check a task runs first. If the step isn't done, that task stops at it.

- **O1 — Register the two bundle IDs** `app.nullnet.contextmint.bridge` ("ContextMint
  Bridge") and `app.nullnet.contextmint.bridge.extension` ("ContextMint Bridge
  Extension"), both platform *universal*, with **no capabilities**. Check:
  `asc bundle-ids list --profile Nullnet` shows both.
- **O2 — Create the App Store Connect record.** Name **ContextMint Bridge** (reserve it
  first: the name must be free on the App Store). Bundle ID
  `app.nullnet.contextmint.bridge`. Add both the iOS and macOS platforms. SKU
  `contextmint-bridge`. Choose the primary category in the store listing; see T6 and Q3
  for whether "Safari Extensions" is selectable. There's no API for creating a record.
- **O3 — Profiles, by exact name.** App Store distribution:
  `ContextMint Bridge iOS App Store`, `ContextMint Bridge Extension iOS App Store`,
  `ContextMint Bridge Mac App Store`, `ContextMint Bridge Extension Mac App Store`.
  Development, for the owner's signed local builds (this Mac's UDID, plus the iPhone
  for iOS checks): `ContextMint Bridge Mac Dev`, `ContextMint Bridge Extension Mac Dev`,
  and the iOS pair if T8's iOS checks run on a device. All are bound to the existing
  shared distribution certificate and the CI dev certificate (memory:
  `nullnet Apple signing`). While you're in App Store Connect, look at the web Safari
  Web Extension Packager and note whether it has an API (D1's fallback).

  **As created (2026-10-05):** the macOS *container* profiles are named
  `ContextMint Bridge App Mac App Store` and `ContextMint Bridge App Mac Dev`, because
  `ContextMint Bridge Mac App Store` / `ContextMint Bridge Mac Dev` already sign
  ContextMint for Mac's embedded appex (`app.nullnet.mcphost.bridge`) and must not be
  touched until T7. Every other name is as above. T5's workflow and
  `apple/tools/testflight-preflight.ts` use these names. The App Store Connect key
  secret is `ASC_PRIVATE_KEY_B64` (not `ASC_KEY_P8_B64`, as O4 says), as in
  mcp-host-app.
- **O4 — `testflight` GitHub environment in nullnet-app/contextmint-bridge**, with a
  deployment branch policy of `main` + `v*` tags and no reviewers, matching
  mcp-host-app's. A workflow that names an environment that doesn't exist **creates**
  it with no policy, so this must exist before T5 merges. The nullnet org secrets
  (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_B64`, `DIST_CERT_P12_B64`/password,
  `MAC_INSTALLER_CERT_P12_B64`/password) have `visibility=all`, so the repo already sees
  them. Confirm by listing the org secrets' names and visibility (`gh secret list
  --org nullnet-app`).
- **O5 — App Privacy, age rating, export compliance, privacy policy and support URLs**
  in App Store Connect, from the answers T6 writes.
- **O6 — Release day (T7).** Press *Release* on the approved ContextMint Bridge versions,
  then on the ContextMint update that removes the embedded copy, in that order.
- **O7 — Live install checks (T8)** at the Mac (and on an iPhone): a real App Store /
  TestFlight install. Computer-use is off, so these are hands-on.

---

## Order and independence

```
T1 container project (apple/) ── needs O1 for signed runs only; unsigned build needs nothing
T2 extension: drop native messaging + hand-off row ── independent of T1
T3 docs/README/CLAUDE.md/PRIVACY/store copy for standalone distribution ── after T2
T4 CI: unsigned apple build on PRs ── after T1
T5 deploy workflow: TestFlight on every release ── after T1, T4, O1–O4
T6 store listing, screenshots, privacy answers ── after T1 (screenshots need a build); feeds O5
T8 live install checks (owner) ── after T5 has uploaded a TestFlight build
T7 migration: mcp-host-app removes the embedded appex ── after T8 passes and the Bridge app is APPROVED
T9 record the reversal in the fetchproxy spec ── any time; docs only
```

T1 and T2 can run in parallel in separate worktrees, since their files don't overlap.
T7 is the only task in mcp-host-app. It runs there, under that repo's rules.

## Standing rules for every task

The rules in `2026-09-25-extension-safari.md` § *Standing rules* apply word for word:
worktree not the shared clone, TDD, green `npm test` + `npm run typecheck` +
`npm run build`, never merge/label/tag/hand-bump, the PR is a live grenade, and a
Conventional-Commit title is the release decision. In addition:

- **This Mac is the shared self-hosted runner.** Before any `xcodebuild`, run
  `ps -axo pid,comm | grep Runner.Worker` and wait while a job is running. Delete any
  DerivedData or archives you create.
- **Ad-hoc-signed Safari extensions never run.** Anything that has to *run* in Safari is
  an Apple Development build (O3's Dev profiles). Unsigned builds prove only that it
  compiles.
- **Keep the Safari extension rules already learned:** an event-page background as a
  classic script, PNG toolbar icons only (an SVG `default_icon` silently drops the
  extension), and no X25519 `CryptoKey` in IndexedDB. Those are the existing
  `extension-safari` tests; don't weaken them.

---

## Task 1 — `apple/`: the container app and appex project (iOS + macOS)

**Branch:** `feat/safari-container-app`. **PR title:**
`feat(safari): add the ContextMint Bridge container app for the App Store`.

**Steps:**
1. In a scratch directory, run `xcrun safari-web-extension-packager
   packages/extension-safari/dist --project-location <scratch> --app-name "ContextMint
   Bridge" --bundle-identifier app.nullnet.contextmint.bridge --swift --no-open
   --copy-resources`. It's for reference only: lift the Info.plist keys, the handler
   shape and the storyboard-free SwiftUI app it generates. Don't commit the generated
   project.
2. Write `apple/project.yml` (XcodeGen) with four targets:
   - `ContextMintBridgeMac` (app, macOS 27, arm64 to match the fleet, sandboxed);
   - `ContextMintBridgeExtensionMac` (app-extension, `com.apple.Safari.web-extension`,
     sandboxed), embedded;
   - `ContextMintBridgeIOS` (app, iOS 27);
   - `ContextMintBridgeExtensionIOS` (app-extension), embedded.

   Bundle IDs per D2. `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` are set at
   project level and restated in every Info.plist, as mcp-host-app's `project.yml`
   does (its comment says why). `CODE_SIGNING_ALLOWED: NO` by default, plus
   per-target `PROVISIONING_PROFILE_SPECIFIER` variables like mcp-host-app's
   `MAC_APP_PROFILE` / `MAC_BRIDGE_PROFILE`. Set `ITSAppUsesNonExemptEncryption:
   false`, matching mcp-host-app: TLS and WebCrypto only.
3. The appex pre-build phase is `apple/tools/stage-extension.sh`. It runs the
   extension-safari release build, then copies `dist/` into
   `$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH` (`Contents/Resources` on
   macOS, the flat bundle root on iOS). It refuses a `dist/` file named like the appex
   executable, and refuses a manifest whose `version` differs from `MARKETING_VERSION`.
   Port these rules from mcp-host-app `tools/fetch_bridge_resources.py`, keeping its
   flat-bundle and executable-name rules but dropping the download and the
   `nativeMessaging` requirement. Test the staging rules in `tests/` (vitest, shelling
   out to the script against a temp dir).
4. The container UI is one SwiftUI screen, shared by both platforms with `#if os`:
   - the icon, "ContextMint Bridge", and one sentence on what it does;
   - **macOS:** the live state from `SFSafariExtensionManager.stateOfSafariExtension(
     withIdentifier: "app.nullnet.contextmint.bridge.extension")`, and a button that
     calls `SFSafariApplication.showPreferencesForExtension(withIdentifier:)`;
   - **iOS:** the steps ("Settings → Apps → Safari → Extensions → ContextMint Bridge →
     Allow"), and a button that calls
     `SFSafariSettings.openExtensionsSettings(forIdentifiers:)` (mcp-host-app
     `BridgeSafariModelIOS.swift` already uses both APIs);
   - "Then open the ContextMint Bridge popup in Safari and choose Connect"; a link to
     `docs/PRIVACY.md`'s published URL; the version.

   No accounts, no network, no analytics.
5. The appex's `SafariWebExtensionHandler` is a stub that completes every request with
   no reply, and carries a comment saying the manifest asks for no `nativeMessaging`.
6. `PrivacyInfo.xcprivacy` in each of the four targets: no tracking, no collected data
   types, and only the required-reason APIs actually used (expected: none beyond
   `UserDefaults`, if SwiftUI state uses it). Copy the shape of mcp-host-app's
   `McpHostBridge/PrivacyInfo.xcprivacy`.
7. Icons: the ContextMint Bridge mark from chrischall/nullnet-design-system
   (`system/assets/contextmint-bridge-icon-*`), copied in, never redrawn (CLAUDE.md
   §Icons). If the design system has no 1024 px master, stop and say so; that's a
   design-system PR first.
8. `release-please-config.json`: add `apple/project.yml` to `extra-files`.
   `tests/release-workflow.test.ts` must pin that it's there, as it does for the
   workspace `package.json`s.

**Done when:** `xcodegen generate && xcodebuild -scheme ContextMintBridgeMac build
CODE_SIGNING_ALLOWED=NO` passes, as does the iOS scheme for
`generic/platform=iOS Simulator`. The built appex has `manifest.json` at its resources
root, with the release version. The new tests and `npm test` / `typecheck` / `build` are
green, and the PR is open with CI green.

---

## Task 2 — Extension: no dependency on the ContextMint app

**Branch:** `feat/safari-standalone-extension`. **PR title:**
`feat(safari): stop asking the ContextMint app for a bridge`.

The hand-off is retired on the app side, so this deletes it rather than hiding it.

**Steps (tests first):**
1. `extension-safari/manifest.ts`: drop `SAFARI_ONLY` / `nativeMessaging`. In
   `tests/manifest-parity.test.ts`, the Safari permission list becomes exactly
   Chrome's minus `downloads` and `tabGroups`. Delete
   `tests/manifest-consumer-contract.test.ts`, because its consumer, mcp-host-app's
   appex build, goes away in T7. Replace it with a test holding the manifest to what
   T1's staging script checks (version, root `manifest.json`, event page).
2. Delete `extension-core/src/native-handoff.ts` and its wiring:
   - `background/boot.ts`: `nativeMessagingRuntime`, `startNativeHandoff`, the
     `contextmint-handoff` alarm, and the hand-off half of the page-load wake lift;
   - `background/socket.ts`: `setHandoffTarget`, `handoffLinkOpen`,
     `onHandoffLinkState`, `handoffLinkLive`;
   - `background/links.ts`: the `handoff` flag and `HANDOFF_LINK_PREFIX`;
   - the popup's `HandoffBridgeView`, `handoffBridgeView` and the "from ContextMint"
     row (`popup.ts` around line 1086);
   - the tests `native-handoff.test.ts`, `boot-native-handoff.test.ts` and
     `handoff-link.test.ts`, plus the popup tests' hand-off cases.

   On the first wake after upgrade, clear the stale `contextmint-handoff` alarm
   (`chrome.alarms.clear`) and test that. Find every remaining reference with
   `grep -rn -i handoff packages/`.
3. Page-load wake (`page-load-wake.ts`, contextmint-bridge#32) existed to lift the
   session for mcp-host-app's iOS "Refresh from Safari". Keep it only if it still
   serves the remote account links without the hand-off; judge from its tests. If it
   only fed the hand-off, remove it too, and say which you chose in the PR body.
4. Status: the popup's per-link dots and refusal lines are already the extension's own
   status. Check that a fresh Safari install with no account shows the loopback row
   plus the Connect call to action, and nothing that mentions the ContextMint app
   (popup test).
5. Safari-specific copy: in Safari only (feature-detected the way `capabilities.ts`
   does, never by user agent), the popup's empty state says how to turn the extension
   on for all sites (Safari's per-site permission prompt). Add it only if the T8 checks
   show that's where people get stuck; otherwise leave it as a T8 follow-up.

**Done when:** `grep -rn -i "handoff\|nativeMessag\|sendNativeMessage" packages/`
returns nothing except a changelog-worthy comment, if any. `npm test` / `typecheck` /
`build` are green, and the PR is open with CI green.

---

## Task 3 — Say it's distributed on its own

**Branch:** `docs/safari-standalone`. **PR title:**
`docs(safari): ContextMint Bridge for Safari is its own App Store app`. After T2.

- `packages/extension-safari/README.md`: replace "not distributed on its own" and the
  mcp-host-app embedding, the `nativeMessaging` bullet and the
  `BRIDGE_SAFARI_RESOURCES_DIR` loop with `apple/` and the signed dev build command.
- `CLAUDE.md`: update the package table row, the *Releases* paragraph (the Safari zip is
  now an audit and sideload artifact, not an mcp-host-app contract, once T7 lands) and
  the hot-spot *Safari takes a bridge target from ContextMint* (delete it). Add an
  `apple/` hot spot covering the self-hosted runner, signing by profile name and the
  version marker.
- `docs/PRIVACY.md`: delete *Safari only — the temporary app hand-off*. Add one line
  saying the Safari container app collects nothing.
- `docs/store-assets/permission-justifications.md`: delete the `nativeMessaging` entry.
- `.github/workflows/release-please.yml` header: the Safari zip stays, but it's no
  longer mcp-host-app's input after T7. Keep `tests/release-workflow.test.ts`'s
  asset-name pin until T7 merges, then relax the comment, not the asset.

**Done when:** `tests/brand-guard.test.ts` and `no-foreign-paths` are green, `npm test`
is green, and the PR is open.

---

## Task 4 — CI: build the container unsigned on PRs that touch it

**Branch:** `ci/apple-build`. **PR title:** `ci(apple): build the Safari container app on PRs`.

A job in `ci.yml` on `[self-hosted, macOS]`, path-filtered to `apple/**`,
`packages/extension-safari/**` and `packages/extension-core/**`. It runs
`npm ci --ignore-scripts`, `brew install xcodegen` if it's missing, then both unsigned
builds from T1's *Done when*. It is **not a required check**: the single Mac is
contended (memory: *macOS runner contention*), and the required check stays `ci / ci`.

**Done when:** the job runs green on its own PR, and a PR touching only the Chrome
package skips it.

---

## Task 5 — Deploy: TestFlight (iOS + macOS) on every release tag

**Branch:** `ci/deploy-safari-app`. **PR title:**
`ci(apple): upload the Safari app to TestFlight on each release`. Gated on O1–O4. First
step: check them read-only, and stop if any is missing.

- A new workflow `.github/workflows/deploy-safari-app.yml`, triggered on
  `push: tags: ["v*"]` plus `workflow_dispatch` with a `build_number` override. It's a
  separate file so a failure never reddens `attach-extension`. Use `environment:
  testflight`, `runs-on: [self-hosted, macOS]`, and refuse a commit not on `main`
  before checkout (copy mcp-host-app's first step).
- Two jobs, iOS and macOS. Each one:
  - creates a temporary keychain and imports the distribution certificate (plus the
    installer certificate on macOS);
  - downloads the profiles by name, then archives with manual signing;
  - exports the `.ipa` or `.pkg` and uploads it with `asc`;
  - deletes the keychain and profiles in an `always()` step.

  Copy the hygiene and preflight shape of mcp-host-app's
  `deploy-testflight-mac.yml` / `tools/mac_testflight_preflight.py`: name every missing
  item at once, and never use `-allowProvisioningUpdates`.
- Build number: `run_number*100+run_attempt` of this workflow. iOS and macOS are
  separate TestFlight trains, so one counter serves both.
- Version guard: the archived appex's `manifest.json` version, `MARKETING_VERSION` and
  the tag (without the `v`) must all be equal, or the job fails before upload.
- App Store submission stays manual for now (O6). A later task can add `asc` review
  submission once the first review has passed.
- Pin the trigger, environment, runner and "no `npm publish`" rules in
  `tests/release-workflow.test.ts`.

**Done when:** the tests are green, the PR is open with CI green, and, after the next
release, both TestFlight builds appear (`asc builds list --profile Nullnet`). The last
part is checked by the owner or a follow-up session, not by this PR.

---

## Task 6 — Store listing, screenshots and privacy answers

**Branch:** `docs/safari-store-listing`. **PR title:**
`docs(store): App Store listing for ContextMint Bridge`.

- `docs/store-assets/app-store/`: name, subtitle (30 characters or fewer), promo text,
  description and keywords. Reuse `listing-description.md`'s copy, with Chrome-specific
  lines swapped for Safari. Add review notes for App Review: how to see it work with
  `fpx` against a test site, a demo account for Connect, and why the container is
  minimal (Guideline 4.4.2: the extension is the product, and the app is the enable
  guide).
- Screenshots:
  - **macOS** takes 1280x800, so the existing `docs/store-assets/screenshots/*.png`
    can be reused once re-rendered from the Safari build if they differ;
  - **iPhone** needs 6.9-inch shots (1320x2868), and **iPad** 13-inch shots if iPad is
    supported. Render them from the real popup with the existing `store-assets`
    generator (new canvas sizes), not hand-drawn. Extend
    `extension-chrome/tests/store-assets.test.ts`'s size and format checks to them.
- App Privacy answers derived from `docs/PRIVACY.md` and mcp-host-app
  `docs/STORE-PRIVACY.md`. Expected: **Data Not Collected** by the developer. The
  gateway relays end-to-end session traffic; confirm against fetchproxy
  `docs/SECURITY.md` before claiming it. Write the answers as a table for O5.
- Category: see Q3.

**Done when:** the assets test is green, the PR is open, and the owner has the copy for
O2 and O5.

---

## Task 7 — Migration: remove the embedded appex from ContextMint (mcp-host-app)

**Repo: nullnet-app/mcp-host-app, under its CLAUDE.md.** Start only after the
ContextMint Bridge app is **approved** (iOS + macOS) and T8 has passed.

**Who is affected.** Only ContextMint for Mac users, who have the embedded copy through
TestFlight (and the App Store, if the Mac platform has shipped there; check its status
in O6). iOS users never had one.

**The cut, so nobody is left without a copy or running two for long:**
1. Set both ContextMint Bridge versions to *Manually release*. Hold the approved
   ContextMint Bridge app (don't release it), then submit the mcp-host-app removal
   release (below) for review.
2. When both are approved, on the same day (O6): release ContextMint Bridge first, then
   the ContextMint update minutes later.
   - Before a user updates ContextMint, they have one copy, the embedded one.
   - After they update, the embedded copy is gone and the ContextMint app's bridge
     screen sends them to install the new one.
   - Two copies exist only if someone installs the new app before their ContextMint
     update lands. Then both dial the loopback `127.0.0.1:37149` with different
     identities, which is confusing but not unsafe, and it ends at the update.
   - "Zero copies" ends when the person installs from the link. We can't install it for
     them.
3. The mcp-host-app removal PR (`feat(mac)!:` only if the owner calls it breaking;
   default `feat(mac): ContextMint Bridge for Safari moves to its own app`):
   - delete the `McpHostBridge` and `McpHostBridgeIOS` targets and the `embed`
     dependency;
   - delete `ios/bridge.lock.json`, `tools/fetch_bridge_resources.*` and its tests, and
     the appex sources and entitlements;
   - delete the `BRIDGE_BUNDLE_ID` / `MAC_BRIDGE_PROFILE` / `IOS_BRIDGE_PROFILE`
     plumbing in `deploy-testflight-mac.yml`, `mac_testflight_preflight.py` and
     `project.yml`;
   - remove `BridgeHandoff.swift`'s App Group cleanup **only after one release has
     run it**;
   - cancel the iOS Safari plan's T6 and its owner steps O1–O4 (no
     `group.app.nullnet.mcphost` is needed);
   - the Mac and iOS Browser bridge screens drop the `SFSafariExtensionManager` /
     `SFSafariSettings` calls for `app.nullnet.mcphost.bridge`, keep the account's
     presence view, and show "Get ContextMint Bridge for Safari" with the App Store
     link (`https://apps.apple.com/app/id<O2's Apple ID>`).
4. Owner-side cleanup after the removal ships: the `ContextMint Bridge Mac App Store` /
   `Mac Dev` profiles and the `app.nullnet.mcphost.bridge` App ID can be deleted (they
   only signed the appex). Keep `group.app.nullnet.mcphost` registration decisions
   with the owner.

**What happens to existing Safari data.** The new appex is a different extension
(different bundle, different extension origin), so it starts with an **empty vault**.
That means a new extension identity, no account credential and no trusted local MCPs.
Each person **re-Connects once** from the popup and re-approves each local MCP at its
next pairing prompt. Their old browser credential (`Safari on <mac>`) stays in the
account. Re-Connect with the same browser name should replace it
(contextmint-bridge#64). Confirm this in T8, and if it doesn't, tell people to revoke
the old one in ContextMint.

**What we tell people:** the ContextMint release notes and the Mac bridge screen say
"ContextMint Bridge for Safari now installs on its own from the App Store. Install it,
turn it on in Safari Settings → Extensions, then choose Connect once." The same line
goes in the Bridge app's first version's *What's New*.

**Done when:** the mcp-host-app PR is green and open (it merges only on the owner's
release-day call), and a TestFlight Mac build without the appex was checked by the
owner as part of T8.

---

## Task 8 — Live install checks (OWNER, at the Mac and on an iPhone)

From a **TestFlight** build (T5), then again from the **App Store** after release. Record
each result as works, degraded or absent, under *Results* in this file (docs PR).

1. **macOS discovery:** Safari → Settings → Extensions → More Extensions… Does
   ContextMint Bridge appear (after release), and does installing it put the extension
   in the list?
2. **macOS registration without launching the container (Q1).** Install, *don't* click
   Open, quit and relaunch Safari: is the extension listed? Then launch the container
   once and check again. (mcp-host-app `project.yml` says "Safari finds a web extension
   ONLY inside an app it has been launched from once"; that was learned from a
   dev-built app, not an App Store install.)
3. Enable it, then check:
   - the background runs and the popup renders;
   - Connect pairs to the account, and an `fpx` call through the gateway works;
   - a local MCP pairs over loopback;
   - the identity survives a Safari restart.
4. With the ContextMint for Mac TestFlight build **without** the appex installed:
   ContextMint's bridge screen shows the Bridge app's account presence as connected.
5. **Re-Connect replaces the old browser credential** (T7's data paragraph).
6. **iOS:**
   - install from Settings → Apps → Safari → Extensions → More Extensions;
   - turn it on and grant website access;
   - Connect;
   - an `fpx` call through the gateway while Safari is in front;
   - what happens with Safari in the background (spec spike row: the event page is
     expected to be suspended).

**Output:** results recorded here. Each failure becomes its own `fix:` task.

---

## Task 9 — Record the reversal in the fetchproxy spec

**Repo:** chrischall/fetchproxy. **PR title:**
`docs(spec): Safari ContextMint Bridge ships as its own App Store app`. Edit decision 1
and *Safari: signing, distribution, release*: mark them superseded on 2026-10-05, link
this plan, and restate the new IDs (D2) and "no App Group". Leave the original text
struck through, not deleted.

**Done when:** the PR is open with CI green.

---

## Open questions and risks

- **Q1 — Does macOS register the extension on App Store install without launching the
  container?** It hasn't been verified, and it's T8 check 2. If it doesn't register, the
  App Store's *Open* button (launching the container once) is the fix, and the
  container's screen says exactly what to do next. This is a copy problem, not a
  blocker.
- **Q2 — App Review of a near-empty container (Guideline 4.2, minimum functionality).**
  Safari-extension containers are allowed to be minimal when the extension is the
  product (4.4.2), and Apple's own packager produces exactly this shape. To lower the
  risk: put real enable instructions and live state in the container (T1), include
  thorough review notes with a demo path (T6), and fall back to the App Store Connect
  web packager (D1) if it's rejected.
- **Q3 — The "Safari Extensions" category.** The More Extensions gallery is Apple's
  curated list of apps that contain Safari extensions, and it's not clear that App
  Store Connect offers "Safari Extensions" as a selectable primary category. Check at
  O2. If it isn't offered, use **Developer Tools** (or Productivity, as ContextMint
  does), and confirm the listing shows up under More Extensions after release (T8
  check 1).
- **Q4 — Review of the extension's power.** All-sites host access, cookies and
  `webRequest` are justified in `permission-justifications.md`. App Review sees them
  here for the first time without ContextMint around them, so the review notes (T6) must
  explain the MCP use case and the per-MCP pairing consent.
- **Q5 — iOS.** The event page is likely suspended when Safari leaves the screen (spec
  spike row), so iOS is useful only for foreground relay. Say so in the iOS listing
  copy. `SFSafariSettings.openExtensionsSettings` needs iOS 26.2+, which iOS 27 covers.
  iPad support: yes by default (universal). Drop it in T1 if the iPad screenshots aren't
  worth it.
- **Q6 — Duplicate copies during the cut** (T7 step 2). Two extensions on loopback
  briefly confuse which identity an MCP pairs with. If this matters more than expected,
  add an optional extra step: one mcp-host-app release *before* removal whose appex
  answers a new native message so the embedded extension goes dormant once the new app
  is installed. It's deliberately left out, because it re-opens a contract retired on
  2026-09-29.
- **Q7 — Single self-hosted runner.** Every release now adds two archive jobs to the
  shared Mac, alongside mcp-host-app's. Releases that touch only Chrome still produce an
  App Store build (versions must stay equal). That's accepted for now; skipping
  submission when nothing under the Safari build changed is a later optimisation.
- **Q8 — The Chrome and Safari versions move together.** A Chrome-only `fix:` cuts a
  Safari TestFlight build too. That's harmless, because submitting it to the App Store
  is a manual decision (O6).

---

## Results

_(T8 fills this in.)_
