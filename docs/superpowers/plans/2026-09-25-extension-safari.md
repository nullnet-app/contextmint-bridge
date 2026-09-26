# ContextMint Bridge for Safari — `extension-safari` (implementation plan)

**Spec:** chrischall/fetchproxy `docs/superpowers/specs/2026-09-25-contextmint-bridge-chrome-safari-design.md`
— the *Architecture* section (`extension-safari`, the platform and capability seams),
*Spike results — macOS* and *Design note — Safari-safe X25519 identity storage*. This
plan is spec step 6. The macOS spike (spec step 5) ran on 2026-09-25 and said **go**,
with three required changes; two of them are this repo's (event-page background as a
classic script, Safari-safe X25519 storage), the third (Apple Development signing) is
not.

**The consumer.** nullnet-app/mcp-host-app `docs/superpowers/plans/2026-09-25-contextmint-mac-v0.md`
Task 6 embeds this repo's output in the appex `app.nullnet.mcphost.bridge`. It downloads
`contextmint-bridge-safari-${VERSION}.zip` from this repo's GitHub release, checks it
against a SHA-256 pinned in its `ios/bridge.lock.json`, **unzips it straight into the
appex's `Resources/`** (so `manifest.json` must be at the zip root — the appex bundle ends
up with `…/McpHostBridge.appex/Contents/Resources/manifest.json`), and then refuses to
build unless the manifest's:

- `background` is exactly `{"scripts": [...], "persistent": false}` — a `service_worker`
  key or `"type": "module"` fails the build;
- `permissions` contains `nativeMessaging`;
- `permissions` does **not** contain `downloads`.

