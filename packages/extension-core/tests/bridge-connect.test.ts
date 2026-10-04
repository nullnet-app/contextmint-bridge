import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_CONNECT_FINISH_CONTEXT,
  BRIDGE_CONNECT_MESSAGE_TYPE,
  BRIDGE_CONNECT_START_CONTEXT,
  bridgeConnectFinishMessage,
  bridgeConnectStartMessage,
  connectPageUrl,
} from '../src/bridge-connect.js';
import { BRIDGE_CONNECT_STATUS_KEY, configuredConnectOrigins, onBridgeConnectApproval, PENDING_BRIDGE_CONNECT_KEY, validConnectApproval, type ConnectApprovalDeps } from '../src/background/bridge-connect.js';
import { bridgeConnectRelayMessage } from '../src/bridge-connect-relay.js';
import { freshVault, installChromeLocal, chromeSession } from './helpers/vault.js';
import { loadOrCreateExtensionIdentity } from '../src/extension-identity.js';
import { loadRemoteTargets, saveRemoteTargets } from '../src/vault-records.js';
import { state } from '../src/background/state.js';
import { AccountTrustStore } from '../src/account-trust-store.js';

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
  let reconcileLinks: ReturnType<typeof vi.fn<() => Promise<void>>>;
  const deps = (): ConnectApprovalDeps => ({ finish, loadTargets: loadRemoteTargets, saveTargets: saveRemoteTargets, reconcileLinks });

  beforeEach(async () => {
    freshVault();
    local = installChromeLocal();
    pending = { ...pending, expiresAt: Date.now() + 60_000 };
    finishCalls = 0;
    reconcileLinks = vi.fn(async () => {});
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
    // The first delivery is parked inside finish (after the vault reads that precede it).
    await vi.waitFor(() => expect(finishCalls).toBe(1));
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
    expect(targets[0]?.connectApproved).toBe(true);
    expect(targets[0]?.connectAccount).toEqual({ slug: 'owner', displayName: 'Owner account' });
    expect(JSON.stringify(local.data)).not.toContain(`mcpb_${'T'.repeat(43)}`);
    expect((await onBridgeConnectApproval(msg, sender, Date.now(), deps())).ok).toBe(false);
    expect(finishCalls).toBe(1);
  });
  // Live 2026-10-04: Connect saved the new target and then told the worker to
  // reconcile with runtime.sendMessage — which is never delivered to the
  // sending context, i.e. this same worker. The new bridge was never dialled
  // and the old link kept retrying a credential Connect had just revoked
  // (endless HTTP 401). The worker must reconcile its own links directly.
  it('reconciles the live links in the worker itself once the new target is saved', async () => {
    let targetsAtReconcile: unknown[] | undefined;
    reconcileLinks = vi.fn(async () => { targetsAtReconcile = await loadRemoteTargets(); });
    const result = await onBridgeConnectApproval(msg, sender, Date.now(), deps());
    expect(result.ok).toBe(true);
    expect(reconcileLinks).toHaveBeenCalledTimes(1);
    expect(targetsAtReconcile).toHaveLength(1);
  });

  it('does not reconcile when nothing was saved', async () => {
    finish = async () => ({ ok: false, reason: 'gateway said no' });
    expect((await onBridgeConnectApproval(msg, sender, Date.now(), deps())).ok).toBe(false);
    expect(reconcileLinks).not.toHaveBeenCalled();
  });

  it('still reports success when the reconcile throws (boot re-reads the vault)', async () => {
    reconcileLinks = vi.fn(async () => { throw new Error('boom'); });
    expect((await onBridgeConnectApproval(msg, sender, Date.now(), deps())).ok).toBe(true);
    expect(await loadRemoteTargets()).toHaveLength(1);
  });

  // Live 2026-10-04: pressing Connect again on a browser that already had the
  // gateway's bridge. `finish` mints a new credential AND revokes this
  // browser's previous one for that account (closing it 4003); the handler
  // then refused to save the new one because the URL was already configured,
  // leaving the browser on the revoked token, looping on HTTP 401.
  describe('a bridge with the same URL is already configured', () => {
    const URL_ = 'wss://mcp.nullnet.app/bridge';
    const OLD_TOKEN = `mcpb_${'O'.repeat(43)}`;
    const NEW_TOKEN = `mcpb_${'T'.repeat(43)}`;
    const trustRecord = (slug: string, tokenId = 'brt_old') => ({
      origin: ORIGIN, accountId: `acct_${slug}`, slug, displayName: `${slug} account`, tokenId,
      kid: 'kid', publicKey: 'pk', generation: 1, generationHighWater: 1, approvedAt: 1,
    });

    it('replaces a Connect-made target for the same account and dials the new credential', async () => {
      await saveRemoteTargets([{ id: 'cold', url: URL_, token: OLD_TOKEN, tokenId: 'brt_old', connectApproved: true, connectAccount: { slug: 'owner', displayName: 'Owner account' }, label: 'Chrome on laptop', enabled: false }]);
      let targetsAtReconcile: Awaited<ReturnType<typeof loadRemoteTargets>> | undefined;
      reconcileLinks = vi.fn(async () => { targetsAtReconcile = await loadRemoteTargets(); });
      const result = await onBridgeConnectApproval(msg, sender, Date.now(), deps());
      expect(result).toEqual({ ok: true });
      const targets = await loadRemoteTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({ url: URL_, token: NEW_TOKEN, tokenId: 'brt_attached', connectApproved: true, connectAccount: { slug: 'owner', displayName: 'Owner account' }, enabled: true });
      // A new credential is a new link: the old link (and its refusal/backoff) goes away.
      expect(targets[0]?.id).not.toBe('cold');
      expect(reconcileLinks).toHaveBeenCalledTimes(1);
      expect(targetsAtReconcile?.[0]?.tokenId).toBe('brt_attached');
      expect(chromeSession().data[BRIDGE_CONNECT_STATUS_KEY]).toBe('Connected to Owner account');
    });

    it('replaces a same-account target whose Connect consent was already consumed by account trust', async () => {
      // After the first account-key frame, putApproved strips connectApproved
      // and connectAccount from the row; the trust record still names the account.
      await saveRemoteTargets([{ id: 'cold', url: URL_, token: OLD_TOKEN, tokenId: 'brt_old', label: 'Chrome on laptop', enabled: true }]);
      await new AccountTrustStore().put(trustRecord('owner'));
      expect((await onBridgeConnectApproval(msg, sender, Date.now(), deps())).ok).toBe(true);
      const targets = await loadRemoteTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({ token: NEW_TOKEN, tokenId: 'brt_attached', connectApproved: true });
      expect(reconcileLinks).toHaveBeenCalledTimes(1);
    });

    it('still replaces it when the revocation close lands while finish is in flight', async () => {
      // The gateway closes the old credential 4003 in the same batch as
      // finish; socket.ts then runs deleteByToken, which deletes the trust
      // record and strips connectApproved before finish's response arrives.
      await saveRemoteTargets([{ id: 'cold', url: URL_, token: OLD_TOKEN, tokenId: 'brt_old', label: 'Chrome on laptop', enabled: true }]);
      await new AccountTrustStore().put(trustRecord('owner'));
      const inner = finish;
      finish = async (...args) => { await new AccountTrustStore().deleteByToken('brt_old'); return inner(...args); };
      expect((await onBridgeConnectApproval(msg, sender, Date.now(), deps())).ok).toBe(true);
      expect((await loadRemoteTargets())[0]?.tokenId).toBe('brt_attached');
    });

    it('does not replace a hand-pasted target and says how to recover from the revoked credential', async () => {
      await saveRemoteTargets([{ id: 'pasted', url: URL_, token: OLD_TOKEN, label: 'My bridge', enabled: true }]);
      const result = await onBridgeConnectApproval(msg, sender, Date.now(), deps());
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/revoked/);
      expect(result.reason).toMatch(/remove/i);
      expect(result.reason).toMatch(/Connect again/);
      expect(chromeSession().data[BRIDGE_CONNECT_STATUS_KEY]).toBe(result.reason);
      expect((result.reason ?? '').length).toBeLessThanOrEqual(160);
      expect(await loadRemoteTargets()).toEqual([{ id: 'pasted', url: URL_, token: OLD_TOKEN, label: 'My bridge', enabled: true }]);
      expect(reconcileLinks).not.toHaveBeenCalled();
    });

    it('does not replace a pasted target even when its trust record names the same account by another token', async () => {
      await saveRemoteTargets([{ id: 'pasted', url: URL_, token: OLD_TOKEN, tokenId: 'brt_old', enabled: true }]);
      await new AccountTrustStore().put(trustRecord('owner', 'brt_someone_else'));
      expect((await onBridgeConnectApproval(msg, sender, Date.now(), deps())).ok).toBe(false);
      expect((await loadRemoteTargets())[0]?.id).toBe('pasted');
    });

    it('does not replace a Connect-made target for a different account', async () => {
      await saveRemoteTargets([{ id: 'cother', url: URL_, token: OLD_TOKEN, tokenId: 'brt_old', connectApproved: true, connectAccount: { slug: 'other', displayName: 'Other account' }, enabled: true }]);
      const result = await onBridgeConnectApproval(msg, sender, Date.now(), deps());
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/remove/i);
      expect(result.reason).toMatch(/Connect again/);
      expect((result.reason ?? '').length).toBeLessThanOrEqual(160);
      const targets = await loadRemoteTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({ id: 'cother', token: OLD_TOKEN, connectAccount: { slug: 'other' } });
      expect(reconcileLinks).not.toHaveBeenCalled();
    });

    it('does not replace a consumed-consent target whose trust record names a different account', async () => {
      await saveRemoteTargets([{ id: 'cother', url: URL_, token: OLD_TOKEN, tokenId: 'brt_old', enabled: true }]);
      await new AccountTrustStore().put(trustRecord('other'));
      expect((await onBridgeConnectApproval(msg, sender, Date.now(), deps())).ok).toBe(false);
      expect((await loadRemoteTargets())[0]?.id).toBe('cother');
    });
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
