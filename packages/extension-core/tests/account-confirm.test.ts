import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fromB64, toB64 } from '@fetchproxy/protocol';

import {
  loadOrCreateExtensionIdentity,
  type ExtensionIdentity,
} from '../src/extension-identity.js';
import {
  ACCOUNT_CONFIRMED_CLOSE,
  BRIDGE_CONFIRM_APP_CONTEXT,
  BRIDGE_CONFIRM_FINISH_CONTEXT,
  BRIDGE_CONFIRM_MESSAGE_TYPE,
  BRIDGE_CONFIRM_START_CONTEXT,
  FACTS_CHANGED_CLOSE,
  appConfirmRequest,
  bridgeConfirmAppMessage,
  bridgeConfirmFinishMessage,
  bridgeConfirmStartMessage,
  confirmChallengeUrl,
  extensionKeyFingerprint,
  finishAccountConfirm,
  isConfirmSecret,
  startAccountConfirm,
} from '../src/account-confirm.js';
import { freshVault } from './helpers/vault.js';

/**
 * Confirming this browser for account trust — the extension half of mcp-host
 * plan task B3 (spec 2026-09-27-account-level-bridge-pairing-design.md §4.4,
 * invariant I-7), cut as C3a for the managed-pin slice (D4).
 *
 * The gateway (mcp-host `packages/core/src/bridge-confirm.ts`) verifies
 * Ed25519 by the BOUND key over one of three NUL-joined messages:
 *
 *   start  "mcp-host/bridge-confirm/v1"        origin tokenId decimal(ts)
 *   finish "mcp-host/bridge-confirm-finish/v1" origin tokenId completion
 *   app    "mcp-host/bridge-confirm-app/v1"    origin tokenId decimal(ts)
 *
 * `verifyGateway` restates that verifier here rather than importing it from
 * the code under test: a dropped, reordered or swapped field stops verifying
 * HERE, as it would at the gateway. The strings below are the vectors of
 * mcp-host's `packages/core/tests/bridge-confirm.test.ts`.
 */

const ORIGIN = 'https://gw.test';
const BRIDGE_URL = 'wss://gw.test/bridge';
const TOKEN = 'mcpb_' + 'T'.repeat(43);
const TOKEN_ID = 'brt_abc';
const SECRET = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 base64url characters: a 128-bit value
const NOW = 1_800_000_000;

async function verifyGateway(ed25519Pub: string, sig: string, parts: string[]): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    fromB64(ed25519Pub) as BufferSource,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const message = new TextEncoder().encode(parts.join('\0'));
  return crypto.subtle.verify('Ed25519', key, fromB64(sig) as BufferSource, message);
}

let identity: ExtensionIdentity;
let pub: string;

type Call = { url: string; init: RequestInit };
let calls: Call[];
let answer: () => Response | Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  freshVault();
  identity = await loadOrCreateExtensionIdentity();
  pub = toB64(identity.ed25519Pub);
  calls = [];
  answer = () => json(500, {});
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return answer();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the gateway constants', () => {
  it('match mcp-host core byte for byte', () => {
    expect(BRIDGE_CONFIRM_START_CONTEXT).toBe('mcp-host/bridge-confirm/v1');
    expect(BRIDGE_CONFIRM_FINISH_CONTEXT).toBe('mcp-host/bridge-confirm-finish/v1');
    expect(BRIDGE_CONFIRM_APP_CONTEXT).toBe('mcp-host/bridge-confirm-app/v1');
    expect(BRIDGE_CONFIRM_MESSAGE_TYPE).toBe('mcp-host/bridge-account-confirm/v1');
    expect(ACCOUNT_CONFIRMED_CLOSE).toBe(4005);
    expect(FACTS_CHANGED_CLOSE).toBe(4006);
  });

  it('spells the three messages as the gateway does (its vectors)', () => {
    const text = (b: Uint8Array) => new TextDecoder().decode(b);
    expect(text(bridgeConfirmStartMessage('https://o', 'brt_1', 1788063212))).toBe(
      'mcp-host/bridge-confirm/v1\0https://o\0brt_1\x001788063212',
    );
    expect(text(bridgeConfirmFinishMessage('https://o', 'brt_1', 'CMPL'))).toBe(
      'mcp-host/bridge-confirm-finish/v1\0https://o\0brt_1\0CMPL',
    );
    expect(text(bridgeConfirmAppMessage('https://o', 'brt_1', 1788063212))).toBe(
      'mcp-host/bridge-confirm-app/v1\0https://o\0brt_1\x001788063212',
    );
  });
});

