/**
 * Bind a remote link's credential to this extension on its first successful
 * attach (mcp-host plan task C2, spec §4.3, invariant I-13's extension half).
 *
 * A credential that reached this browser pasted, or handed off by ContextMint,
 * was minted UNBOUND: until it is bound, anybody else holding a copy can
 * attach their browser to the account whenever this one is away. The gateway
 * lets a credential bind ITSELF (`POST /bridge/bind`, a bridge-scoped
 * self-operation, first writer wins), and this is the extension doing that,
 * once, as soon as it knows the credential works:
 *
 * - **after the socket opens**, never before — an open socket is the gateway
 *   having accepted the credential, so a bind is only ever sent for a
 *   credential at the gateway that just took it, and never to a relay that is
 *   down or refused it;
 * - **to that link's own gateway origin** (`gatewayOriginFor`), which is where
 *   the credential already travels as a WebSocket subprotocol. Nothing a
 *   server says can point the bind elsewhere;
 * - **only when the credential's `brt_*` id is known** — it is what the
 *   signature covers. A handed-off target carries it; a pasted one carries it
 *   only if the user gave it in the Bridges form (it is shown beside the
 *   token) or it came from a redemption. A pasted credential saved WITHOUT
 *   its id stays unbound — a named residual of I-13, not a silent one;
 * - **once**: the answer is remembered per credential in the vault
 *   (`bridge-bind-store.ts`) — `bound`, `conflict` and `refused` are final —
 *   and a gateway that answers 404 (it predates binding) is not asked again
 *   for a day. `refused` (400/401) is final on purpose: the gateway counts
 *   both against the same per-address allowance `/bridge` uses, so asking
 *   again would walk this browser towards being locked out of its own bridge.
 *   Only a transient failure is retried, and only on the next attach.
 *
 * The socket that is already open stays as it attached (the room reads the
 * binding at attach); the next attach is bound. Binding grants nothing and
 * changes no trust decision here — it only narrows who else can use the
 * credential.
 */

import { bindCredential, gatewayOriginFor } from '../bridge-binding.js';
import {
  credentialKey,
  isOriginUnsupported,
  loadBindState,
  recordBindState,
  recordOriginUnsupported,
} from '../bridge-bind-store.js';

import { state } from './state.js';
import type { Link } from './links.js';

/**
 * Called when a link's socket opens. Fire-and-forget: it never throws, and a
 * bind never delays or blocks the hello.
 */
export async function bindOnConnect(link: Link): Promise<void> {
  if (link.kind !== 'remote' || link.bind !== 'idle') return;
  const identity = state.extIdentity;
  const credential = link.credential;
  const credentialId = link.credentialId;
  const origin = gatewayOriginFor(link.url);
  if (!identity || !credential || !credentialId || !origin) {
    link.bind = 'settled';
    return;
  }
  link.bind = 'inflight';
  let next: Link['bind'] = 'idle';
  try {
    const key = await credentialKey(credential);
    if ((await loadBindState(key)) !== null || (await isOriginUnsupported(origin))) {
      next = 'settled';
      return;
    }
    // Removed while the vault was read (a new credential, or the target
    // withdrawn): not this link's to bind any more.
    if (link.closed) return;
    const outcome = await bindCredential(identity, link.url, credentialId, credential);
    switch (outcome) {
      case 'bound':
        await recordBindState(key, 'bound');
        next = 'settled';
        break;
      case 'refused':
        await recordBindState(key, 'refused');
        next = 'settled';
        // Final and otherwise silent, so name the origin the signature was
        // over: a gateway serving this bridge under a host other than its
        // configured resource (a preview host, a second domain) refuses it.
        console.warn(
          `[fetchproxy] ${link.label}: the bridge refused to bind this credential ` +
            `(signed for ${origin}) — it stays usable but is not locked to this browser`,
        );
        break;
      case 'conflict':
        await recordBindState(key, 'conflict');
        next = 'settled';
        // The room will refuse this browser 4004 on its next hello; say why
        // here too, where the cause is known.
        console.warn(
          `[fetchproxy] ${link.label}: this bridge credential is bound to a different browser — ` +
            `revoke it and pair this browser again`,
        );
        break;
      case 'unsupported':
        await recordOriginUnsupported(origin);
        next = 'settled';
        break;
      case 'retry':
        break;
    }
  } catch (e) {
    console.warn(`[fetchproxy] ${link.label}: could not bind the bridge credential:`, e);
  } finally {
    link.bind = next;
  }
}
