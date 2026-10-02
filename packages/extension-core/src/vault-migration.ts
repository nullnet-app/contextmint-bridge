/**
 * First-run initialisation of the vault (`vault.ts`), including the ONE-TIME
 * migration out of `chrome.storage.local` for installs from before the vault.
 *
 * Before the vault the extension kept its identity keys (fleet-audit #253) and its
 * trust records, remote bridge targets and dismissed scope-update hashes
 * (#252) in `storage.local`, which every site's content script can read and
 * write. They now live in the vault; this module moves them there once.
 *
 * The rules that make this safe:
 *
 * - **storage.local is read only on an UNFORGEABLE upgrade signal.** An empty
 *   vault is not one: quota eviction, corruption or a wipe of the extension's
 *   IndexedDB empties it too, and if emptiness alone authorised the import, a
 *   renderer that had planted an identity (whose private key it knows) and
 *   trust records pinned to it would have both installed the next time the
 *   vault was lost. The signal is `chrome.runtime.onInstalled` with reason
 *   `update` arriving while the vault is still empty — Chrome fires it,
 *   nothing a page does can. It is deliberately NOT tied to a version number:
 *   whichever release first ships the vault, the one before it kept state in
 *   storage.local, and a hardcoded "last legacy version" would silently strand
 *   every user of a storage.local release cut after it was written (3.2.1 was
 *   one). What this admits beyond a genuine upgrade is a vault lost at the
 *   moment of an update — not something an attacker can schedule. An update
 *   onto a vault that already has an identity authorises nothing, so no
 *   authorisation lingers for a vault lost later. `noteInstalled` records it in
 *   `chrome.storage.session` (trusted contexts only), so a service worker
 *   killed mid-import retries from there, and the import CONSUMES it. With an
 *   empty vault and no signal, a fresh identity is minted and whatever sits
 *   under the legacy keys is deleted unread.
 * - **the service worker waits for the signal.** On an upgrade Chrome starts
 *   the new worker and only then dispatches onInstalled, so boot's first
 *   vault access can come first. Boot arms `armInstallSignal`; an empty vault
 *   waits (bounded) for onInstalled to say what happened before it decides.
 *   A normal wake never gets here — the vault already has an identity — so
 *   the wait costs only a worker that woke up to a lost vault.
 * - **only the background initialises** (fleet-audit #1001). Boot calls
 *   `claimVaultOwnership`; every other context — the popup — is a reader
 *   that asks the background (`ensure-vault`) and never mints, imports or
 *   purges. Only the background sees onInstalled, so a popup deciding on its
 *   own, in the gap between Chrome starting the updated worker and
 *   dispatching onInstalled, would mint over an upgrade and purge the legacy
 *   identity — every pairing lost.
 * - **the identity and everything imported with it land in ONE transaction**
 *   that first checks the identity is still absent (`vaultInitIfAbsent`), so
 *   two background runs (a worker restarted mid-import) cannot both
 *   initialise. The write is read back before the legacy keys are purged or
 *   the upgrade authorisation consumed, so a failed write loses nothing.
 * - **a lost vault is detected, not passed off as a fresh install**
 *   (fleet-audit #1002): `VAULT_TRIPWIRE_KEY` in storage.local survives an
 *   IndexedDB eviction, and a vault minted beside it records `vaultLoss` for
 *   the popup to show.
 * - **the stores are imported only alongside a legacy identity.** A trust
 *   record is meaningless without the identity it was pinned to.
 * - **everything imported is validated the way the live stores validate it**
 *   — malformed rows are dropped, never repaired into something trusted.
 *
 * What a migration cannot do is tell a legitimate legacy record from one a
 * content script planted BEFORE the upgrade — that storage was writable by
 * design until now. It imports what an existing user has, so no one has to
 * re-pair, and the exposure it closes is from the upgrade onward
 * (chrischall/fetchproxy docs/SECURITY.md §Defense 4).
 *
 * The identity record holds no X25519 private key (`identity-keys.ts`), so
 * it is the same in every browser and needs no storage probe. A record an
 * earlier version wrote WITH one (any of #11's `cryptokey` / `wrapped` /
 * `pkcs8` forms) is still the identity: the wake that finds it rewrites it
 * without that key and deletes the `identityWrappingKey`
 * (`identity-storage.ts`), keeping both pubs, so no pairing is lost. `null`
 * (what a WebKit vault written before #11 holds) is no identity at all, so it
 * is overwritten rather than mistaken for one.
 *
 * Memoised per IndexedDB factory (= per profile) so the many callers that
 * need the vault ready — identity load, trust store, remote targets —
 * share one run per context. A failed run is not memoised; the next caller retries.
 */

