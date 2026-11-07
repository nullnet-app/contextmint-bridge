import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  fromB64,
  responseTooLargeMessage,
  validateInnerFrame,
  MAX_BINARY_RESPONSE_BYTES,
  RESPONSE_TOO_LARGE_CODE,
} from '@fetchproxy/protocol';

/**
 * fetchproxy#460: `fetch` with `init.responseType: 'base64'` returns the
 * response BYTES. It runs from the background worker (no tab, no CORS),
 * follows redirects, relays three headers, and is held to the MCP's declared
 * domains for the request URL AND the final URL. The body is capped early on
 * `content-length` and again while streaming.
 */

const sent: { mcpId: string; inner: Record<string, unknown> }[] = [];
vi.mock('../src/background/send-inner.js', () => ({
  sendInner: async (mcpId: string, inner: Record<string, unknown>) => {
    sent.push({ mcpId, inner });
  },
}));

const { handleFetchRequest } = await import('../src/background/handlers/fetch.js');
const { runBinaryFetch, bytesToBase64 } = await import('../src/background/handlers/fetch-binary.js');
const { mcpCapabilities } = await import('../src/background/session-scope.js');

const MCP_ID = 'files-mcp:1.0.0:aaaaaaaaaaaaaaaa';
const DOMAINS = ['example.com'];
const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);

/** A Response whose `url` reads as the given final URL, as after a redirect. */
function responseAt(url: string, body: BodyInit | null, init: ResponseInit = {}): Response {
  const res = new Response(body, init);
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

/** A body that counts how many chunks were pulled and whether it was cancelled. */
function trackedStream(chunks: Uint8Array[]): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
  cancelled: () => boolean;
} {
  let i = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 }); // pull only when read, so `pulled` counts reads
  return { stream, pulled: () => i, cancelled: () => cancelled };
}

const binReq = (init: Record<string, unknown> = {}) => ({
  type: 'request' as const,
  id: 9,
  op: 'fetch' as const,
  init: {
    url: 'https://files.example.com/doc/1?sig=abc',
    method: 'GET',
    tabUrl: 'https://example.com/',
    responseType: 'base64' as const,
    ...init,
  },
});

describe('bytesToBase64', () => {
  it('matches btoa for every length around a chunk boundary', () => {
    for (const n of [0, 1, 2, 3, 4, 49151, 49152, 49153, 100_000]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      expect(bytesToBase64(bytes), `length ${n}`).toBe(btoa(bin));
    }
  });
});

