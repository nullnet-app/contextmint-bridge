import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The production wiring of the Connect approval path: with NO injected deps,
 * a successful Connect must reconcile the worker's remote links through
 * socket.ts's `loadRemoteLinks` — the same function boot's
 * `remote-targets-changed` listener calls — rather than by messaging itself
 * with `chrome.runtime.sendMessage`, which never reaches the sending context.
 */

const loadRemoteLinks = vi.fn(async () => {});
vi.mock('../src/background/socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/socket.js')>()),
  loadRemoteLinks,
}));
vi.mock('../src/bridge-connect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/bridge-connect.js')>()),
  finishBridgeConnect: vi.fn(async () => ({
    ok: true,
    credential: {
      token: `mcpb_${'T'.repeat(43)}`,
      tokenId: 'brt_attached',
      name: 'Chrome on laptop',
      bridgeUrl: 'wss://mcp.nullnet.app/bridge',
      account: { slug: 'owner', displayName: 'Owner account' },
    },
  })),
}));

const { onBridgeConnectApproval, PENDING_BRIDGE_CONNECT_KEY } = await import('../src/background/bridge-connect.js');
const { freshVault, installChromeLocal, chromeSession } = await import('./helpers/vault.js');
const { loadOrCreateExtensionIdentity } = await import('../src/extension-identity.js');
const { loadRemoteTargets } = await import('../src/vault-records.js');
const { state } = await import('../src/background/state.js');

const ORIGIN = 'https://mcp.nullnet.app';
const requestId = 'bcr_00112233445566778899aabbccddeeff';
const msg = { type: 'mcp-host-bridge-connect-approval', requestId, approval: 'BBBBBBBBBBBBBBBBBBBBBB' };
const sender = { tab: { id: 9 }, frameId: 0, url: `${ORIGIN}/bridge/connect?request=${requestId}`, origin: ORIGIN };

describe('Connect approval default deps', () => {
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    freshVault();
    installChromeLocal();
    // A real browser never delivers runtime.sendMessage to its own sender, so
    // a spy that does nothing is exactly what the worker sees.
    sendMessage = vi.fn(async () => undefined);
    (globalThis as { chrome: { runtime?: unknown } }).chrome.runtime = { sendMessage };
    loadRemoteLinks.mockClear();
    state.extIdentity = await loadOrCreateExtensionIdentity();
    chromeSession().data[PENDING_BRIDGE_CONNECT_KEY] = {
      '9': { tabId: 9, origin: ORIGIN, requestId, nonce: 'AAAAAAAAAAAAAAAAAAAAAA', expiresAt: Date.now() + 60_000 },
    };
  });

  it('dials the newly connected bridge by reconciling links in the worker', async () => {
    const result = await onBridgeConnectApproval(msg, sender);
    expect(result.ok).toBe(true);
    expect(await loadRemoteTargets()).toHaveLength(1);
    expect(loadRemoteLinks).toHaveBeenCalledTimes(1);
  });
});
