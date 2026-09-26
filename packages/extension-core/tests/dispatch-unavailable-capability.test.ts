import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InnerRequest } from '@fetchproxy/protocol';

/**
 * #418: a request for a capability this browser cannot serve is answered with
 * the TYPED error — `code: 'capability_unavailable'` and the fixed wording that
 * names the browser — rather than entering a handler that would reach for an
 * absent `chrome.*` namespace.
 *
 * Checked BEFORE the grant. Since #418 the hello grants the servable subset,
 * so an unavailable capability is normally absent from the grant; answering
 * "not granted" for it would blame the MCP's code for the browser's gap, which
 * is exactly the mis-blame the typed error exists to remove. The ordering
 * reveals nothing: the extension hello already lists what is unavailable.
 */

// Hoisted with the mocks below, which vitest lifts above every import.
const { sent, downloadHandler, fetchHandler } = vi.hoisted(() => ({
  sent: [] as unknown[],
  downloadHandler: vi.fn(async () => undefined),
  fetchHandler: vi.fn(async () => undefined),
}));
vi.mock('../src/background/send-inner.js', () => ({
  sendInner: async (_mcpId: string, frame: unknown) => void sent.push(frame),
}));
vi.mock('../src/background/handlers/download.js', () => ({
  handleDownloadRequest: downloadHandler,
}));
vi.mock('../src/background/handlers/fetch.js', () => ({
  handleFetchRequest: fetchHandler,
}));

// Safari 27's shape: no `downloads` namespace at all.
vi.stubGlobal('__FETCHPROXY_PLATFORM__', 'safari');
vi.stubGlobal('chrome', {
  runtime: { getManifest: () => ({ version: '1.0.0' }) },
  tabs: { query: async () => [], create: async () => ({ id: 1 }), sendMessage: async () => undefined },
});

const { handleRequest } = await import('../src/background/handlers/dispatch.js');
const { mcpDomains, mcpCapabilities } = await import('../src/background/session-scope.js');

const MCP = 'etix-mcp:1.0.0:0123456789abcdef';

const UNAVAILABLE = {
  type: 'response',
  id: 'r1',
  ok: false,
  op: 'download',
  code: 'capability_unavailable',
  error: 'capability "download" is not available in this browser (safari)',
};

describe('dispatch answers a capability this browser cannot serve with the typed error', () => {
  beforeEach(() => {
    sent.length = 0;
    downloadHandler.mockClear();
    fetchHandler.mockClear();
    mcpDomains.set(MCP, ['etix.com']);
  });

  const downloadReq = {
    type: 'request',
    id: 'r1',
    op: 'download',
    url: 'https://etix.com/ticket.pdf',
  } as unknown as InnerRequest;

  it('when the session was granted it (a record approved before #418)', async () => {
    mcpCapabilities.set(MCP, ['fetch', 'download']);
    await handleRequest(MCP, downloadReq);
    expect(downloadHandler).not.toHaveBeenCalled();
    expect(sent).toEqual([UNAVAILABLE]);
  });

  it('when the grant left it out because the browser cannot serve it — never "not granted"', async () => {
    mcpCapabilities.set(MCP, ['fetch']);
    await handleRequest(MCP, downloadReq);
    expect(downloadHandler).not.toHaveBeenCalled();
    expect(sent).toEqual([UNAVAILABLE]);
    expect(JSON.stringify(sent)).not.toContain('not granted');
  });

  it('still answers "not granted" for a servable capability outside the grant', async () => {
    mcpCapabilities.set(MCP, ['fetch']);
    await handleRequest(MCP, {
      type: 'request',
      id: 'r3',
      op: 'read_cookies',
      keys: ['sid'],
    } as unknown as InnerRequest);
    expect(sent).toEqual([
      {
        type: 'response',
        id: 'r3',
        ok: false,
        op: 'read_cookies',
        error: 'capability "read_cookies" not granted (declared: [fetch])',
      },
    ]);
  });

  it('still serves a capability the browser has', async () => {
    mcpCapabilities.set(MCP, ['fetch', 'download']);
    await handleRequest(MCP, {
      type: 'request',
      id: 'r2',
      op: 'fetch',
      url: 'https://etix.com/',
      method: 'GET',
    } as unknown as InnerRequest);
    expect(fetchHandler).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
  });
});
