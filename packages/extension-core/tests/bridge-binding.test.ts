import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { toB64, fromB64 } from '@fetchproxy/protocol';

import {
  loadOrCreateExtensionIdentity,
  type ExtensionIdentity,
} from '../src/extension-identity.js';
import {
  BRIDGE_BIND_CONTEXT,
  bindCredential,
  bridgeBindMessage,
  gatewayOriginFor,
  isBridgeTokenId,
  redeemPairingCode,
  redeemRequestBody,
  signExtensionBinding,
} from '../src/bridge-binding.js';
import { freshVault } from './helpers/vault.js';

/**
 * Binding the bridge credential to THIS extension's identity (mcp-host plan
 * task C2, spec 2026-09-27-account-level-bridge-pairing-design.md §4.3,
 * invariant I-13's extension half).
 *
 * The gateway verifies (mcp-host `packages/core/src/bridge-binding.ts`):
 *
 *   Ed25519(extEd25519Priv, "mcp-host/bridge-bind/v1" NUL origin NUL subject
 *                           NUL b64(x25519Pub) NUL b64(ed25519Pub))
 *
 * `verifyGateway` below is that verifier, restated byte for byte in this
 * test rather than imported from the code under test: if the extension ever
 * drops, reorders or swaps a field, the signature stops verifying HERE, which
 * is exactly what the gateway would do.
 */

const ORIGIN = 'https://gw.test';