describe('runBinaryFetch', () => {
  it('round-trips all 256 byte values exactly and relays only the three headers', async () => {
    const fetchImpl = vi.fn(async () =>
      responseAt('https://files.example.com/doc/1?sig=abc', ALL_BYTES, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Length': '256',
          'Content-Disposition': 'attachment; filename="report.pdf"',
          'X-Internal': 'secret',
          'Cache-Control': 'no-store',
        },
      }),
    );
    const r = await runBinaryFetch(binReq().init, DOMAINS, { fetch: fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(200);
    expect(r.url).toBe('https://files.example.com/doc/1?sig=abc');
    expect(Array.from(fromB64(r.body))).toEqual(Array.from(ALL_BYTES));
    expect(r.headers).toEqual({
      'content-type': 'application/pdf',
      'content-length': '256',
      'content-disposition': 'attachment; filename="report.pdf"',
    });
  });

  it('follows redirects, sends the page cookies by default, and passes method/headers/body', async () => {
    const fetchImpl = vi.fn(async () => responseAt('https://files.example.com/x', new Uint8Array([1])));
    await runBinaryFetch(
      { ...binReq().init, method: 'POST', headers: { 'x-a': '1' }, body: 'q=1' },
      DOMAINS,
      { fetch: fetchImpl },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://files.example.com/doc/1?sig=abc');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'x-a': '1' },
      body: 'q=1',
      redirect: 'follow',
      credentials: 'include',
    });
  });

  it("honours credentials: 'omit'", async () => {
    const fetchImpl = vi.fn(async () => responseAt('https://files.example.com/x', null));
    await runBinaryFetch({ ...binReq().init, credentials: 'omit' }, DOMAINS, { fetch: fetchImpl });
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].credentials).toBe('omit');
  });

  it('reports the final URL of a redirect that stayed on the declared domains', async () => {
    const fetchImpl = vi.fn(async () =>
      responseAt('https://cdn.files.example.com/signed/1?sig=x', new Uint8Array([0xff, 0x00])),
    );
    const r = await runBinaryFetch(binReq({ url: 'https://example.com/download/1' }).init, DOMAINS, {
      fetch: fetchImpl,
    });
    expect(r).toMatchObject({ ok: true, url: 'https://cdn.files.example.com/signed/1?sig=x' });
    if (r.ok) expect(Array.from(fromB64(r.body))).toEqual([0xff, 0x00]);
  });

  it('refuses a redirect that LEFT the declared domains, before reading a byte, without echoing the URL', async () => {
    const t = trackedStream([new Uint8Array([1, 2, 3])]);
    const fetchImpl = vi.fn(async () =>
      responseAt('https://mail.example.org/inbox?token=SECRET', t.stream),
    );
    const r = await runBinaryFetch(binReq().init, DOMAINS, { fetch: fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not in domains \[example\.com\]/);
    expect(r.error).toContain('mail.example.org');
    expect(r.error).not.toContain('SECRET');
    expect(t.pulled()).toBe(0);
    expect(t.cancelled()).toBe(true);
  });

  it('refuses EARLY when content-length is over the cap — the body is never read', async () => {
    const t = trackedStream([new Uint8Array(4)]);
    const fetchImpl = vi.fn(async () =>
      responseAt('https://files.example.com/big', t.stream, { headers: { 'content-length': '11' } }),
    );
    const r = await runBinaryFetch(binReq().init, DOMAINS, { fetch: fetchImpl, maxBytes: 10 });
    expect(r).toEqual({
      ok: false,
      code: RESPONSE_TOO_LARGE_CODE,
      error: responseTooLargeMessage({ limitBytes: 10, declaredBytes: 11 }),
    });
    expect(t.pulled()).toBe(0);
    expect(t.cancelled()).toBe(true);
  });

  it('refuses WHILE STREAMING when there is no content-length', async () => {
    const t = trackedStream([new Uint8Array(6), new Uint8Array(6), new Uint8Array(6)]);
    const fetchImpl = vi.fn(async () => responseAt('https://files.example.com/big', t.stream));
    const r = await runBinaryFetch(binReq().init, DOMAINS, { fetch: fetchImpl, maxBytes: 10 });
    expect(r).toEqual({
      ok: false,
      code: RESPONSE_TOO_LARGE_CODE,
      error: responseTooLargeMessage({ limitBytes: 10 }),
    });
    // Stopped at the chunk that crossed the cap, not after draining the rest.
    expect(t.pulled()).toBeLessThan(3);
    expect(t.cancelled()).toBe(true);
  });

  it('refuses WHILE STREAMING when content-length lies low', async () => {
    const t = trackedStream([new Uint8Array(8), new Uint8Array(8)]);
    const fetchImpl = vi.fn(async () =>
      responseAt('https://files.example.com/big', t.stream, { headers: { 'content-length': '5' } }),
    );
    const r = await runBinaryFetch(binReq().init, DOMAINS, { fetch: fetchImpl, maxBytes: 10 });
    expect(r).toMatchObject({ ok: false, code: RESPONSE_TOO_LARGE_CODE });
  });

  it('accepts a body exactly at the cap', async () => {
    const fetchImpl = vi.fn(async () =>
      responseAt('https://files.example.com/ok', new Uint8Array(10), { headers: { 'content-length': '10' } }),
    );
    const r = await runBinaryFetch(binReq().init, DOMAINS, { fetch: fetchImpl, maxBytes: 10 });
    expect(r.ok).toBe(true);
  });

  it('defaults the cap to MAX_BINARY_RESPONSE_BYTES', async () => {
    const fetchImpl = vi.fn(async () =>
      responseAt('https://files.example.com/big', null, {
        headers: { 'content-length': String(MAX_BINARY_RESPONSE_BYTES + 1) },
      }),
    );
    const r = await runBinaryFetch(binReq().init, DOMAINS, { fetch: fetchImpl });
    expect(r).toMatchObject({ ok: false, code: RESPONSE_TOO_LARGE_CODE });
  });

  it('answers a zero-byte body as an empty base64 string', async () => {
    const fetchImpl = vi.fn(async () => responseAt('https://files.example.com/empty', null, { status: 204 }));
    const r = await runBinaryFetch(binReq().init, DOMAINS, { fetch: fetchImpl });
    expect(r).toMatchObject({ ok: true, status: 204, body: '', headers: {} });
  });

  it('turns a network failure into a fetch-threw error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const r = await runBinaryFetch(binReq().init, DOMAINS, { fetch: fetchImpl });
    expect(r).toEqual({ ok: false, error: 'fetch threw: Failed to fetch' });
  });

  it('times out and aborts a stalled transfer', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const r = await runBinaryFetch(binReq().init, DOMAINS, { fetch: fetchImpl as never, timeoutMs: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/timed out after 5ms/);
  });

  it('refuses an oversize request body before any request', async () => {
    const fetchImpl = vi.fn();
    const r = await runBinaryFetch(
      { ...binReq().init, method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) },
      DOMAINS,
      { fetch: fetchImpl as never },
    );
    expect(r).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('handleFetchRequest with responseType base64', () => {
  let tabMessages: unknown[];
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sent.length = 0;
    tabMessages = [];
    (globalThis as { chrome?: unknown }).chrome = {
      tabs: {
        query: async () => [{ id: 1, url: 'https://example.com/home' }],
        sendMessage: async (_id: number, message: unknown) => {
          tabMessages.push(message);
          return { ok: true, status: 200, url: 'https://example.com/', body: 'text' };
        },
      },
    };
    fetchSpy = vi.fn(async () =>
      responseAt('https://files.example.com/doc/1?sig=abc', ALL_BYTES, {
        headers: { 'content-type': 'application/pdf' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    mcpCapabilities.delete(MCP_ID);
    delete (globalThis as { chrome?: unknown }).chrome;
    vi.unstubAllGlobals();
  });

  it('fetches from the background — no tab is messaged — and answers with a marked, valid frame', async () => {
    mcpCapabilities.set(MCP_ID, ['fetch']);
    await handleFetchRequest(MCP_ID, binReq(), DOMAINS);
    expect(tabMessages).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    const inner = sent[0]!.inner;
    expect(inner).toMatchObject({
      type: 'response',
      id: 9,
      ok: true,
      op: 'fetch',
      status: 200,
      url: 'https://files.example.com/doc/1?sig=abc',
      bodyEncoding: 'base64',
      headers: { 'content-type': 'application/pdf' },
    });
    expect(Array.from(fromB64(inner.body as string))).toEqual(Array.from(ALL_BYTES));
    // What the MCP's validator will see.
    expect(() => validateInnerFrame(inner)).not.toThrow();
  });

  it('refuses a request URL outside the declared domains before any fetch', async () => {
    mcpCapabilities.set(MCP_ID, ['fetch']);
    await handleFetchRequest(MCP_ID, binReq({ url: 'https://bank.example.org/statement.pdf' }), DOMAINS);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sent[0]!.inner).toMatchObject({ ok: false, op: 'fetch' });
    expect(String(sent[0]!.inner.error)).toMatch(/not in domains/);
  });

  it('refuses inPage together with base64 — the binary path never runs in a page', async () => {
    mcpCapabilities.set(MCP_ID, ['fetch', 'fetch_in_page']);
    await handleFetchRequest(MCP_ID, binReq({ inPage: true }), DOMAINS);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tabMessages).toHaveLength(0);
    expect(sent[0]!.inner).toMatchObject({ ok: false, op: 'fetch' });
    expect(String(sent[0]!.inner.error)).toMatch(/inPage/);
  });

  it('forwards the typed size refusal with its code', async () => {
    mcpCapabilities.set(MCP_ID, ['fetch']);
    fetchSpy.mockImplementation(async () =>
      responseAt('https://files.example.com/huge', null, {
        headers: { 'content-length': String(MAX_BINARY_RESPONSE_BYTES + 1) },
      }),
    );
    await handleFetchRequest(MCP_ID, binReq(), DOMAINS);
    expect(sent[0]!.inner).toMatchObject({
      ok: false,
      op: 'fetch',
      code: RESPONSE_TOO_LARGE_CODE,
    });
    expect(() => validateInnerFrame(sent[0]!.inner)).not.toThrow();
  });

  it('text mode is unchanged: the tab serves it, and the answer carries no bodyEncoding or headers', async () => {
    mcpCapabilities.set(MCP_ID, ['fetch']);
    const { responseType: _drop, ...textInit } = binReq().init;
    void _drop;
    await handleFetchRequest(MCP_ID, { ...binReq(), init: { ...textInit, url: 'https://example.com/page' } }, DOMAINS);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tabMessages).toHaveLength(1);
    expect(Object.keys(sent[0]!.inner).sort()).toEqual(['body', 'id', 'ok', 'op', 'status', 'type', 'url']);
  });
});