import {
  requestPersistentStorage,
  vaultFactory,
  vaultGet,
  vaultInitIfAbsent,
  vaultUpdate,
  type VaultKey,
} from './vault.js';
import {
  generateExtensionIdentity,
  importLegacyIdentity,
  isExtensionIdentity,
} from './identity-keys.js';
import { discardableX25519, openStoredIdentity } from './identity-storage.js';
import { normaliseRemoteTargets } from './remote-targets.js';

/** `chrome.storage.local` keys an older version kept secrets or trust in. */
export const LEGACY_IDENTITY_KEY = 'extensionIdentity';
export const LEGACY_TRUST_KEY = 'trustedMcps';
export const LEGACY_REMOTE_TARGETS_KEY = 'remoteBridges';
export const LEGACY_DISMISSED_KEY = 'dismissedScopeHashes';

const LEGACY_KEYS = [
  LEGACY_IDENTITY_KEY,
  LEGACY_TRUST_KEY,
  LEGACY_REMOTE_TARGETS_KEY,
  LEGACY_DISMISSED_KEY,
];

/**
 * `chrome.storage.session` key: the extension was updated onto an empty vault
 * and the import has not completed yet. `storage.session` is
 * restricted to trusted contexts, so a content script cannot set it.
 */
export const LEGACY_MIGRATION_FLAG = 'legacyVaultMigration';

/**
 * How long an empty vault in the service worker waits for onInstalled. Chrome
 * dispatches it right after the new worker starts; the wait only runs out on
 * a wake with no install event, i.e. a lost vault, which then mints fresh.
 */
export const INSTALL_SIGNAL_TIMEOUT_MS = 5_000;

interface Area {
  get: (k: string | string[]) => Promise<Record<string, unknown>>;
  set?: (kv: Record<string, unknown>) => Promise<void>;
  remove: (k: string | string[]) => Promise<void>;
}

function storageArea(name: 'local' | 'session'): Area | null {
  const c = (globalThis as unknown as { chrome?: { storage?: Partial<Record<string, Area>> } })
    .chrome;
  const a = c?.storage?.[name];
  return a && typeof a.get === 'function' && typeof a.remove === 'function' ? a : null;
}

/**
 * Is this `onInstalled` an update of the extension itself? Any version counts
 * — see the module comment for why this is not pinned to a "last legacy"
 * version. Chrome updates and shared-module updates do not.
 */
export function isExtensionUpdate(details: { reason: string; previousVersion?: string }): boolean {
  return details.reason === 'update';
}

let installSignal: { promise: Promise<boolean>; resolve: (v: boolean) => void } | null = null;

/**
 * Service-worker boot: make an empty vault wait (up to `timeoutMs`) for
 * `noteInstalled` before deciding between import and a fresh identity. Call
 * it before the first vault access, beside registering the onInstalled
 * listener that calls `noteInstalled`.
 */
export function armInstallSignal(timeoutMs: number = INSTALL_SIGNAL_TIMEOUT_MS): void {
  let settle!: (v: boolean) => void;
  const promise = new Promise<boolean>((r) => (settle = r));
  const timer = setTimeout(() => settle(false), timeoutMs);
  installSignal = {
    promise,
    resolve: (v) => {
      clearTimeout(timer);
      settle(v);
    },
  };
}

/** Test-only: forget any armed install signal. */
export function __resetInstallSignalForTests(): void {
  installSignal?.resolve(false);
  installSignal = null;
}

/**
 * The `chrome.runtime.onInstalled` listener's half. On an update onto a vault
 * that has no identity yet, authorise the one-time import (persisted in
 * `storage.session` so an interrupted worker can finish it); either way,
 * release a vault access waiting on `armInstallSignal`.
 */