/** mcp-host core `verifyBridgeBind`, restated. */
async function verifyGateway(
  origin: string,
  subject: string,
  body: { x25519Pub: string; ed25519Pub: string; sig: string },
): Promise<boolean> {
  const message = new TextEncoder().encode(
    ['mcp-host/bridge-bind/v1', origin, subject, body.x25519Pub, body.ed25519Pub].join('\0'),
  );
  const key = await crypto.subtle.importKey(
    'raw',
    fromB64(body.ed25519Pub) as BufferSource,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('Ed25519', key, fromB64(body.sig) as BufferSource, message);
}

let identity: ExtensionIdentity;

beforeEach(async () => {
  freshVault();
  identity = await loadOrCreateExtensionIdentity();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bridgeBindMessage', () => {
  it('is the context, origin, subject and both keys, NUL-separated — the gateway spelling', () => {
    const message = new TextDecoder().decode(bridgeBindMessage('https://o', 'brt_1', 'X', 'E'));
    expect(message).toBe('mcp-host/bridge-bind/v1\0https://o\0brt_1\0X\0E');
    expect(BRIDGE_BIND_CONTEXT).toBe('mcp-host/bridge-bind/v1');
  });
});

describe('gatewayOriginFor', () => {
  it('is the https origin of a wss bridge URL — what the gateway configures as OAUTH_RESOURCE', () => {
    expect(gatewayOriginFor('wss://mcp.nullnet.app/bridge')).toBe('https://mcp.nullnet.app');
    expect(gatewayOriginFor('wss://gw.test:8443/some/path?x=1')).toBe('https://gw.test:8443');
  });

  it('keeps plain http only for a loopback ws:// bridge', () => {
    expect(gatewayOriginFor('ws://127.0.0.1:8787/bridge')).toBe('http://127.0.0.1:8787');
    expect(gatewayOriginFor('ws://localhost:8787/bridge')).toBe('http://localhost:8787');
  });

  it('refuses anything a remote target could not be', () => {
    expect(gatewayOriginFor('ws://evil.example/bridge')).toBeNull();
    expect(gatewayOriginFor('https://gw.test/bridge')).toBeNull();
    expect(gatewayOriginFor('not a url')).toBeNull();
  });
});

describe('isBridgeTokenId', () => {
  it('accepts a brt_ id and nothing else', () => {
    expect(isBridgeTokenId('brt_0123456789abcdef01234567')).toBe(true);
    expect(isBridgeTokenId('brt_one')).toBe(true);
    expect(isBridgeTokenId('b1')).toBe(false);
    expect(isBridgeTokenId('brt_')).toBe(false);
    expect(isBridgeTokenId('brt_a\0b')).toBe(false);
    expect(isBridgeTokenId('brt_' + 'a'.repeat(200))).toBe(false);
    expect(isBridgeTokenId(7)).toBe(false);
  });
});

describe('signExtensionBinding', () => {
  it('names THIS extension’s identity keys and signs with its vault key', async () => {
    const body = await signExtensionBinding(identity, ORIGIN, 'brt_1');
    expect(body.x25519Pub).toBe(toB64(identity.x25519Pub));
    expect(body.ed25519Pub).toBe(toB64(identity.ed25519Pub));
    expect(await verifyGateway(ORIGIN, 'brt_1', body)).toBe(true);
  });

  it('does not verify for another subject or another gateway (no replay)', async () => {
    const body = await signExtensionBinding(identity, ORIGIN, 'brt_1');
    expect(await verifyGateway(ORIGIN, 'brt_2', body)).toBe(false);
    expect(await verifyGateway('https://other.test', 'brt_1', body)).toBe(false);
  });
});

describe('redeemRequestBody', () => {
  it('carries the code as sent and an extension block signed over that exact code', async () => {
    const body = await redeemRequestBody(identity, ORIGIN, '1234-5678');
    expect(Object.keys(body).sort()).toEqual(['code', 'extension']);
    expect(body.code).toBe('1234-5678');
    expect(Object.keys(body.extension).sort()).toEqual(['ed25519Pub', 'sig', 'x25519Pub']);
    expect(await verifyGateway(ORIGIN, '1234-5678', body.extension)).toBe(true);
    // The code AS SENT is the subject: a normalised spelling is a different message.
    expect(await verifyGateway(ORIGIN, '12345678', body.extension)).toBe(false);
  });
});

type FetchCall = { url: string; init: RequestInit };

function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('redeemPairingCode', () => {
  const TOKEN = 'mcpb_' + 'A'.repeat(43);
  const created = (over: Record<string, unknown> = {}) =>
    json(201, {
      id: 'brt_0123456789abcdef01234567',
      name: 'Chrome at home',
      bound: true,
      token: TOKEN,
      bridgeUrl: 'wss://gw.test/bridge',
      ...over,
    });

  it('POSTs the signed body to the gateway origin it is about to dial, and returns a bound target', async () => {
    const calls = stubFetch(() => created());
    const result = await redeemPairingCode(identity, ORIGIN, '1234-5678');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://gw.test/api/v1/bridge-tokens/redeem');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.redirect).toBe('error');
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.code).toBe('1234-5678');
    expect(await verifyGateway(ORIGIN, '1234-5678', sent.extension)).toBe(true);
    expect(result).toEqual({
      ok: true,
      target: {
        url: 'wss://gw.test/bridge',
        token: TOKEN,
        tokenId: 'brt_0123456789abcdef01234567',
        label: 'Chrome at home',
      },
      bound: true,
    });
  });

  it('refuses a response that points the extension at a DIFFERENT bridge host', async () => {
    stubFetch(() => created({ bridgeUrl: 'wss://evil.example/bridge' }));
    const result = await redeemPairingCode(identity, ORIGIN, '1234-5678');
    expect(result.ok).toBe(false);
  });

  it('refuses a response whose credential or id it could not use', async () => {
    for (const bad of [{ token: 'has=padding' }, { id: 'nope' }, { token: undefined }]) {
      stubFetch(() => created(bad));
      expect((await redeemPairingCode(identity, ORIGIN, '1234-5678')).ok).toBe(false);
    }
  });

  it('passes the gateway’s one refusal sentence through and never throws', async () => {
    stubFetch(() => json(400, { error: 'that pairing code is not valid' }));
    expect(await redeemPairingCode(identity, ORIGIN, '0000-0000')).toEqual({
      ok: false,
      reason: 'that pairing code is not valid',
    });
    stubFetch(() => {
      throw new TypeError('network down');
    });
    expect((await redeemPairingCode(identity, ORIGIN, '0000-0000')).ok).toBe(false);
  });

  it('refuses an origin that is not a gateway origin before sending anything', async () => {
    const calls = stubFetch(() => created());
    expect((await redeemPairingCode(identity, 'http://evil.example', '1')).ok).toBe(false);
    expect((await redeemPairingCode(identity, 'https://gw.test/path', '1')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('bindCredential', () => {
  const TOKEN = 'mcpb_' + 'C'.repeat(43);
  const ID = 'brt_0123456789abcdef01234567';

  it('POSTs /bridge/bind on the bridge’s own origin, bearer the credential, signed over the token id', async () => {
    const calls = stubFetch(() => json(200, { id: ID, bound: true, extensionFingerprint: 'x' }));
    const outcome = await bindCredential(identity, 'wss://gw.test/bridge', ID, TOKEN);
    expect(outcome).toBe('bound');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://gw.test/bridge/bind');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.redirect).toBe('error');
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(Object.keys(sent).sort()).toEqual(['ed25519Pub', 'sig', 'x25519Pub']);
    expect(await verifyGateway('https://gw.test', ID, sent)).toBe(true);
  });

  it('maps every gateway answer to what the caller must remember', async () => {
    const cases: Array<[Response | (() => never), string]> = [
      [json(409, { error: 'bound to a different extension' }), 'conflict'],
      [new Response('not found', { status: 404 }), 'unsupported'],
      [json(401, { error: 'unknown or revoked bridge credential' }), 'refused'],
      [json(400, { error: 'bad signature' }), 'refused'],
      [json(429, { error: 'slow down' }), 'retry'],
      [json(503, { error: 'no origin' }), 'retry'],
      [json(500, {}), 'retry'],
      [
        () => {
          throw new TypeError('offline');
        },
        'retry',
      ],
    ];
    for (const [answer, expected] of cases) {
      stubFetch(() => (typeof answer === 'function' ? answer() : answer.clone()));
      expect(await bindCredential(identity, 'wss://gw.test/bridge', ID, TOKEN)).toBe(expected);
    }
  });

  it('a 200 that does not say bound is not believed', async () => {
    stubFetch(() => json(200, { id: ID }));
    expect(await bindCredential(identity, 'wss://gw.test/bridge', ID, TOKEN)).toBe('retry');
  });

  it('sends nothing for a URL that is not a bridge URL, or an id that is not a token id', async () => {
    const calls = stubFetch(() => json(200, { bound: true }));
    expect(await bindCredential(identity, 'ws://evil.example/bridge', ID, TOKEN)).toBe('refused');
    expect(await bindCredential(identity, 'wss://gw.test/bridge', 'b1', TOKEN)).toBe('refused');
    expect(calls).toHaveLength(0);
  });
});
