import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_CONNECT_FINISH_CONTEXT,
  BRIDGE_CONNECT_MESSAGE_TYPE,
  BRIDGE_CONNECT_START_CONTEXT,
  bridgeConnectFinishMessage,
  bridgeConnectStartMessage,
  connectPageUrl,
} from '../src/bridge-connect.js';
import { configuredConnectOrigins, onBridgeConnectApproval, PENDING_BRIDGE_CONNECT_KEY, validConnectApproval, type ConnectApprovalDeps } from '../src/background/bridge-connect.js';
import { bridgeConnectRelayMessage } from '../src/bridge-connect-relay.js';
import { freshVault, installChromeLocal, chromeSession } from './helpers/vault.js';
import { loadOrCreateExtensionIdentity } from '../src/extension-identity.js';
import { loadRemoteTargets, saveRemoteTargets } from '../src/vault-records.js';
import { state } from '../src/background/state.js';

const ORIGIN = 'https://mcp.nullnet.app';
const X25519 = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=';
const ED25519 = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';

describe('extension Connect wire contract (X1 vectors)', () => {
  it('uses byte-for-byte X1 start and finish messages', () => {
    expect(BRIDGE_CONNECT_START_CONTEXT).toBe('mcp-host/bridge-connect-start/v1');
    expect(BRIDGE_CONNECT_FINISH_CONTEXT).toBe('mcp-host/bridge-connect-finish/v1');
    expect(BRIDGE_CONNECT_MESSAGE_TYPE).toBe('mcp-host/bridge-connect/v1');
    expect(new TextDecoder().decode(bridgeConnectStartMessage(ORIGIN, X25519, ED25519, 1790000000))).toBe(
      `mcp-host/bridge-connect-start/v1\0${ORIGIN}\0${X25519}\0${ED25519}\0${1790000000}`,
    );
    expect(new TextDecoder().decode(bridgeConnectFinishMessage(
      ORIGIN,
      'bcr_00112233445566778899aabbccddeeff',
      'AAAAAAAAAAAAAAAAAAAAAA',
      'BBBBBBBBBBBBBBBBBBBBBB',
      X25519,
      ED25519,
    ))).toBe(
      `mcp-host/bridge-connect-finish/v1\0${ORIGIN}\0bcr_00112233445566778899aabbccddeeff\0AAAAAAAAAAAAAAAAAAAAAA\0BBBBBBBBBBBBBBBBBBBBBB\0${X25519}\0${ED25519}`,
    );
  });

  it('opens only a same-origin /bridge/connect URL with one valid request id', () => {
    const id = 'bcr_00112233445566778899aabbccddeeff';
    expect(connectPageUrl(ORIGIN, `${ORIGIN}/bridge/connect?request=${id}`, id)).toBe(
      `${ORIGIN}/bridge/connect?request=${id}`,
    );
    for (const bad of [
      `https://evil.test/bridge/connect?request=${id}`,
      `${ORIGIN}/other?request=${id}`,
      `${ORIGIN}/bridge/connect?request=${id}&extra=x`,
      `${ORIGIN}/bridge/connect?request=bad`,
      `${ORIGIN}/bridge/connect?request=${id}#fragment`,
    ]) expect(connectPageUrl(ORIGIN, bad, id)).toBeNull();
  });

  it('relays only the page-own approval from a configured origin and exact request page', () => {
    const requestId = 'bcr_00112233445566778899aabbccddeeff';
    const approval = 'BBBBBBBBBBBBBBBBBBBBBB';
    const message = { type: BRIDGE_CONNECT_MESSAGE_TYPE, requestId, approval, token: 'must-not-be-forwarded' };
    const page = { origin: ORIGIN, pathname: '/bridge/connect', search: `?request=${requestId}`, sourceIsSelf: true, allowedOrigins: [ORIGIN] };
    expect(bridgeConnectRelayMessage(message, page)).toEqual({ type: 'mcp-host-bridge-connect-approval', requestId, approval });
    expect(bridgeConnectRelayMessage(message, { ...page, sourceIsSelf: false })).toBeNull();
    expect(bridgeConnectRelayMessage(message, { ...page, origin: 'https://evil.test', allowedOrigins: [ORIGIN] })).toBeNull();
    expect(bridgeConnectRelayMessage(message, { ...page, pathname: '/other' })).toBeNull();
    expect(bridgeConnectRelayMessage({ ...message, requestId: 'bcr_ffeeddccbbaa99887766554433221100' }, page)).toBeNull();
    expect(bridgeConnectRelayMessage(message, { ...page, search: `?request=${requestId}&other=x` })).toBeNull();
  });

});

