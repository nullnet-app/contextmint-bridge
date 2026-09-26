import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InnerRequest } from '@fetchproxy/protocol';

/**
 * Defence in depth behind the hello-time refusal: a session that was GRANTED
 * a capability this browser cannot serve — a trust record approved before the
 * capability seam existed, or an API that vanished — is answered with the
 * op-echoing error rather than entering a handler that would reach for an
 * absent `chrome.*` namespace.
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
vi.stubGlobal('chrome', {
  runtime: { getManifest: () => ({ version: '1.0.0' }) },
  tabs: { query: async () => [], create: async () => ({ id: 1 }), sendMessage: async () => undefined },
});

const { handleRequest } = await import('../src/background/handlers/dispatch.js');
const { mcpDomains, mcpCapabilities } = await import('../src/background/session-scope.js');

const MCP = 'etix-mcp:1.0.0:0123456789abcdef';

describe('dispatch refuses a granted capability this browser cannot serve', () => {
  beforeEach(() => {
    sent.length = 0;
    downloadHandler.mockClear();
    fetchHandler.mockClear();
    mcpDomains.set(MCP, ['etix.com']);
    mcpCapabilities.set(MCP, ['fetch', 'download']);
  });

  it('answers the op-echoing error and never enters the download handler', async () => {
    await handleRequest(MCP, {
      type: 'request',
      id: 'r1',
      op: 'download',
      url: 'https://etix.com/ticket.pdf',
    } as unknown as InnerRequest);
    expect(downloadHandler).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        type: 'response',
        id: 'r1',
        ok: false,
        op: 'download',
        error: 'capability "download" is not available in this browser',
      },
    ]);
  });

  it('still serves a capability the browser has', async () => {
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