export async function noteInstalled(details: {
  reason: string;
  previousVersion?: string;
}): Promise<void> {
  // An update onto an initialised vault has nothing to import, and a flag set
  // now would outlive it and authorise an import for a vault lost later in
  // the browser session.
  const authorised = isExtensionUpdate(details) && !(await vaultHasIdentity());
  if (authorised) {
    try {
      await storageArea('session')?.set?.({ [LEGACY_MIGRATION_FLAG]: true });
    } catch (e) {
      console.error('[fetchproxy] could not record the legacy-migration authorisation:', e);
    }
  }
  installSignal?.resolve(authorised);
}

async function vaultHasIdentity(): Promise<boolean> {
  try {
    return isExtensionIdentity(await vaultGet('identity'));
  } catch {
    // Unreadable vault: the import could not land anyway, and ensureVault
    // retries. Authorise, so a transient failure does not cost the pairings.
    return false;
  }
}

async function sessionFlagSet(): Promise<boolean> {
  const session = storageArea('session');
  if (!session) return false;
  try {
    return (await session.get(LEGACY_MIGRATION_FLAG))[LEGACY_MIGRATION_FLAG] === true;
  } catch {
    return false;
  }
}

async function clearSessionFlag(): Promise<void> {
  try {
    await storageArea('session')?.remove(LEGACY_MIGRATION_FLAG);
  } catch (e) {
    console.error('[fetchproxy] could not clear the legacy-migration authorisation:', e);
  }
}

/** May this (empty) vault import from storage.local? */
async function upgradeAuthorised(): Promise<boolean> {
  if (await sessionFlagSet()) return true;
  const signal = installSignal;
  if (!signal) return false;
  // One onInstalled per worker: whatever it said is used up by this run.
  const authorised = await signal.promise;
  if (installSignal === signal) installSignal = null;
  return authorised || (await sessionFlagSet());
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `{ records: { [identityHash]: object } }`, dropping every non-object row. */
export function sanitiseTrustStore(v: unknown): { records: Record<string, unknown> } {
  const records: Record<string, unknown> = {};
  if (isPlainObject(v) && isPlainObject(v.records)) {
    for (const [k, r] of Object.entries(v.records)) if (isPlainObject(r)) records[k] = r;
  }
  return { records };
}

/** `{ [identityHash]: string[] }`, dropping every non-string entry. */
export function sanitiseDismissed(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!isPlainObject(v)) return out;
  for (const [k, list] of Object.entries(v)) {
    if (!Array.isArray(list)) continue;
    const hashes = list.filter((h): h is string => typeof h === 'string');
    if (hashes.length > 0) out[k] = hashes;
  }
  return out;
}

async function purgeLegacy(area: Area | null): Promise<void> {
  if (!area) return;
  try {
    await area.remove(LEGACY_KEYS);
  } catch (e) {
    console.error('[fetchproxy] could not delete legacy storage.local keys:', e);
  }
}

/**
 * Drop the X25519 private material an earlier version kept (#11): rewrite the
 * record as its four identity fields, then delete the wrapping key. Both are
 * read first, so an ordinary wake writes nothing. The rewrite re-checks inside
 * its transaction, so the popup and the background can both run it.
 */
async function discardX25519Private(existing: unknown): Promise<void> {
  if (discardableX25519(existing)) {
    await vaultUpdate('identity', (cur) =>
      discardableX25519(cur) ? openStoredIdentity(cur) : cur,
    );
  }
  if ((await vaultGet('identityWrappingKey')) !== undefined) {
    await vaultUpdate('identityWrappingKey', () => undefined);
  }
}

/**
 * `chrome.storage.local` key: a vault was initialised in this profile (the
 * time it first was). It lives OUTSIDE IndexedDB on purpose — `storage.local`
 * is not quota-evicted with the vault — so an empty vault beside it means the
 * vault was LOST, not that this is a fresh install (fleet-audit #1002).
 *
 * A tripwire only, never an authorisation: content scripts can write
 * `storage.local`, so a forged one at most shows a false "pairings were
 * reset" notice, and a deleted one at most lets a loss go unannounced (as
 * every loss did before it). It holds a timestamp, not the identity, so it is
 * no fingerprint for a renderer to read.
 */
export const VAULT_TRIPWIRE_KEY = 'vaultInitialisedAt';

