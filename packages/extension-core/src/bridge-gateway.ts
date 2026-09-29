import { validateRemoteTargetUrl } from './remote-targets.js';

/** Gateway close code for a credential bound to a different browser identity. */
export const EXTENSION_MISMATCH_CLOSE = 4004;
export const EXTENSION_MISMATCH_MESSAGE = 'This bridge is paired with a different browser';

/** The gateway origin behind a bridge URL; null for invalid remote targets. */
export function gatewayOriginFor(bridgeUrl: string): string | null {
  if (!validateRemoteTargetUrl(bridgeUrl).ok) return null;
  const url = new URL(bridgeUrl);
  const scheme = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : null;
  return scheme ? `${scheme}//${url.host}` : null;
}

const REQUEST_TIMEOUT_MS = 15_000;

/** POST JSON without carrying cookies or following a redirect to another origin. */
export async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const timeout = (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout?.(
    REQUEST_TIMEOUT_MS,
  );
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    ...(timeout ? { signal: timeout } : {}),
  });
}
