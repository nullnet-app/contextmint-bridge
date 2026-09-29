import { describe, expect, it, vi } from 'vitest';

import { EXTENSION_MISMATCH_CLOSE, EXTENSION_MISMATCH_MESSAGE, gatewayOriginFor, post } from '../src/bridge-gateway.js';

describe('bridge gateway helpers used by Connect', () => {
  it('derives a secure origin from a WSS bridge URL and allows HTTP only on loopback', () => {
    expect(gatewayOriginFor('wss://mcp.nullnet.app/bridge')).toBe('https://mcp.nullnet.app');
    expect(gatewayOriginFor('ws://127.0.0.1:8787/bridge')).toBe('http://127.0.0.1:8787');
    expect(gatewayOriginFor('ws://evil.example/bridge')).toBeNull();
    expect(gatewayOriginFor('https://gw.test/bridge')).toBeNull();
  });

  it('posts JSON without following redirects or carrying cookies', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}');
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await post('https://mcp.nullnet.app/bridge/connect/start', { nonce: 'n' });
      expect(fetchMock).toHaveBeenCalledOnce();
      const sent = calls[0];
      expect(sent?.url).toBe('https://mcp.nullnet.app/bridge/connect/start');
      const init = sent?.init as RequestInit;
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect(init.credentials).toBe('omit');
      expect(init.cache).toBe('no-store');
      expect(new Headers(init.headers).get('content-type')).toBe('application/json');
      expect(init.body).toBe(JSON.stringify({ nonce: 'n' }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the gateway mismatch refusal user-facing text and close code', () => {
    expect(EXTENSION_MISMATCH_CLOSE).toBe(4004);
    expect(EXTENSION_MISMATCH_MESSAGE).toBe('This bridge is paired with a different browser');
  });
});