/**
 * The runtime message the popup (or any non-background context) sends to ask
 * the background to initialise the vault. Answered `{ ok: true }` or
 * `{ ok: false, reason }` (`background/boot.ts`).
 */
export const ENSURE_VAULT_MESSAGE = 'ensure-vault';

/**
 * How long a reader waits for the background to answer `ensure-vault`. Longer
 * than `INSTALL_SIGNAL_TIMEOUT_MS`, because the background may itself be
 * waiting for onInstalled before it decides.
 */
export const READER_TIMEOUT_MS = 15_000;

async function tripwireSet(area: Area | null): Promise<boolean> {
  if (!area) return false;
  try {
    return (await area.get(VAULT_TRIPWIRE_KEY))[VAULT_TRIPWIRE_KEY] !== undefined;
  } catch {
    return false;
  }
}

async function setTripwire(area: Area | null): Promise<void> {
  if (!area?.set || (await tripwireSet(area))) return;
  try {
    await area.set({ [VAULT_TRIPWIRE_KEY]: Date.now() });
  } catch (e) {
    console.error('[fetchproxy] could not record the vault tripwire:', e);
  }
}

/**
 * The background's run: the ONLY code that creates or migrates the vault.
 *
 * Order matters for the legacy store: the new vault is written in one
 * transaction, read back and checked, and only then is the session
 * authorisation consumed and `storage.local` purged. A failed write throws
 * before either, so the legacy identity (and the flag that lets a retry import
 * it) survive for the next attempt.
 */