Its Task 7 names the Safari-safe X25519 store and the detached-call fix (done here in
#7) as release blockers for a real pin. Everything this plan ships is shaped to pass
those checks exactly. Its Task 4 writes the native-messaging contract at
`docs/BRIDGE-HANDOFF.md` in mcp-host-app (not on its `main` as of 2026-09-25).

**Spike facts this plan is built on** (macOS Safari 27, fetchproxy 3.2.2 bundle):

1. Safari ran the background **only as an event page**:
   `"background": {"scripts": ["background.js"], "persistent": false}`. A
   `service_worker` background — module or classic — never ran, not even a hello-world.
2. ES-module backgrounds are unsupported: `background.js` must be a **classic script**
   (esbuild `format: 'iife'`, no top-level `import`/`export`). Today's Chrome bundle is
   ESM and ends in an `export { … }` block because `background.ts` re-exports helpers
   for the test suite.
3. **WebKit IndexedDB silently stores an X25519 `CryptoKey` as `null`** — and nulls any
   object that contains one. No error on `put`. Ed25519 `CryptoKey`s and `Uint8Array`s
   round-trip. Result today: `loadOrCreateExtensionIdentity` throws "extension identity
   missing from the vault after initialisation" and the extension never connects.
4. `chrome.downloads` is **absent**. `tabGroups` is absent (already `?.`-guarded in
   `ensure-domain-tab.ts`).
5. The manifest `world` key is unsupported, but **runtime** MAIN-world injection
   (`scripting.executeScript({world: 'MAIN'})`) works — `fetch` with `inPage: true`
   returned 200.
6. `webRequest` header capture is **unproven** (the spike's run timed out for lack of an
   open tab — not evidence either way).
7. Loopback `ws://127.0.0.1:37149`, pairing, the protocol-4 session, content-script
   fetch, keyed `read_cookies` (HttpOnly) and `read_local_storage` all worked.
8. Ad-hoc signing never runs; Apple Development signing is needed — mcp-host-app's
   concern, not this repo's. This repo signs nothing.

**What the protocol already allows** (`@fetchproxy/protocol` 3.2.3 on npm, read from its
`dist/frames.d.ts`): the extension hello carries `platform: 'chrome' | 'safari' |
'firefox'` but **no capability list**; the server hello carries `capabilities?:
Capability[]`; the extension can answer a server hello with
`{type: 'hello-rejected', mcpId, reason: string}` — sent only when the server's hello
`accepts` includes `'hello-rejected'` (every server ≥ 2.6.0) — and `reason` is a free
string, not a code. So a capability refusal at hello time is possible **today** with a
stable reason string; a machine-readable one needs a protocol change, which this plan
does **not** make (see *Appendix — protocol note*).

---

## Order and independence

```
T0 drop release-as (main is red) ── must merge first; everything else needs a green main
T1 Safari-safe identity storage ──> T2 fetchproxy SECURITY.md note (other repo)
T3 shared esbuild entries ──> T4 extension-safari package ──> T5 release: attach the Safari zip
T6 capability seam
T7 native hand-off client ── after T4; BLOCKED until mcp-host-app has docs/BRIDGE-HANDOFF.md on main
T8 live Safari verification ── after T1, T4, T6 (owner at the Mac; records results)
```

- **T0 first**, alone.
- **T1, T3 and T6 are independent** of each other (disjoint files: T1 = vault /
  identity / PRIVACY; T3 = `extension-chrome/build*.ts` + its tests; T6 = hello /
  dispatch / a new capabilities module). Run them in parallel in separate worktrees.
- T1, T4 and T6 each add a line to `CLAUDE.md`: whichever lands second rebases onto the
  first and keeps both — never resolve a conflict by dropping the other task's line.
- T2 after T1 (it describes what T1 actually shipped). T4 after T3. T5 after T4.
- T7 after T4, and only once its contract exists. T8 last.
- A Safari release that mcp-host-app can pin needs **T1 + T4 + T5** merged and a
  release-please release cut after them (T1 is a `fix:`, T4 a `feat:`, so the release
  PR appears on its own).

---

## Standing rules for every task

Each task's agent sees ONLY its own task text plus these rules. Read them.

- **Worktree, never the shared clone.** `git -C ~/git/contextmint-bridge fetch origin`,
  then `git -C ~/git/contextmint-bridge worktree add ~/git/contextmint-bridge-wt-<task>
  -b <branch> origin/main`. Never switch the branch of `~/git/contextmint-bridge`; other
  sessions use it. Verify the branch in the commit command itself
  (`test "$(git branch --show-current)" = <branch> && git commit …`). Remove the worktree
  when the PR is open and you are done with it.
- **TDD.** Write the failing test first, run it and watch it fail for the reason you
  expect, then make it pass.
- **Green before done:** `npm ci` (first time in the worktree), then `npm test`,
  `npm run typecheck` (vitest does not typecheck — CI runs `tsc`) and `npm run build`,
  all green. New test files and new `build.ts` files must be covered by
  `tsconfig.tests.json`'s `include` or `tsc` never sees them.
- **Never** merge a PR, add `ready-to-merge` / `release-ready`, create a tag, or
  hand-edit any `version` (package.json, manifest.json, `.release-please-manifest.json`,
  CHANGELOG). release-please owns versions.
- **PRs auto-merge within ~15 minutes of a pass.** Verify everything before
  `gh pr create`. Before any later push, `gh pr view <N> --json state,mergedAt`; if it
  merged, cherry-pick the missed commit onto a fresh branch off `origin/main` and open a
  new PR. A `git push` that prints "Create a pull request for …" means the branch has no
  open PR — stop and handle it.
- **PR titles are Conventional Commits and are the release decision** (`feat` = minor,
  `fix` = patch, `!` = major and is never used as emphasis; `docs`/`refactor`/`perf` show
  in the changelog without a bump; `ci`/`test`/`build`/`chore` are hidden). On a
  **one-commit PR GitHub squashes with the COMMIT subject**, so it must equal the PR
  title exactly. Use each task's title as given.
- **Protocol changes are not made here.** `@fetchproxy/protocol` comes from npm; frame
  shapes, validators and crypto live in chrischall/fetchproxy. Never patch them locally.
- **Comments cite repo-relative paths**, and any path outside this repo is qualified
  (`chrischall/fetchproxy packages/server/src/host.ts`) —
  `packages/extension-core/tests/no-foreign-paths.test.ts` fails otherwise.
- **No user-facing "Transporter"** anywhere under `packages/*/` (manifest, popup,
  README) or `docs/PRIVACY.md` / `docs/store-assets/` — `tests/brand-guard.test.ts`
  scans every package directory, including a new one.
- **New `chrome.*` API ⇒ manifest permission + README + store-assets justification**
  (CLAUDE.md, *What not to do*). A permission the Chrome manifest does not need goes in
  the Safari manifest only.
- **Nothing security-relevant in `chrome.storage.local`** — content scripts on every
  site can read and write it. Keys and trust live in the IndexedDB vault.
- Match the repo's comment style: the load-bearing *why* goes in the file.
- End commit messages with the session's `Co-Authored-By` / `Claude-Session` lines, and
  PR bodies with the session's attribution lines.
- **This Mac is the shared self-hosted CI runner.** No task here needs `xcodebuild`;
  anything long (T8's Safari work) first checks `ps -axo pid,comm | grep Runner.Worker`
  (not `pgrep -f`, which can match other sessions' shells) and waits if a job runs.
  Delete scratch build output you create (the disk has been full recently).

---

## Task 0 — Drop `release-as` now that v1.0.0 has shipped

**Why first:** `main` is red. v1.0.0 released (#5), CHANGELOG.md has its `1.0.0` entry,
and `tests/release-workflow.test.ts` › *only forces release-as 1.0.0 until v1.0.0 has
shipped* fails by design until `"release-as": "1.0.0"` leaves
`release-please-config.json` (CI run on `e6b8c13`: "CHANGELOG.md has a 1.0.0 entry, so
v1.0.0 shipped: delete release-as from release-please-config.json"). Every other task's
"npm test green" depends on this. Check `gh pr list --repo nullnet-app/contextmint-bridge`
first — if someone already opened this, stop and say so.

**Branch:** `ci/drop-release-as`. **PR title:** `ci(release): stop forcing 1.0.0 now that it has shipped`
(one commit; subject = title).

**Steps:**
1. The failing test already exists — run `npx vitest run tests/release-workflow.test.ts`
   and watch it fail with the message above.
2. `release-please-config.json`: delete `"release-as": "1.0.0"` and the two `//` lines
   about it; keep the `bootstrap-sha` lines.
3. `.github/workflows/release-please.yml`: delete the `FIRST RELEASE:` comment paragraph.
   `CLAUDE.md` §Releases: delete the `release-as` paragraph (the rest stays true).
4. Leave the test's `release-as` branch logic in place (it still guards a re-added key).

**Done when:** `npm test` / `typecheck` / `build` green, PR open, CI green.

---

## Task 1 — Safari-safe identity storage in the vault (feature check, never a UA sniff)

**Independent** of T3 and T6. **Branch:** `fix/safari-safe-identity-storage`.
**PR title:** `fix(extension): keep the identity keys where Safari's IndexedDB can hold them`.

**Problem.** `packages/extension-core/src/identity-keys.ts` builds an `ExtensionIdentity`
whose `x25519PrivateKey` and `ed25519PrivateKey` are non-extractable `CryptoKey`s, and
`vault-migration.ts` writes that whole object into the vault's `kv` store under
`identity` by structured clone (`vaultInitIfAbsent('identity', {...}, isExtensionIdentity)`).
WebKit IndexedDB stores an X25519 `CryptoKey` — and any object containing one — as
`null`, silently. So on Safari the `identity` value reads back `null`,
`isExtensionIdentity` is false, and `loadOrCreateExtensionIdentity` throws. Ed25519
`CryptoKey`s and `Uint8Array`s round-trip fine.

Note from `identity-keys.ts`: the X25519 private key has **no caller today** (protocol 4's
session ECDH is ephemeral × ephemeral; the long-term X25519 pub is an identity handle).
It is kept so the identity stays one coherent keypair set — keep it, under the best
protection the browser allows.

**Design (from the spec's design note; do not substitute a user-agent check):**

- **Probe once per vault factory** (memoised like `ensureVault`'s `runs` WeakMap, NOT
  persisted — a later browser that fixes the bug should be probed afresh): in one
  readwrite transaction `put` a throwaway **non-extractable X25519 private `CryptoKey`**
  under a probe key, `get` it back in a second transaction, delete it. If what comes back
  is a `CryptoKey` with `algorithm.name === 'X25519'`, the vault can hold X25519 keys →
  form **`cryptokey`** (today's shape, unchanged — Chrome stays exactly as it is). If
  not, probe a throwaway non-extractable **AES-GCM** key (`['wrapKey','unwrapKey']`) the
  same way. AES round-trips → form **`wrapped`**; AES also nulls → form **`pkcs8`**.
  Add the probe key to `VaultKey` (e.g. `'storageProbe'`); never leave it behind.
- **Form `wrapped`:** a non-extractable AES-GCM-256 wrapping key, generated once and stored
  in the vault (new `VaultKey` `'identityWrappingKey'`, written in the SAME
  `vaultInitIfAbsent` transaction as the identity). To mint: generate the X25519 pair
  **extractable** (WebCrypto cannot `wrapKey` a non-extractable key), `wrapKey('pkcs8',
  privateKey, wrappingKey, {name: 'AES-GCM', iv})` with a fresh 12-byte IV, keep the
  wrapped bytes + IV, then drop the extractable key and immediately `unwrapKey` to a
  **non-extractable** X25519 key for the in-memory identity. On load: `unwrapKey('pkcs8',
  …, extractable false, ['deriveBits'])`. Raw key material exists only transiently in
  memory during minting — the same exposure Chrome has during generation.
- **Form `pkcs8`** (fallback): store the X25519 PKCS#8 bytes as a `Uint8Array` (what the
  spike proved works), import non-extractable on load, zero the bytes after import. The
  record carries a flag (e.g. `x25519AtRest: 'pkcs8'`) so the popup/diagnostics and T2's
  note can state it; `console.warn` once per wake that the at-rest key is extractable.
- **Split the persisted shape from the in-memory shape.** `ExtensionIdentity` (what
  callers get: two non-extractable private `CryptoKey`s, two 32-byte pubs, `createdAt`)
  does not change — no caller outside the vault/identity modules learns about forms. A new
  `StoredIdentity` union (`{form: 'cryptokey', x25519PrivateKey: CryptoKey, …}` |
  `{form: 'wrapped', x25519Wrapped: Uint8Array, x25519Iv: Uint8Array, …}` |
  `{form: 'pkcs8', x25519Pkcs8: Uint8Array, …}`; the Ed25519 private key stays a
  `CryptoKey` in all three) is what the vault holds. **The stored record must not contain
  an X25519 `CryptoKey` in the `wrapped`/`pkcs8` forms** — WebKit nulls the whole object.
  An existing Chrome record has no `form` field: treat a missing `form` as `cryptokey`
  so nothing is rewritten on upgrade.
- **Validate on load the way `importLegacyIdentity` does:** after unwrapping/importing,
  prove the X25519 private key matches `x25519Pub` (reuse `identityIsConsistent`). A
  record that fails is not this extension's identity.
- **Migration of a vault already holding a null identity** (any Safari build that ran
  before this fix — the spike, a dev build): `vaultGet('identity')` returns `null`.
  Today `run()` then mints and writes again (nulled again) because `vaultInitIfAbsent`'s
  `isPresent` is `isExtensionIdentity`. After this task, `run()` must treat
  `null`/unreadable as "no identity", mint in the probed form, and **overwrite** the
  `null` in the same guarded transaction (the `isPresent` check for the identity sentinel
  must accept a valid `StoredIdentity` of any form and reject `null`). No trust record can
  be pinned to a null identity (it never connected), but if `trustedMcps` /
  `remoteBridges` / `dismissedScopeHashes` exist beside a null identity keep them as they
  are — remote bridge targets the user typed in are still theirs; trust records pinned to
  an identity that no longer exists simply never match, which `handleServerHello` already
  handles by prompting a pair.
- `vaultHasIdentity()` in `vault-migration.ts` and the `isExtensionIdentity(await
  vaultGet('identity'))` check at the top of `run()` must use the stored-shape predicate,
  or every Safari wake looks like a lost vault and the legacy-migration logic misfires.
- **Concurrency is unchanged:** the popup and the background can race first init; the
  wrapping key and the identity land in ONE `vaultInitIfAbsent` transaction, so only one
  pair ever wins. Minting (async WebCrypto) happens before the transaction, as today.

**Files:** `packages/extension-core/src/identity-keys.ts`, `src/vault.ts` (new keys),
`src/vault-migration.ts`, `src/extension-identity.ts` (docblock), probably a new
`src/identity-storage.ts` (probe + store/load per form — keep `identity-keys.ts` about
keys, not storage), `tests/helpers/vault.ts`, new `tests/identity-storage.test.ts`,
`tests/extension-identity.test.ts`, `tests/vault-migration.test.ts`, `docs/PRIVACY.md`,
`CLAUDE.md` (the *What not to do* vault bullet), `packages/extension-core/README.md` if it
describes the vault.

**Steps:**
1. **Test helper first — simulate WebKit in fake-indexeddb.** In `tests/helpers/vault.ts`
   add `webkitLikeVault({ nullAes = false } = {})`: a `freshVault()` whose object-store
   `put` replaces the value with `null` when the value is, or deeply contains, a
   `CryptoKey` whose `algorithm.name` is `'X25519'` (and `'AES-GCM'` when `nullAes`).
   Patch at the fake-indexeddb object-store prototype for that factory only (e.g.
   `vi.spyOn(FDBObjectStore.prototype, 'put')` from `fake-indexeddb` delegating to the
   original with the transformed value), and restore it in `afterEach`. Add a
   self-test: an X25519 key put through it reads back `null`, an object containing one
   reads back `null`, an Ed25519 key and a `Uint8Array` round-trip. Watch
   `extension-identity.test.ts`'s fresh-install cases fail under `webkitLikeVault()`
   with today's "missing from the vault" error — that is the bug reproduced.
2. Probe tests (`identity-storage.test.ts`): plain `freshVault()` → `cryptokey`;
   `webkitLikeVault()` → `wrapped`; `webkitLikeVault({nullAes: true})` → `pkcs8`; the
   probe key is absent from the store afterwards; the probe runs once per factory
   (count `put`s); a probe `put` that throws (quota) is a thrown error from
   `ensureVault`, not a silent `pkcs8` downgrade.
3. Identity tests, parameterised over the three vaults: `loadOrCreateExtensionIdentity`
   returns non-extractable X25519 and Ed25519 keys (`exportKey` rejects on both); the
   same identity comes back on a second load and after a simulated wake (drop the
   in-memory memo: a fresh `ensureVault` run on the SAME factory); X25519 `deriveBits`
   with the loaded key equals the peer's view (as the existing migration test does);
   concurrent first loads agree on one identity; **nothing is written to
   `chrome.storage.local`**. Form-specific: under `webkitLikeVault()` the stored record
   holds no X25519 `CryptoKey` and no PKCS#8 plaintext (search the stored value for the
   raw private bytes — they must not appear), and the wrapping key is a non-extractable
   AES-GCM `CryptoKey`; under `nullAes` the record carries the `pkcs8` flag.
4. Migration tests: a vault whose `identity` is `null` (put `null` directly) plus a
   `remoteBridges` entry → the next load mints, overwrites the `null`, keeps
   `remoteBridges`; a pre-existing Chrome-shaped record with no `form` field loads
   unchanged and is NOT rewritten (spy on `put`); the legacy `storage.local` import
   (`noteInstalled({reason: 'update'})` path) still works under all three vaults; a
   `wrapped` record whose bytes were tampered with fails consistency and is not
   returned as the identity (decide and test what happens next — the safe answer is the
   existing "missing from the vault" error rather than silently minting a new identity
   over a record that exists, since minting would orphan every pairing without saying
   so; state the choice in a comment).
5. Implement until green. Keep `isExtensionIdentity` as the in-memory shape check.
6. **Docs, honestly.** `docs/PRIVACY.md` §keys: say the private keys are held
   non-extractably by the browser; in browsers whose storage cannot keep such a key
   (Safari today), the key-exchange key is stored encrypted under a separate
   non-extractable key held in the same storage, and — only if even that is impossible —
   stored as plain key bytes in the extension's own storage (still unreachable from
   websites and content scripts). Do not claim more than the code does.
   `CLAUDE.md`'s vault bullet: one sentence on the storage forms and "never a UA sniff".
   The threat-model write-up is T2 (fetchproxy's `docs/SECURITY.md`); do not edit it here.

**Done when:** all of the above tests pass, the existing identity/migration/trust suites
still pass unchanged in intent, `npm test`/`typecheck`/`build` green, PR open with CI
green. In the PR body, state which form real Safari is expected to take and that T8
confirms it live.

---

## Task 2 — Record the Safari identity storage in fetchproxy's threat model

**Repo:** `chrischall/fetchproxy` (not this one; `~/git/fetchproxy`, same worktree rule
with `~/git/fetchproxy-wt-safari-security`). **After T1 has merged** — read what T1
actually shipped (`git -C ~/git/contextmint-bridge show origin/main:packages/extension-core/src/…`)
before writing. **Branch:** `docs/safari-identity-storage`.
**PR title:** `docs(security): say how the Safari bridge stores its identity keys`.

**Steps:**
1. `docs/SECURITY.md` §Defense 4 (the vault) — add a short *Safari* paragraph: WebKit
   IndexedDB nulls X25519 `CryptoKey`s (spike 2026-09-25); the bridge probes storage once
   (never a UA sniff) and, where X25519 keys do not persist, stores that key wrapped
   under a non-extractable AES-GCM key held in the same vault, or — if AES keys do not
   persist either — as PKCS#8 bytes, which weakens at-rest protection for that key
   (extractable by anything that can read the extension-origin IndexedDB: the extension's
   own pages and background, not websites or content scripts). State that the X25519
   private key has no caller in protocol 4, so the practical exposure of the fallback is
   the identity handle, not session keys; the Ed25519 signing key is unaffected on every
   form. Link to the bridge repo paths as `nullnet-app/contextmint-bridge …`.
2. If T8 has already recorded which form Safari actually takes, say it; otherwise say
   "expected `wrapped`, pending the live check" and leave a pointer to T8.
3. Run fetchproxy's doc-guard tests (`npm test` at its root; `npm run typecheck`) — its
   `security-docs-*` guards may read this file.

**Done when:** fetchproxy tests green, PR open with CI green. Docs only.

---

## Task 3 — Share the esbuild entries between browser builds

**Independent** of T1 and T6. **Branch:** `refactor/shared-extension-build`.
**PR title:** `refactor(extension): share the esbuild entry points between browser builds`.

**Why:** the spec requires `extension-safari` to reuse `extension-chrome`'s esbuild entry
points and own only its manifest and platform constant — no forked source. Today
`packages/extension-chrome/build.ts` hardcodes `PLATFORM = 'chrome'`, `target:
'chrome120'`, `outdir`, and `format: 'esm'` for the background, and runs `main()` when
`process.argv[1]` **ends with `build.ts`** — so another package's `build.ts` that imports
it would also run the CHROME build as a side effect. Fix both before T4 exists.

**Steps:**
1. Test first: in `packages/extension-chrome/tests/`, a test that importing the new
   library module has no side effects (no `dist/` write — assert by building into a
   temp `outdir` and checking nothing appears in the real `dist/` mtime, or simpler:
   the library exports only functions and the module body calls none, asserted by
   importing it with `esbuild.build` spied via `vi.mock('esbuild')` and expecting zero
   calls). And a test that the factories honour a `{platform, backgroundFormat, outdir}`
   argument (build with `write: false`, `platform: 'safari'`, `backgroundFormat: 'iife'`:
   the background text contains `"safari"` and no top-level `export`).
2. Create `packages/extension-chrome/build-lib.ts` — pure, no top-level side effects —
   exporting `BuildMode`, `moduleEntryOptions`, `contentScriptEntryOptions` (now taking
   a `BuildTarget` = `{ platform: Platform; outdir: string; backgroundFormat: 'esm' |
   'iife'; target: string }` plus `mode`), and a `copyStatic(outdir, { manifest, iconsDir })`
   helper for popup.html + icons. The popup entry stays `esm` for both targets (it is
   loaded via `<script type="module">` from an extension page, which the spike's Safari
   rendered). Keep the long comments with the code they explain.
3. `packages/extension-chrome/build.ts` becomes the Chrome target: its `BuildTarget`
   (`'chrome'`, `dist/`, `'esm'`, `'chrome120'`), `main()`, and **re-exports** of
   `moduleEntryOptions`/`contentScriptEntryOptions` pre-bound to the Chrome target so the
   existing tests (`platform-define`, `content-scripts-classic`,
   `release-bundle-sourcemaps`) keep importing `../build.js` unchanged. Replace the
   `invokedPath.endsWith('build.ts')` fallback with an exact comparison of resolved
   paths (keep whatever `tsx` needs — check `npm run build` still builds), and add a
   test that proves importing `build.ts` from a different entry does not run `main`.
4. `tsconfig.tests.json`: include `packages/extension-chrome/build-lib.ts`.
5. `npm run build`, then diff the produced `packages/extension-chrome/dist/` against a
   build from `origin/main` (build main in a second worktree, `diff -r`): byte-identical.
   The Chrome output must not change in this task. Delete the second worktree after.

**Done when:** Chrome `dist/` byte-identical to main's, new tests green,
`npm test`/`typecheck`/`build` green, PR open with CI green.

---

## Task 4 — `packages/extension-safari`: the Safari web-extension resources

**After T3.** **Branch:** `feat/extension-safari`.
**PR title:** `feat(safari): build ContextMint Bridge as a Safari web extension`.

**Goal:** `npm run build` also produces `packages/extension-safari/dist/` — exactly the
web-extension resources mcp-host-app's appex unzips into `Resources/`: `manifest.json`
at the root, `background.js`, `content.js`, `capture-logger.js`, `popup.html`,
`popup.js`, `icons/{16,32,48,128}.png` (plus whatever `extension-chrome/dist/` has that
the Safari manifest references — list both directories and compare). No Xcode, no
signing, no forked source.

**The manifest is generated, not hand-kept.** `packages/extension-safari/manifest.ts`
exports a pure `safariManifest(chrome: ChromeManifest): SafariManifest` that the build
applies to `packages/extension-chrome/manifest.json` (the file release-please bumps), so
name / short_name / version / description / icons / action / content scripts / host
permissions can never drift:

- `background` → `{ "scripts": ["background.js"], "persistent": false }` (no
  `service_worker`, no `type`);
- `permissions` → Chrome's minus `downloads` and `tabGroups` (spike: absent), plus
  `nativeMessaging` (mcp-host-app Task 6's build check requires it; T7 uses it);
- delete `minimum_chrome_version`;
- delete `world` from each `content_scripts` entry (Safari does not support the manifest
  key; `ISOLATED` is the default anyway). MAIN-world scripts stay runtime-registered
  (`main-world-bridge.ts`), never manifest-declared;
- everything else passes through untouched. Anything the function does not know about is
  copied, and the parity test (below) decides whether that is allowed.

**Steps:**
1. **Tests first** (`packages/extension-safari/tests/`):
   - *Manifest parity* (`manifest-parity.test.ts`): `safariManifest(chromeManifest)`
     equals Chrome's on `manifest_version`, `name`, `short_name`, `version`,
     `description`, `icons`, `action`, `host_permissions`, and `content_scripts` minus
     `world`; `permissions` equals Chrome's minus exactly `{downloads, tabGroups}` plus
     exactly `{nativeMessaging}` — nothing more (the spec: "Safari's permission list is
     Chrome's minus the spike's absent set, and nothing more" — `nativeMessaging` is the
     one deliberate Safari-only addition, named in the test with the reason); the key
     sets of the two manifests differ only by `minimum_chrome_version` and `background`'s
     shape. Run against the real `packages/extension-chrome/manifest.json` AND the built
     `dist/manifest.json`.
   - *mcp-host-app's gate, restated* (`manifest-consumer-contract.test.ts`): the built
     manifest's `background` deep-equals `{scripts: ['background.js'], persistent:
     false}`; `permissions` includes `nativeMessaging` and excludes `downloads`. Cite
     nullnet-app/mcp-host-app `tools/fetch_bridge_resources.sh` / its plan Task 6 in the
     comment — if that repo's check changes, this one must.
   - *Classic scripts* (`classic-scripts.test.ts`): build every Safari entry that the
     manifest loads as a classic script (background, content, capture-logger) with
     `write: false` and compile each with `new vm.Script(text)` from `node:vm` — Node
     compiles it as a classic script and throws `SyntaxError` on a top-level `import` /
     `export` — plus assert no `import.meta` and zero esbuild warnings. This is the
     guard for spike fact 2 and for the Chrome bundle's trailing `export { … }` block
     (from `background.ts`'s test re-exports): `format: 'iife'` drops it without
     touching the source.
   - *Platform define*: every Safari bundle substitutes `"safari"` and none keeps the
     `__FETCHPROXY_PLATFORM__` identifier (mirror
     `extension-chrome/tests/platform-define.test.ts`, including its
     `/\? void 0 : "safari"/` background check).
   - *No sourcemaps in release* (mirror `release-bundle-sourcemaps.test.ts`).
   - *Layout*: after `npm run build`, `dist/manifest.json` exists at the root, every file
     the manifest names (background scripts, content-script `js`, `action.default_popup`,
     every icon) exists in `dist/`, and nothing named in `dist/manifest.json` is missing.
     Mirror `manifest-icons.test.ts`'s PNG-size check for the icons.
2. `packages/extension-safari/package.json`: `"name": "@fetchproxy/extension-safari"`,
   `private`, `type: module`, `version` equal to extension-chrome's current version (read
   it; do not invent one), scripts `build` = `tsx build.ts`, `build:dev` = `tsx build.ts
   --dev`, dependencies `@fetchproxy/extension-core: "*"` and `@fetchproxy/protocol`
   with extension-chrome's exact range, devDependencies `esbuild`/`tsx` with
   extension-chrome's ranges. It may import `../extension-chrome/build-lib.ts` by
   relative path (both are private workspaces; say why in a comment). `npm install` to
   update the lockfile.
3. `packages/extension-safari/build.ts`: the Safari `BuildTarget` (`platform:
   'safari'`, `outdir: dist/`, `backgroundFormat: 'iife'`, an esbuild `target` Safari
   27 accepts — `safari18` or the newest esbuild knows; check esbuild's supported
   targets), the two entry builds from `build-lib.ts`, `copyStatic` with the GENERATED
   manifest (write `JSON.stringify(safariManifest(chrome), null, 2) + '\n'`) and
   extension-chrome's icons directory (the icons' source of truth is the design system,
   copied into `extension-chrome/icons/` — do not create a second copy in this package).
   Same exact-path `main()` guard as T3. Release is the default mode; `--dev` adds inline
   sourcemaps.
4. Wiring:
   - `tsconfig.tests.json` `include`: `packages/extension-safari/build.ts`,
     `packages/extension-safari/manifest.ts`.
   - `release-please-config.json` `extra-files`: `packages/extension-safari/package.json`
     `$.version` (the manifest version comes from Chrome's, so no manifest entry). Extend
     `tests/release-workflow.test.ts` (test first) to require that every
     `packages/*/package.json` is in `extra-files`, so the next package cannot be
     forgotten.
   - `.github/workflows/ci.yml` `protocol-next` job: add `-w @fetchproxy/extension-safari`
     to the `npm pkg set` line (its comment says it pins BOTH workspaces — make it all
     three, and say so). Extend the ci test that pins this job if there is one
     (`tests/release-workflow.test.ts` covers `ci.yml`'s `@next` job — check).
   - `packages/extension-safari/README.md`: what it is (the Safari web-extension
     resources, embedded by ContextMint's Apple apps — nullnet-app/mcp-host-app — not
     distributed on its own), the spike-driven differences (event page, classic
     background, no downloads/tabGroups, `nativeMessaging`, no manifest `world`), that
     it signs nothing and needs an Apple Development-signed container to run at all,
     and the dev loop: `npm run build:dev --workspace=@fetchproxy/extension-safari`, then
     point mcp-host-app's `BRIDGE_SAFARI_RESOURCES_DIR` at `packages/extension-safari/dist`.
     The brand guard scans it.
   - `docs/store-assets/permission-justifications.md`: a `nativeMessaging` entry marked
     Safari-only (asks ContextMint, the app that contains the extension, for the bridge
     target the user set up there).
   - `CLAUDE.md`: add the package to the Packages table and Commands; add a gotcha:
     "Safari runs the background as a non-persistent event page built as a classic
     script; keep background code free of top-level await, `import.meta` and
     service-worker-only globals (`self.registration`, `clients`, `skipWaiting`) —
     `extension-safari/tests/classic-scripts.test.ts` guards the first two".
5. `npm run build` from the root builds all three workspaces (alphabetical:
   chrome, core, safari — safari's build must not depend on chrome's `dist/`).
6. Sanity-check the output against the consumer: unzip-style layout check by hand
   (`cd packages/extension-safari/dist && zip -r /tmp/…` into your scratchpad, `unzip -l`
   shows `manifest.json` at the root), then delete the scratch zip.

**Done when:** all tests above green, `npm test`/`typecheck`/`build` green, PR open with
CI green. The PR body says the zip is attached to releases by T5 and that live Safari
behaviour is T8's.

---

## Task 5 — Release: attach the Safari zip beside the Chrome zip

**After T4.** **Branch:** `ci/release-safari-zip`.
**PR title:** `ci(release): attach the Safari resources zip to each release`.

**Goal:** every release (and every `republish_tag` re-run) attaches
`contextmint-bridge-safari-${VERSION}.zip` and `contextmint-bridge-safari-${VERSION}.zip.sha256`
beside the Chrome pair, under **exactly the same rules** as the Chrome attach step in
`.github/workflows/release-please.yml`: built from the release tag; manifest version
must equal `VERSION` or refuse to zip; zip made from **inside** `dist/` so
`manifest.json` is at the zip root (mcp-host-app unzips it straight into the appex's
`Resources/`); no `--clobber`; the digest is computed from the zip the release actually
serves (downloaded when it already exists), in `sha256sum` format; a digest without its
zip is refused before anything uploads.

**Steps:**
1. **Tests first** in `tests/release-workflow.test.ts`: generalise the Chrome assertions
   to both targets (`it.each(['chrome', 'safari'])`): exactly one job builds each zip
   (the same job — see step 2); it checks out the tag before building; the Safari build
   step runs `npm run build --workspace=@fetchproxy/extension-safari`; the packaging step
   compares `packages/extension-safari/dist/manifest.json`'s version to `VERSION` and
   `cd`s into that `dist` before `zip -r`; the attach step never passes `--clobber`,
   downloads an existing zip before hashing, and refuses a lone digest. Also assert the
   Safari zip's name is exactly `contextmint-bridge-safari-${VERSION}.zip` (mcp-host-app
   builds that URL). Watch them fail.
2. `release-please.yml`, in the existing `attach-extension` job (one job, so one
   checkout of the tag and one `npm ci --ignore-scripts`): add *Build Safari extension*
   and *Package Safari extension* steps mirroring Chrome's, and turn *Attach artifacts to
   release* into a loop over `chrome safari` running the unchanged per-zip logic (a shell
   function taking the target name is fine). Keep every existing comment; add one saying
   why the Safari zip's root must be the resources directory. Update the file's header
   comment and `CLAUDE.md` §Releases.
3. Consider the partial-failure path explicitly and say it in a comment: if Chrome
   attaches and Safari fails, a `republish_tag` dispatch from main re-runs the job; the
   Chrome assets are left alone (existing), and the Safari pair is added.
4. `actionlint` if available (`brew install actionlint` if not) on the workflow.

**Done when:** tests green, `npm test`/`typecheck`/`build` green, PR open with CI green.
The first release after this merges must show four assets; the task that is running
when that happens (or the owner) checks `gh release view vX.Y.Z --json assets`.

---

## Task 6 — Capability seam: refuse what this browser cannot serve, at hello time

**Independent** of T1, T3, T4. **Branch:** `feat/capability-seam`.
**PR title:** `feat(extension): refuse capabilities this browser cannot serve when an MCP says hello`.

**Goal (spec, *Capability seam*):** an MCP that declares a capability whose browser API
is absent gets a refusal **at hello time** naming the capability, not a mid-request
`undefined is not a function` — and the check is by **runtime API detection**, never by
`currentPlatform()` or a user agent, so the same code is right for Chrome, Safari and a
future Firefox.

**What exists:** the server hello's `capabilities` (default `['fetch']`,
`effectiveCapabilities` in `background/hello.ts`); `handleServerHello` (pure; returns
`{kind: 'reject', reason}`), whose rejections `server-hello.ts` sends back as
`hello-rejected` via `tellServerWhy` when the server `accepts` it; the per-request gate
in `background/handlers/dispatch.ts` (op-echoing error "capability … not granted").
Handlers already null-check some APIs mid-request (`download.ts`: `if
(!chrome.downloads)`; `capture.ts`: `if (!chrome.webRequest)`).

**Design:**
- New `packages/extension-core/src/capabilities.ts`:
  `unavailableCapabilities(api: ChromeApi): ReadonlySet<Capability>` — computed from what
  exists at runtime, **checked as bound properties, never by detaching methods** (#7:
  Safari returns `undefined` from a detached call):
  - `download` ← `typeof api.downloads?.download === 'function'` and `onChanged` present;
  - `capture_request_header` ← `api.webRequest?.onBeforeSendHeaders?.addListener`;
    `capture_redirect` ← `api.webRequest?.onBeforeRedirect?.addListener` — if Safari
    exposes these objects they count as present (spike: unproven, not absent; T8
    checks them live);
  - `fetch_in_page`, `graphql` ← `typeof api.scripting?.executeScript === 'function'`;
  - `write_cookies` ← `typeof api.cookies?.set === 'function'`;
  - everything else (`fetch`, `read_cookies` — which has a `document.cookie` path —,
    storage/IndexedDB/DOM reads) always available.
  Computed once per wake (APIs do not appear mid-life) and cached.
- `handleServerHello` gains a dep `unavailableCapabilities: ReadonlySet<Capability>` in
  `HandleHelloDeps` (it stays pure — the caller computes it). Immediately **after** the
  signature check and **before** the trust lookup / pair prompt: if any declared
  capability is unavailable, return `{kind: 'reject', reason}` with a **stable,
  parseable reason** — `unsupported-capability: download` (comma-separated when several,
  sorted) followed by ` (not available in this browser)`. Before any pair prompt,
  because asking a person to approve an MCP that cannot work is worse than refusing it.
  An already-trusted MCP whose declared set now includes an unavailable capability is
  refused the same way (trust does not make an API exist).
- `server-hello.ts` passes `unavailableCapabilities(chrome)`. The existing reject path
  already unbinds the mcpId, logs, and sends `hello-rejected` when accepted — reuse it,
  do not add a second sender. An MCP that does not `accept` `hello-rejected` gets
  silence, as for every other refusal; say so in the comment.
- `dispatch.ts`: defence in depth — if the required capability is in the unavailable set
  (a trust record granted before this code, or an API that vanished), answer the
  op-echoing error `capability "download" is not available in this browser` instead of
  entering the handler. The handlers' own null checks stay.
- The popup: if a pending pair or a trusted MCP is refused for this reason, nothing new
  is required in v1 — `console.warn` names it. (Surfacing it in the popup is a follow-up;
  list it in the PR.)
- Check `tests/background-module-surface.test.ts` — `hello.ts` exports only
  `handleServerHello` and the two types; keep it that way (the dep type lives inside
  `HandleHelloDeps`).

**Steps:**
1. Tests first: `tests/capabilities.test.ts` — with a full stub API nothing is
   unavailable; with `downloads` undefined → `{download}`; with `webRequest` undefined →
   both capture capabilities; with `scripting` undefined → `fetch_in_page`, `graphql`;
   with `cookies` lacking `set` → `write_cookies`; detection never calls a detached
   method (a stub whose methods throw when called without their receiver still yields
   "available"). In the existing `handleServerHello` test file: a hello declaring
   `['fetch','download']` with `download` unavailable is rejected with a reason starting
   `unsupported-capability: download`, **no pair record is produced** and trust is not
   consulted; the same hello with nothing unavailable proceeds exactly as today; a
   trusted MCP is refused the same way. Dispatch: a `download` request on a session
   granted `download` while `download` is unavailable gets the op-echo error and the
   handler is never called. `server-hello` level: the reject reason reaches
   `hello-rejected` when `accepts` includes it and is not sent when it does not.
2. Implement. Every existing test must pass unchanged — on Chrome (all APIs present)
   behaviour is identical.
3. `CLAUDE.md`: a gotcha bullet — capabilities are refused at hello by runtime API
   detection (`src/capabilities.ts`); a new capability whose API can be absent must be
   added there.
4. **Do not change the protocol.** Copy the *Appendix — protocol note* of this plan into
   the PR body under "Protocol follow-up (not in this PR)".

**Done when:** tests green, `npm test`/`typecheck`/`build` green, PR open with CI green.

---

## Task 7 — Ask ContextMint for the bridge target over native messaging (Safari)

**After T4. BLOCKED until nullnet-app/mcp-host-app has `docs/BRIDGE-HANDOFF.md` on
`main`** (its plan's Task 4). First step: `gh api
repos/nullnet-app/mcp-host-app/contents/docs/BRIDGE-HANDOFF.md` — if it 404s, stop and
report that the task is blocked; do not implement against a guessed contract.
**Branch:** `feat/safari-native-handoff`.
**PR title:** `feat(safari): take the ContextMint bridge target from the app`.

**What the Mac plan expects (implement against the CONTRACT DOC, which wins over this
summary):** the extension calls `browser.runtime.sendNativeMessage` (with the manifest's
`nativeMessaging` permission) sending `{"type":"bridge-target"}`; the appex answers
`{"url": "wss://…/bridge", "credential": "mcpb_…", "name": "…"}` or
`{"error": "not-set-up"}` (or `{"error": "unknown-request"}`). The background is a
non-persistent event page, so the target is held **in memory only** and asked for again
after every wake; the credential never touches `storage.local`, `storage.session` or the
IndexedDB vault.

**Steps (outline — refine against the contract):**
1. Tests first: a `native-handoff.ts` module that, when `sendNativeMessage` exists (bound
   call; feature-detected, never platform-checked), asks once per wake and yields an
   in-memory remote bridge target; `not-set-up` / `unknown-request` / a throw / a
   malformed answer → no target, one `console.warn` without the credential text; the
   credential never appears in any storage mock or log line; Chrome (no
   `sendNativeMessage`) → the module is inert.
2. Merge the handed-off target into the remote-bridge connection set without persisting
   it (read how `remote-targets.ts` / `socket.ts` open links for vault-stored targets and
   add an in-memory source beside them; the popup shows it as "from ContextMint",
   not editable).
3. PRIVACY.md: the extension asks the ContextMint app on the same device for the bridge
   address and access credential, keeps them in memory only. Store-assets
   justification for `nativeMessaging` updated if T4's wording no longer fits.

**Done when:** tests green, `npm test`/`typecheck`/`build` green, PR open with CI green.

---

## Task 8 — Live Safari verification (owner at the Mac)

**After T1, T4 and T6 have merged.** No code PR unless a check fails (a failure becomes
its own `fix:` task). Needs an **Apple Development-signed** container — ad-hoc never
runs. Use mcp-host-app's appex dev path (`BRIDGE_SAFARI_RESOURCES_DIR` pointed at
`packages/extension-safari/dist`, its README §macOS signed-build command) if its Task 6
has landed; otherwise a throwaway container from `xcrun safari-web-extension-packager`
signed with the `Apple Development` identity for team `5A673K24X6`. Check for
`Runner.Worker` first (`ps -axo pid,comm | grep Runner.Worker`); delete DerivedData and
the throwaway container afterwards.

**Checks, each recorded as works / degraded / absent:**
1. The background runs (a Web Inspector console line from the event page) and the popup
   renders.
2. **Which identity storage form Safari takes** (T1's probe result — log it once at boot
   in a dev build, or inspect the vault's `identity` record in Web Inspector): `wrapped`
   expected. Pair, quit Safari, reopen: **the same identity** comes back (the MCP does
   not ask to re-pair).
3. Pair a local MCP (`fpx` or `opentable-mcp`) and make a `fetch`, a keyed
   `read_cookies`, a `read_local_storage`, and a `fetch` with `inPage: true`.
4. `capture_request_header` with a live tab open (the spike's inconclusive row) — and
   whether `scripting.registerContentScripts` with `world: 'MAIN'` (the graphql
   capture-logger bridge in `main-world-bridge.ts`) works, which the spike did not test.
5. An MCP declaring `download` is refused at hello with `unsupported-capability:
   download` (T6), visible in the MCP's error.

**Output:** a docs PR in chrischall/fetchproxy adding the results to the spec's *Spike
results — macOS* table (title `docs(spec): record the Safari build's live checks`), and,
if check 4 finds `webRequest` or MAIN-world registration absent, a new task here to add
it to T6's detection (and to the Safari manifest's dropped permissions if it is a
permission).

---

## Appendix — protocol note (separate; NOT done in this plan)

For chrischall/fetchproxy, as an additive minor protocol change, when the owner wants it:

1. **Extension-advertised capabilities.** `HelloFrameFromExtension` gains optional
   `unavailableCapabilities?: Capability[]` (or `capabilities?: Capability[]`). The
   extension's hello is sent first, so a server that reads it can fail its own tool call
   locally with a precise error before sending a hello the extension would refuse —
   and a server/`fpx` can print "this browser (safari) cannot `download`" without
   parsing a string.
2. **A typed rejection.** `HelloRejectedFrame` gains optional
   `code?: 'unsupported-capability' | …` and `capabilities?: Capability[]`; `reason`
   stays for humans and older servers. Until then T6's `reason` prefix
   `unsupported-capability: ` is the de facto contract — keep it stable.
3. Both are wire-additive (optional fields; older validators must accept unknown
   optional fields — confirm `validateFrame` does, or it is a protocol-major change).

---

## Open questions

- **Subset vs refusal.** T6 refuses the whole hello when any declared capability is
  unavailable (the spec's "typed refusal at pair/hello time"). An MCP that declares
  `download` as optional would then not work on Safari at all; granting the available
  subset and refusing per request is the alternative. The plan follows the spec; say so
  if you prefer the subset.
- **Drop the X25519 private key instead?** It has no caller in protocol 4. Not storing it
  (keep only the pub as the identity handle) is simpler and strictly safer than any
  storage form — but it changes the identity's shape and forecloses a future use. T1
  keeps it per the spec's design note.
- **Safari toolbar template icon.** The spec mentions `contextmint-bridge-toolbar.svg`
  (monochrome template) for Safari; T4 ships the same PNGs as Chrome. Whether Safari 27
  takes an SVG in `action.default_icon`, and whether the template is wanted for v1, is
  unverified.
- **A Safari version floor** (`browser_specific_settings.safari.strict_min_version`) is
  not set; the spike only proved Safari 27.
- **iOS** rows of the spike are still open; nothing here is iOS-specific, but the event
  page's lifetime on iOS may change what T7 must do on wake.
