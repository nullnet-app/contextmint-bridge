/**
 * How the vault's `identity` record is read — including the shapes earlier
 * versions wrote, which carried an X25519 private key this version no longer
 * keeps (`identity-keys.ts`).
 *
 * Today the vault holds exactly an `ExtensionIdentity`: the X25519 pub, the
 * non-extractable Ed25519 private key, the Ed25519 pub and `createdAt`. That
 * record is the same in every browser — it holds no X25519 `CryptoKey`, the
 * one thing WebKit's IndexedDB silently stores as `null` (macOS Safari 27:
 * chrischall/fetchproxy
 * docs/superpowers/specs/2026-09-25-contextmint-bridge-chrome-safari-design.md,
 * *Spike results — macOS*) — so there is nothing to probe and no form to pick.
 *
 * Earlier versions kept the X25519 private key beside it, in one of three
 * forms (contextmint-bridge #11): the `CryptoKey` itself (Chrome; `form`
 * absent or `'cryptokey'`), `wrapKey` output under a separate
 * `identityWrappingKey` (`'wrapped'`, Safari), or PKCS#8 bytes (`'pkcs8'`).
 * Such a record is still this extension's identity — its pubs are what every
 * pairing is pinned to — so it passes `isExtensionIdentity` and is read as one, and `vault-migration.ts`
 * rewrites it without the private material (`discardableX25519`) on the next
 * wake and deletes the wrapping key. The private material is discarded
 * unread: it is never unwrapped or imported, so a corrupt wrapped blob or a
 * missing wrapping key no longer costs anyone their pairings.
 */

import { isExtensionIdentity, type ExtensionIdentity } from './identity-keys.js';

/** Fields only an earlier version's record carries: the X25519 private key, in any form. */
const DISCARDED_FIELDS = ['form', 'x25519PrivateKey', 'x25519Wrapped', 'x25519Iv', 'x25519Pkcs8'];

/** Does a stored identity still carry X25519 private material an earlier version wrote? */
export function discardableX25519(stored: unknown): boolean {
  return (
    isExtensionIdentity(stored) &&
    DISCARDED_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(stored, k))
  );
}

/**
 * The identity a stored record holds — its four fields and nothing else — or
 * null when the record is not an identity.
 */
export function openStoredIdentity(stored: unknown): ExtensionIdentity | null {
  if (!isExtensionIdentity(stored)) return null;
  return {
    x25519Pub: stored.x25519Pub,
    ed25519PrivateKey: stored.ed25519PrivateKey,
    ed25519Pub: stored.ed25519Pub,
    createdAt: stored.createdAt,
  };
}
