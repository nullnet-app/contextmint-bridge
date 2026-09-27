/**
 * What this extension remembers about binding its bridge credentials to its
 * identity (mcp-host plan task C2, `bridge-binding.ts`), in the vault.
 *
 * - **Per credential**, keyed by `sha256(credential)` — never the credential
 *   itself, because a ContextMint-handed-off credential is held in memory only
 *   (`native-handoff.ts`) and must not start being persisted just so its bind
 *   state can be: `bound` (to this extension), `conflict` (to another one) or
 *   `refused` (the gateway would not take the signature or the credential).
 *   Each is final for that credential — a binding is first-writer-wins and
 *   never moves — so a credential with a record is never bound again.
 * - **Per gateway origin**, when it answered `POST /bridge/bind` with 404: the
 *   gateway predates binding. Remembered so a legacy gateway is not asked on
 *   every wake, and asked again after {@link BIND_UNSUPPORTED_RETRY_MS} so
 *   one that is upgraded later still gets its credentials bound.
 *
 * Why a separate record rather than a field on the remote-target row: a
 * handed-off target has no row, and a pasted target's row is the popup's to
 * rewrite. Why the vault and never `chrome.storage.local`: a content script
 * that could write `bound` or `unsupported` could stop this browser binding a
 * credential — keep a stolen copy of it attachable — which is exactly what
 * binding exists to prevent (fleet-audit #252's reasoning).
 *
 * Everything read is validated on the way out, so a row this code would not
 * have written is never acted on.
 */

import { vaultGet, vaultUpdate } from './vault.js';
import { ensureVault } from './vault-migration.js';

export type BindState = 'bound' | 'conflict' | 'refused';

/** How long a 404 from a gateway keeps this extension from asking it again. */
export const BIND_UNSUPPORTED_RETRY_MS = 24 * 60 * 60 * 1000;

/** A cap, so a long-lived profile's record cannot grow without bound. */
export const MAX_BIND_RECORDS = 64;

interface BindRecords {
  credentials: Record<string, { state: BindState; at: number }>;
  unsupported: Record<string, number>;
}

const STATES: ReadonlySet<string> = new Set(['bound', 'conflict', 'refused']);
const HASH = /^[0-9a-f]{64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sanitise(v: unknown): BindRecords {
  const out: BindRecords = { credentials: {}, unsupported: {} };
  if (!isRecord(v)) return out;
  if (isRecord(v.credentials)) {
    for (const [key, row] of Object.entries(v.credentials)) {
      if (!HASH.test(key) || !isRecord(row)) continue;
      if (typeof row.state !== 'string' || !STATES.has(row.state)) continue;
      if (typeof row.at !== 'number' || !Number.isFinite(row.at)) continue;
      out.credentials[key] = { state: row.state as BindState, at: row.at };
    }
  }
  if (isRecord(v.unsupported)) {
    for (const [origin, at] of Object.entries(v.unsupported)) {
      if (typeof at === 'number' && Number.isFinite(at)) out.unsupported[origin] = at;
    }
  }
  return out;
}

/** Keep the newest `MAX_BIND_RECORDS` of a `{key: at}`-ordered map. */
function newest<T>(rows: Record<string, T>, at: (row: T) => number): Record<string, T> {
  const entries = Object.entries(rows);
  if (entries.length <= MAX_BIND_RECORDS) return rows;
  entries.sort((a, b) => at(b[1]) - at(a[1]));
  return Object.fromEntries(entries.slice(0, MAX_BIND_RECORDS));
}

/** The key a credential's bind state is stored under: its SHA-256, hex. */
export async function credentialKey(token: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
  );
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The settled bind state of one credential, or null when it has none. */
export async function loadBindState(key: string): Promise<BindState | null> {
  await ensureVault();
  return sanitise(await vaultGet('bridgeBindings')).credentials[key]?.state ?? null;
}

/** Settle one credential's bind state. */
export async function recordBindState(
  key: string,
  bindState: BindState,
  now = Date.now(),
): Promise<void> {
  if (!HASH.test(key)) return;
  await ensureVault();
  await vaultUpdate('bridgeBindings', (cur) => {
    const records = sanitise(cur);
    records.credentials[key] = { state: bindState, at: now };
    records.credentials = newest(records.credentials, (row) => row.at);
    return records;
  });
}

/** Remember that `origin` answered 404: it predates binding. */
export async function recordOriginUnsupported(origin: string, now = Date.now()): Promise<void> {
  await ensureVault();
  await vaultUpdate('bridgeBindings', (cur) => {
    const records = sanitise(cur);
    records.unsupported[origin] = now;
    records.unsupported = newest(records.unsupported, (at) => at);
    return records;
  });
}

/** Did `origin` answer 404 within the retry window? */
export async function isOriginUnsupported(origin: string, now = Date.now()): Promise<boolean> {
  await ensureVault();
  const at = sanitise(await vaultGet('bridgeBindings')).unsupported[origin];
  return at !== undefined && now - at < BIND_UNSUPPORTED_RETRY_MS;
}
