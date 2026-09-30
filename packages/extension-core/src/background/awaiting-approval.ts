import { toB64 } from '@fetchproxy/protocol';
import { sendOnLink, type Link } from './links.js';

const sentByLink = new WeakMap<Link, { session: string; identities: Set<string> }>();

/** Tell a compatible remote MCP its hello is waiting on a person, once per identity and socket session. */
export function sendAwaitingApproval(
  link: Link,
  mcpId: string,
  accepts: readonly string[] | undefined,
  identityHash: string,
  subject: string,
  browser: string,
): boolean {
  if (link.kind !== 'remote' || !accepts?.includes('hello-rejected') || !link.sessionNonce)
    return false;
  const session = toB64(link.sessionNonce);
  let state = sentByLink.get(link);
  if (!state || state.session !== session) {
    state = { session, identities: new Set() };
    sentByLink.set(link, state);
  }
  if (state.identities.has(identityHash)) return false;
  // Record before the best-effort send so a synchronous send failure cannot
  // turn repeated hellos into a refusal-frame amplifier.
  state.identities.add(identityHash);
  const reason = `awaiting-approval: approve ${subject} in ${browser}`.slice(0, 200);
  try {
    return sendOnLink(link, JSON.stringify({ type: 'hello-rejected', mcpId, reason }));
  } catch (error) {
    console.warn('[fetchproxy] awaiting-approval rejection send failed:', error);
    return false;
  }
}