async function ownerRun(): Promise<void> {
  const area = storageArea('local');
  const existing = await vaultGet('identity');
  if (isExtensionIdentity(existing)) {
    // Initialised. Anything under the legacy keys now was not written by this
    // extension's current state — a content script planted it, or it is the
    // leftover of a run interrupted before its purge — and is never imported.
    await discardX25519Private(existing);
    await vaultInitIfAbsent('legacyStoresMigrated', { legacyStoresMigrated: true });
    await clearSessionFlag();
    await purgeLegacy(area);
    await setTripwire(area);
    void requestPersistentStorage();
    return;
  }
  // Read BEFORE anything is written: was there a vault here before this one?
  const hadVault = await tripwireSet(area);
  const authorised = await upgradeAuthorised();
  let entries: Partial<Record<VaultKey, unknown>>;
  let imported: Awaited<ReturnType<typeof importLegacyIdentity>> = null;
  if (authorised) {
    let legacy: Record<string, unknown> = {};
    if (area) {
      try {
        legacy = await area.get(LEGACY_KEYS);
      } catch (e) {
        console.error('[fetchproxy] could not read legacy storage.local keys:', e);
      }
    }
    imported = await importLegacyIdentity(legacy[LEGACY_IDENTITY_KEY]);
    // An upgrade brings its stores with it, pinned to the identity it had.
    entries = imported
      ? {
          identity: imported,
          trustedMcps: sanitiseTrustStore(legacy[LEGACY_TRUST_KEY]),
          remoteBridges: normaliseRemoteTargets(legacy[LEGACY_REMOTE_TARGETS_KEY]),
          dismissedScopeHashes: sanitiseDismissed(legacy[LEGACY_DISMISSED_KEY]),
          legacyStoresMigrated: true,
        }
      : { identity: await generateExtensionIdentity(), legacyStoresMigrated: true };
  } else {
    // A fresh install, or a lost vault — or a WebKit vault whose identity
    // was nulled before #11: `isExtensionIdentity(null)`
    // is false, so that `null` is overwritten, and whatever sits beside it
    // (remote bridge targets the user typed in) is left as it is. Nothing in
    // storage.local is ours.
    entries = { identity: await generateExtensionIdentity(), legacyStoresMigrated: true };
  }
  // fleet-audit #1002: a vault existed here and is gone. A new identity is
  // still minted — the bridge cannot work without one — but the loss is
  // recorded for the popup to show, never passed off as a fresh install.
  if (hadVault && !imported) {
    entries.vaultLoss = { detectedAt: Date.now() };
    console.error(
      '[fetchproxy] the extension vault was lost (evicted or wiped); a new identity was minted and every MCP must pair again',
    );
  }
  // If another owner run won the race, nothing is written here and its
  // initialisation stands.
  await vaultInitIfAbsent('identity', entries, isExtensionIdentity);
  if (!isExtensionIdentity(await vaultGet('identity'))) {
    throw new Error('vault identity did not persist; legacy storage left in place for a retry');
  }
  // Consumed: a vault lost later in this browser session mints fresh.
  if (authorised) await clearSessionFlag();
  await purgeLegacy(area);
  await setTripwire(area);
  void requestPersistentStorage();
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Every context but the background (the popup): read the vault, and if it is
 * not initialised yet, ask the background to initialise it — never mint,
 * import or purge here (fleet-audit #1001). Only the background sees
 * onInstalled, so only it can tell an upgrade (import the legacy identity)
 * from a fresh install or a lost vault (mint); a popup that decided on its own
 * would mint over an upgrade it could not see and purge the old identity.
 * Throws when the vault is still empty afterwards; the next call retries.
 */
async function readerRun(): Promise<void> {
  if (isExtensionIdentity(await vaultGet('identity'))) return;
  const send = (
    globalThis as unknown as {
      chrome?: { runtime?: { sendMessage?: (m: unknown) => Promise<unknown> } };
    }
  ).chrome?.runtime?.sendMessage;
  if (typeof send !== 'function') {
    throw new Error('vault not initialised, and the background cannot be reached to initialise it');
  }
  let reason = '';
  try {
    const answer = (await withTimeout(
      Promise.resolve(send({ type: ENSURE_VAULT_MESSAGE })),
      READER_TIMEOUT_MS,
    )) as { ok?: unknown; reason?: unknown } | undefined;
    if (answer?.ok !== true && typeof answer?.reason === 'string') reason = `: ${answer.reason}`;
  } catch (e) {
    reason = `: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!isExtensionIdentity(await vaultGet('identity'))) {
    throw new Error(`vault not initialised by the background${reason}`);
  }
}

type VaultRole = 'owner' | 'reader';

/**
 * Which kind of context this is. Every context starts as a READER: the safe
 * default, since a context that forgot to say would otherwise be able to mint.
 * The background claims ownership at boot (`claimVaultOwnership`).
 */
let role: VaultRole = 'reader';

/** Background boot, before the first vault access: this context initialises the vault. */
export function claimVaultOwnership(): void {
  role = 'owner';
}

/** Test-only: act as the background (`owner`) or another context (`reader`). */
export function __setVaultRoleForTests(r: VaultRole): void {
  role = r;
}

let ownerRuns = new WeakMap<IDBFactory, Promise<void>>();
let readerRuns = new WeakMap<IDBFactory, Promise<void>>();

/**
 * Test-only: forget every memoised run, as a new service-worker wake (or the
 * popup, a separate context) would start without one.
 */
export function __forgetVaultRunsForTests(): void {
  ownerRuns = new WeakMap();
  readerRuns = new WeakMap();
}

function memo(runs: WeakMap<IDBFactory, Promise<void>>, run: () => Promise<void>): Promise<void> {
  const f = vaultFactory();
  let p = runs.get(f);
  if (!p) {
    p = run();
    runs.set(f, p);
    p.catch(() => runs.delete(f));
  }
  return p;
}

/**
 * The background's initialisation (migrating or minting as needed). Called by
 * `ensureVault` in the background, and by boot's `ensure-vault` handler on
 * behalf of the popup. Never call it from any other context.
 */
export function ensureVaultAsOwner(): Promise<void> {
  return memo(ownerRuns, ownerRun);
}

/**
 * Resolve once the vault is initialised. In the background this initialises
 * it; anywhere else it waits for the background to (`readerRun`).
 */
export function ensureVault(): Promise<void> {
  return role === 'owner' ? ensureVaultAsOwner() : memo(readerRuns, readerRun);
}

/** A lost vault this one replaced (fleet-audit #1002), or null. */
export async function loadVaultLoss(): Promise<{ detectedAt: number } | null> {
  const v = await vaultGet('vaultLoss');
  if (typeof v !== 'object' || v === null) return null;
  const at = (v as { detectedAt?: unknown }).detectedAt;
  return typeof at === 'number' && Number.isFinite(at) ? { detectedAt: at } : null;
}

/** The person has seen the vault-loss notice: stop showing it. */
export async function dismissVaultLoss(): Promise<void> {
  await vaultUpdate('vaultLoss', () => undefined);
}