describe('isConfirmSecret', () => {
  it('is exactly 22 base64url characters, as the gateway mints', () => {
    expect(isConfirmSecret(SECRET)).toBe(true);
    expect(isConfirmSecret('A'.repeat(21))).toBe(false);
    expect(isConfirmSecret('A'.repeat(23))).toBe(false);
    expect(isConfirmSecret(`${'A'.repeat(21)}=`)).toBe(false);
    expect(isConfirmSecret(`${'A'.repeat(21)}/`)).toBe(false);
    expect(isConfirmSecret(42)).toBe(false);
    expect(isConfirmSecret(undefined)).toBe(false);
  });
});

describe('extensionKeyFingerprint', () => {
  it('is the first 8 bytes of sha256(raw x25519 pub), lowercase hex — the gateway fingerprint', async () => {
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', identity.x25519Pub as BufferSource),
    );
    const expected = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(await extensionKeyFingerprint(identity.x25519Pub)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('confirmChallengeUrl', () => {
  it('accepts exactly <origin>/bridge/confirm#<challenge>', () => {
    const url = `${ORIGIN}/bridge/confirm#${SECRET}`;
    expect(confirmChallengeUrl(ORIGIN, url)).toBe(url);
  });

  it('refuses any other origin, path, query, or fragment shape', () => {
    expect(confirmChallengeUrl(ORIGIN, `https://evil.test/bridge/confirm#${SECRET}`)).toBeNull();
    expect(confirmChallengeUrl(ORIGIN, `http://gw.test/bridge/confirm#${SECRET}`)).toBeNull();
    expect(confirmChallengeUrl(ORIGIN, `https://gw.test:444/bridge/confirm#${SECRET}`)).toBeNull();
    expect(confirmChallengeUrl(ORIGIN, `${ORIGIN}/bridge/confirmX#${SECRET}`)).toBeNull();
    expect(confirmChallengeUrl(ORIGIN, `${ORIGIN}/login#${SECRET}`)).toBeNull();
    expect(confirmChallengeUrl(ORIGIN, `${ORIGIN}/bridge/confirm?next=x#${SECRET}`)).toBeNull();
    expect(confirmChallengeUrl(ORIGIN, `${ORIGIN}/bridge/confirm#short`)).toBeNull();
    expect(confirmChallengeUrl(ORIGIN, `${ORIGIN}/bridge/confirm`)).toBeNull();
    expect(confirmChallengeUrl(ORIGIN, `https://user@gw.test/bridge/confirm#${SECRET}`)).toBeNull();
    expect(confirmChallengeUrl(ORIGIN, 'javascript:alert(1)')).toBeNull();
    expect(confirmChallengeUrl(ORIGIN, 42)).toBeNull();
  });
});

describe('startAccountConfirm', () => {
  it('POSTs {ts, sig} with the bearer to the link’s own gateway, signed by the bound key', async () => {
    answer = () =>
      json(200, { challengeUrl: `${ORIGIN}/bridge/confirm#${SECRET}`, expiresAt: 'x' });
    const result = await startAccountConfirm(identity, BRIDGE_URL, TOKEN_ID, TOKEN, NOW);
    expect(result).toEqual({ ok: true, challengeUrl: `${ORIGIN}/bridge/confirm#${SECRET}` });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(`${ORIGIN}/bridge/account-confirm/start`);
    expect(call!.init.method).toBe('POST');
    expect(call!.init.redirect).toBe('error');
    expect(call!.init.credentials).toBe('omit');
    expect(new Headers(call!.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(call!.init.body));
    expect(Object.keys(body).sort()).toEqual(['sig', 'ts']);
    expect(body.ts).toBe(NOW);
    expect(
      await verifyGateway(pub, body.sig, [
        BRIDGE_CONFIRM_START_CONTEXT,
        ORIGIN,
        TOKEN_ID,
        String(NOW),
      ]),
    ).toBe(true);
    // Not a finish or app signature over the same fields.
    expect(
      await verifyGateway(pub, body.sig, [
        BRIDGE_CONFIRM_APP_CONTEXT,
        ORIGIN,
        TOKEN_ID,
        String(NOW),
      ]),
    ).toBe(false);
  });

  it('refuses a challenge URL the gateway pointed anywhere else — nothing to open', async () => {
    answer = () => json(200, { challengeUrl: `https://evil.test/bridge/confirm#${SECRET}` });
    const result = await startAccountConfirm(identity, BRIDGE_URL, TOKEN_ID, TOKEN, NOW);
    expect(result.ok).toBe(false);
  });

  it('reports the gateway’s refusal sentence, and a network failure, as outcomes', async () => {
    answer = () => json(403, { error: 'this browser could not be confirmed for the account' });
    expect(await startAccountConfirm(identity, BRIDGE_URL, TOKEN_ID, TOKEN, NOW)).toEqual({
      ok: false,
      reason: 'this browser could not be confirmed for the account',
    });
    answer = () => {
      throw new TypeError('offline');
    };
    const offline = await startAccountConfirm(identity, BRIDGE_URL, TOKEN_ID, TOKEN, NOW);
    expect(offline.ok).toBe(false);
  });

  it('sends nothing for a URL that is not a bridge, or an id that is not a credential id', async () => {
    expect((await startAccountConfirm(identity, 'https://gw.test/', TOKEN_ID, TOKEN, NOW)).ok).toBe(
      false,
    );
    expect((await startAccountConfirm(identity, BRIDGE_URL, 'nope', TOKEN, NOW)).ok).toBe(false);
    expect((await startAccountConfirm(identity, BRIDGE_URL, TOKEN_ID, 'has space', NOW)).ok).toBe(
      false,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('finishAccountConfirm', () => {
  it('POSTs {completion, sig} with the bearer, signed by the bound key over the completion', async () => {
    answer = () => json(200, { id: TOKEN_ID, accountConfirmed: true });
    expect(await finishAccountConfirm(identity, BRIDGE_URL, TOKEN_ID, TOKEN, SECRET)).toEqual({
      ok: true,
    });
    const [call] = calls;
    expect(call!.url).toBe(`${ORIGIN}/bridge/account-confirm/finish`);
    expect(call!.init.redirect).toBe('error');
    expect(new Headers(call!.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(call!.init.body));
    expect(Object.keys(body).sort()).toEqual(['completion', 'sig']);
    expect(body.completion).toBe(SECRET);
    expect(
      await verifyGateway(pub, body.sig, [BRIDGE_CONFIRM_FINISH_CONTEXT, ORIGIN, TOKEN_ID, SECRET]),
    ).toBe(true);
  });

  it('is not confirmed unless the gateway says so', async () => {
    answer = () => json(200, { id: TOKEN_ID });
    expect((await finishAccountConfirm(identity, BRIDGE_URL, TOKEN_ID, TOKEN, SECRET)).ok).toBe(
      false,
    );
    answer = () => json(403, { error: 'no' });
    expect(await finishAccountConfirm(identity, BRIDGE_URL, TOKEN_ID, TOKEN, SECRET)).toEqual({
      ok: false,
      reason: 'no',
    });
  });

  it('never sends a completion that is not one the gateway could have minted', async () => {
    expect((await finishAccountConfirm(identity, BRIDGE_URL, TOKEN_ID, TOKEN, 'x')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('appConfirmRequest (ContextMint hand-off contract v1.1)', () => {
  it('is {type, tokenId, extFingerprint, ts, sig} — signed by the bound key, and no challenge', async () => {
    const request = await appConfirmRequest(identity, ORIGIN, TOKEN_ID, NOW);
    expect(Object.keys(request).sort()).toEqual(['extFingerprint', 'sig', 'tokenId', 'ts', 'type']);
    expect(request.type).toBe('account-confirm');
    expect(request.tokenId).toBe(TOKEN_ID);
    expect(request.ts).toBe(NOW);
    expect(request.extFingerprint).toBe(await extensionKeyFingerprint(identity.x25519Pub));
    expect(
      await verifyGateway(pub, request.sig, [
        BRIDGE_CONFIRM_APP_CONTEXT,
        ORIGIN,
        TOKEN_ID,
        String(NOW),
      ]),
    ).toBe(true);
    expect(
      await verifyGateway(pub, request.sig, [
        BRIDGE_CONFIRM_START_CONTEXT,
        ORIGIN,
        TOKEN_ID,
        String(NOW),
      ]),
    ).toBe(false);
  });
});
