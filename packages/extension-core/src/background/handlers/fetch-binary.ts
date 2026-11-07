/**
 * Binary `fetch` (fetchproxy#460): `init.responseType: 'base64'`.
 *
 * The text path decodes a body with `response.text()` in a tab's content
 * script, which corrupts anything that is not UTF-8 (a PDF, an office file, an
 * image) beyond repair, and is subject to the page's CORS — so a signed file
 * host that sends no CORS headers cannot be read at all. This path reads the
 * BYTES and returns them base64-encoded, marked `bodyEncoding: 'base64'`, with
 * `content-type` / `content-length` / `content-disposition` relayed.
 *
 * **Where it runs, and why that is safe.** Here, in the background service
 * worker (an event page on Safari), not in a tab. The manifest's
 * `host_permissions` mean CORS does not apply to this worker's `fetch`, which
 * is the point; it also means NOTHING in the browser narrows what it can
 * read, so this module is the scope gate and must be at least as tight as the
 * tab path:
 *
 * - the request URL is checked against the MCP's declared domains by the
 *   caller (`handleFetchRequest`) before this runs — the same
 *   `isUrlAllowedForAnyDomain` the text path uses;
 * - the FINAL URL after redirects (`response.url`) is checked here, before a
 *   byte of the body is read, and an off-domain answer is cancelled. Without
 *   it, a declared host with an open redirect would let an MCP READ an
 *   undeclared, cookie-authenticated resource with CORS no longer in the way;
 * - intermediate redirect hops cannot be inspected (`redirect: 'manual'`
 *   yields an opaque response with no `Location`), so a hop may pass through
 *   an undeclared host — but its body is never read and nothing about it
 *   reaches the MCP, and a page-level `fetch()` has always followed the same
 *   hops. The error for an off-domain final URL names its HOST only, never the
 *   URL, so a token in an undeclared host's query string is not echoed either;
 * - no tab is involved, so no page CSRF token is injected.
 *
 * fetchproxy's docs/SECURITY.md §T-binary-fetch carries the threat analysis.
 *
 * **Size.** The body is capped at `MAX_BINARY_RESPONSE_BYTES` (16 MiB, derived
 * from the hosted relay's 32 MiB WebSocket message limit): refused early when
 * `content-length` is over it — the body is cancelled unread — and again
 * while streaming, for a response with no length or one that lied. The
 * refusal carries `code: 'response_too_large'` and the protocol's fixed
 * wording, which every published server already classifies as
 * `body_too_large`.
 */

import {
  MAX_BINARY_RESPONSE_BYTES,
  RELAYED_RESPONSE_HEADERS,
  RESPONSE_TOO_LARGE_CODE,
  responseTooLargeMessage,
  type FetchInit,
} from '@fetchproxy/protocol';

import { MAX_REQUEST_BODY_BYTES } from '../../content-limits.js';
import { isUrlAllowedForAnyDomain } from '../../lib/url-match.js';

/**
 * How long one binary transfer may take before it is abandoned. The MCP's own
 * request deadline normally fires first; this bounds a stalled transfer that
 * would otherwise hold up to 16 MiB in the worker indefinitely.
 */
export const BINARY_FETCH_TIMEOUT_MS = 120_000;

export type BinaryFetchResult =
  | { ok: true; status: number; url: string; body: string; headers: Record<string, string> }
  | { ok: false; error: string; code?: string };

export interface BinaryFetchDeps {
  /** The worker's `fetch`, injectable for tests. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Byte cap; defaults to `MAX_BINARY_RESPONSE_BYTES`. Tests shrink it. */
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Standard padded base64 of `bytes`, built in chunks.
 *
 * The protocol's `toB64` concatenates one character per byte, fine for keys
 * and quadratic-ish in practice for a 16 MiB body. Chunks are a multiple of 3
 * bytes, so each encodes to whole base64 quanta with no padding in the middle,
 * and stay under the ~65k-argument limit `String.fromCharCode.apply` has in
 * JavaScriptCore (Safari).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 3 * 0x4000; // 49152 bytes → 65536 base64 characters
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, i + CHUNK);
    parts.push(btoa(String.fromCharCode.apply(null, sub as unknown as number[])));
  }
  return parts.join('');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable url)';
  }
}

function cancelBody(response: Response): void {
  // Best effort: an unread body left open keeps the connection (and, for a
  // large file, the transfer) alive for nothing.
  void response.body?.cancel().catch(() => undefined);
}

/**
 * Run one binary fetch. The caller has already checked `init.url` (and
 * `init.tabUrl`) against `domains`; this checks the final URL and the size.
 */
export async function runBinaryFetch(
  init: FetchInit,
  domains: string[],
  deps: BinaryFetchDeps = {},
): Promise<BinaryFetchResult> {
  const doFetch = deps.fetch ?? ((url: string, i: RequestInit) => fetch(url, i));
  const maxBytes = deps.maxBytes ?? MAX_BINARY_RESPONSE_BYTES;
  const timeoutMs = deps.timeoutMs ?? BINARY_FETCH_TIMEOUT_MS;
  if (init.body && init.body.length > MAX_REQUEST_BODY_BYTES) {
    return { ok: false, error: `request body too large: ${init.body.length} bytes` };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const timeoutError = (): BinaryFetchResult => ({
    ok: false,
    error: `fetch threw: binary fetch timed out after ${timeoutMs}ms`,
  });

  try {
    let response: Response;
    try {
      response = await doFetch(init.url, {
        method: init.method,
        headers: init.headers ?? {},
        body: init.body,
        // Default preserved from the text path: an authenticated fetch is
        // what the bridge exists for.
        credentials: init.credentials ?? 'include',
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (e) {
      if (timedOut) return timeoutError();
      return { ok: false, error: `fetch threw: ${(e as Error).message}` };
    }

    // The final URL, after every redirect. `url` is empty only for a
    // synthetic Response; fall back to the request URL, which was checked.
    const finalUrl = response.url || init.url;
    if (!isUrlAllowedForAnyDomain(finalUrl, domains)) {
      cancelBody(response);
      return {
        ok: false,
        error:
          `final url host ${hostOf(finalUrl)} (after redirects) not in domains ` +
          `[${domains.join(', ')}]`,
      };
    }

    // Wire validators require a positive integer status.
    if (!Number.isInteger(response.status) || response.status <= 0) {
      cancelBody(response);
      return { ok: false, error: `fetch threw: unusable response status ${response.status}` };
    }

    const headers: Record<string, string> = {};
    for (const name of RELAYED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }

    // Early refusal: a declared length over the cap is believed, and nothing
    // is read. A length under the cap is NOT believed — the stream below
    // counts what actually arrives.
    const declared = headers['content-length'];
    if (declared !== undefined && /^\d+$/.test(declared.trim())) {
      const declaredBytes = Number(declared.trim());
      if (declaredBytes > maxBytes) {
        cancelBody(response);
        return {
          ok: false,
          code: RESPONSE_TOO_LARGE_CODE,
          error: responseTooLargeMessage({ limitBytes: maxBytes, declaredBytes }),
        };
      }
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            void reader.cancel().catch(() => undefined);
            return {
              ok: false,
              code: RESPONSE_TOO_LARGE_CODE,
              error: responseTooLargeMessage({ limitBytes: maxBytes }),
            };
          }
          chunks.push(value);
        }
      } catch (e) {
        if (timedOut) return timeoutError();
        return { ok: false, error: `fetch threw: reading the body failed: ${(e as Error).message}` };
      }
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    return { ok: true, status: response.status, url: finalUrl, body: bytesToBase64(bytes), headers };
  } finally {
    clearTimeout(timer);
  }
}