describe('Connect approval handler boundary', () => {
  const requestId = 'bcr_00112233445566778899aabbccddeeff';
  const msg = { type: 'mcp-host-bridge-connect-approval', requestId, approval: 'BBBBBBBBBBBBBBBBBBBBBB' };
  const sender = { tab: { id: 9 }, frameId: 0, url: `${ORIGIN}/bridge/connect?request=${requestId}`, origin: ORIGIN };
  let pending = { tabId: 9, origin: ORIGIN, requestId, nonce: 'AAAAAAAAAAAAAAAAAAAAAA', expiresAt: Date.now() + 60_000 };
  let local: ReturnType<typeof installChromeLocal>;
  let finish: ConnectApprovalDeps['finish'];
  let finishCalls = 0;
  const deps = (): ConnectApprovalDeps => ({ finish, loadTargets: loadRemoteTargets, saveTargets: saveRemoteTargets });

  beforeEach(async () => {
    freshVault();
    local = installChromeLocal();
    pending = { ...pending, expiresAt: Date.now() + 60_000 };
    finishCalls = 0;
    state.extIdentity = await loadOrCreateExtensionIdentity();
    chromeSession().data[PENDING_BRIDGE_CONNECT_KEY] = { '9': pending };
    finish = async () => {
      finishCalls += 1;
      return { ok: true, credential: {
        token: `mcpb_${'T'.repeat(43)}`, tokenId: 'brt_attached', name: 'Chrome on laptop',
        bridgeUrl: 'wss://mcp.nullnet.app/bridge', account: { slug: 'owner', displayName: 'Owner account' },
      } };
    };
  });

  it('does not call finish for a different tab, even with a valid approval', async () => {
    const result = await onBridgeConnectApproval(msg, { ...sender, tab: { id: 10 } }, Date.now(), deps());
    expect(result.ok).toBe(false);
    expect(finishCalls).toBe(0);
  });

  it('rejects a sub-frame, wrong origin, wrong URL, and expired request before finish', async () => {
    const variants = [
      { sender: { ...sender, frameId: 1 }, now: Date.now() },
      { sender: { ...sender, origin: 'https://evil.test' }, now: Date.now() },
      { sender: { ...sender, url: 'https://mcp.nullnet.app/other' }, now: Date.now() },
      { sender, now: pending.expiresAt },
    ];
    for (const variant of variants) {
      const result = await onBridgeConnectApproval(msg, variant.sender, variant.now, deps());
      expect(result.ok).toBe(false);
    }
    expect(finishCalls).toBe(0);
  });

  it('fixture is a valid sender/request tuple', () => {
    expect(validConnectApproval(msg, sender, pending)).toBe(true);
  });

  it('claims before awaiting so concurrent duplicate deliveries call finish only once', async () => {
    let release!: (value: Awaited<ReturnType<ConnectApprovalDeps['finish']>>) => void;
    finish = async () => new Promise((resolve) => { finishCalls += 1; release = resolve; });
    const first = onBridgeConnectApproval(msg, sender, Date.now(), deps());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await onBridgeConnectApproval(msg, sender, Date.now(), deps());
    expect(second.ok).toBe(false);
    expect(finishCalls).toBe(1);
    release({ ok: true, credential: {
      token: `mcpb_${'T'.repeat(43)}`, tokenId: 'brt_attached', name: 'Chrome on laptop', bridgeUrl: 'wss://mcp.nullnet.app/bridge', account: { slug: 'owner', displayName: 'Owner account' },
    } });
    expect((await first).ok).toBe(true);
  });

  it('stores the credential in the vault and leaves chrome.storage.local without it', async () => {
    const result = await onBridgeConnectApproval(msg, sender, Date.now(), deps());
    expect(result.ok).toBe(true);
    const targets = await loadRemoteTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.token).toBe(`mcpb_${'T'.repeat(43)}`);
    expect(JSON.stringify(local.data)).not.toContain(`mcpb_${'T'.repeat(43)}`);
    expect((await onBridgeConnectApproval(msg, sender, Date.now(), deps())).ok).toBe(false);
    expect(finishCalls).toBe(1);
  });
});

describe('configured Connect gateway origins', () => {
  it('uses the built-in origin first and accepts only bare HTTPS managed origins', async () => {
    vi.stubGlobal('chrome', { storage: { managed: { get: async () => ({ bridgeConnectOrigins: [
      'https://policy.example', 'http://insecure.example', 'https://path.example/path', 'https://policy.example',
    ] }) } } });
    expect(await configuredConnectOrigins()).toEqual(['https://mcp.nullnet.app', 'https://policy.example']);
    vi.unstubAllGlobals();
  });
});
