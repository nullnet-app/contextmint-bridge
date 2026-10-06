import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519Verify, fromB64, toB64 } from '@fetchproxy/protocol';

import { bridgeConnectFinishMessage, finishBridgeConnect } from '../src/bridge-connect.js';
import { currentFormFactor } from '../src/platform.js';
import { loadOrCreateExtensionIdentity, type ExtensionIdentity } from '../src/extension-identity.js';
import { freshVault, installChromeLocal } from './helpers/vault.js';

/**
 * mcp-host plan task X4 (spec 2026-10-05 §5.9 "Form factor", decision M10):
 * Connect tells the gateway whether this browser is desktop or mobile, so the
 * account's room can prefer a desktop browser to serve. The value is a hint
 * OUTSIDE the `mcp-host/bridge-connect-finish/v1` signed bytes (gateway task
 * G7), so the 2026-09-27 plan's X1 vectors are unchanged.
 */

const ORIGIN = 'https://mcp.nullnet.app';
const REQUEST = 'bcr_00112233445566778899aabbccddeeff';
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';
const APPROVAL = 'BBBBBBBBBBBBBBBBBBBBBB';
const REFUSAL = 'this browser could not be connected; click Connect in the extension again';

const credential = {
  token: 'mcpb_' + 'C'.repeat(43),
  tokenId: 'brt_new',
  name: 'Safari on iPhone',
  bridgeUrl: 'wss://mcp.nullnet.app/bridge',
  account: { slug: 'acme', displayName: 'Acme' },
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Sent = { url: string; body: Record<string, unknown> };
let sent: Sent[];
let answers: Array<() => Response>;
let identity: ExtensionIdentity;

beforeEach(async () => {
  freshVault();
  installChromeLocal();
  identity = await loadOrCreateExtensionIdentity();
  sent = [];
  answers = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = answers.shift();
    return next ? next() : json(500, { error: 'no answer scripted' });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  (globalThis as { __FETCHPROXY_PLATFORM__?: string }).__FETCHPROXY_PLATFORM__ = 'chrome';
});

describe('finish says desktop or mobile, outside the signed bytes', () => {
  for (const platform of ['desktop', 'mobile'] as const) {
    it(`sends platform: '${platform}' and a signature over the unchanged X1 bytes`, async () => {
      answers.push(() => json(200, credential));
      const result = await finishBridgeConnect(identity, ORIGIN, REQUEST, NONCE, APPROVAL, platform);
      expect(result).toEqual({ ok: true, credential });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toBe(`${ORIGIN}/bridge/connect/finish`);
      const { sig, ...rest } = sent[0]!.body;
      expect(rest).toEqual({ requestId: REQUEST, nonce: NONCE, approval: APPROVAL, platform });
      // The signed message is exactly the X1 vector: the platform is not in it.
      const signed = bridgeConnectFinishMessage(
        ORIGIN, REQUEST, NONCE, APPROVAL, toB64(identity.x25519Pub), toB64(identity.ed25519Pub),
      );
      expect(new TextDecoder().decode(signed)).not.toContain(platform);
      expect(await ed25519Verify(identity.ed25519Pub, signed, fromB64(sig as string))).toBe(true);
    });
  }

  it('sends no platform member when none is given', async () => {
    answers.push(() => json(200, credential));
    await finishBridgeConnect(identity, ORIGIN, REQUEST, NONCE, APPROVAL);
    expect(sent[0]!.body).not.toHaveProperty('platform');
  });

  // A gateway before G7 holds the finish body to a strict schema that does not
  // know `platform`, and answers it 403 (the one refusal it gives for every
  // failure). Connect must still work there: retry once without the hint.
  it('retries once without platform when a gateway before G7 refuses it', async () => {
    answers.push(() => json(403, { error: REFUSAL }), () => json(200, credential));
    const result = await finishBridgeConnect(identity, ORIGIN, REQUEST, NONCE, APPROVAL, 'mobile');
    expect(result).toEqual({ ok: true, credential });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body.platform).toBe('mobile');
    expect(sent[1]!.body).not.toHaveProperty('platform');
    // The same signed request both times: the hint never touched the bytes.
    expect(sent[1]!.body.sig).toBe(sent[0]!.body.sig);
  });

  it('reports the refusal when the retry is refused too, after exactly two posts', async () => {
    answers.push(() => json(403, { error: REFUSAL }), () => json(403, { error: REFUSAL }));
    const result = await finishBridgeConnect(identity, ORIGIN, REQUEST, NONCE, APPROVAL, 'desktop');
    expect(result).toEqual({ ok: false, reason: REFUSAL });
    expect(sent).toHaveLength(2);
  });

  it('does not retry any answer but 403, nor a 403 to a finish that sent no platform', async () => {
    for (const status of [400, 429, 500]) {
      sent = [];
      answers = [() => json(status, { error: 'no' })];
      const result = await finishBridgeConnect(identity, ORIGIN, REQUEST, NONCE, APPROVAL, 'mobile');
      expect(result).toEqual({ ok: false, reason: 'no' });
      expect(sent).toHaveLength(1);
    }
    sent = [];
    answers = [() => json(403, { error: REFUSAL })];
    await finishBridgeConnect(identity, ORIGIN, REQUEST, NONCE, APPROVAL);
    expect(sent).toHaveLength(1);
  });
});

describe('currentFormFactor: what Connect declares', () => {
  const withPlatformInfo = (getPlatformInfo: unknown) => {
    (globalThis as { chrome?: Record<string, unknown> }).chrome = {
      ...((globalThis as { chrome?: Record<string, unknown> }).chrome ?? {}),
      runtime: { getManifest: () => ({ version: '1.0.0' }), getPlatformInfo },
    };
  };

  it('iOS Safari (iPhone and iPad) declares mobile', async () => {
    (globalThis as { __FETCHPROXY_PLATFORM__?: string }).__FETCHPROXY_PLATFORM__ = 'safari';
    for (const os of ['ios', 'ipados']) {
      withPlatformInfo(async () => ({ os, arch: 'arm' }));
      expect(await currentFormFactor()).toBe('mobile');
    }
  });

  it('macOS Safari declares desktop', async () => {
    (globalThis as { __FETCHPROXY_PLATFORM__?: string }).__FETCHPROXY_PLATFORM__ = 'safari';
    withPlatformInfo(async () => ({ os: 'mac', arch: 'arm' }));
    expect(await currentFormFactor()).toBe('desktop');
  });

  it('Chrome declares desktop on every desktop OS, and mobile on Android', async () => {
    for (const os of ['mac', 'win', 'linux', 'cros', 'openbsd', 'fuchsia']) {
      withPlatformInfo(async () => ({ os, arch: 'x86-64' }));
      expect(await currentFormFactor()).toBe('desktop');
    }
    withPlatformInfo(async () => ({ os: 'android', arch: 'arm' }));
    expect(await currentFormFactor()).toBe('mobile');
  });

  it('says desktop when the browser cannot say (no API, a throw, or no answer)', async () => {
    for (const info of [undefined, () => { throw new Error('nope'); }, async () => { throw new Error('nope'); }, async () => undefined]) {
      withPlatformInfo(info);
      expect(await currentFormFactor()).toBe('desktop');
    }
  });
});
