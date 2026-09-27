import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { deflateSync } from 'node:zlib';
import { SCENES, SCREENSHOTS } from '../store-assets/scenes.js';
import { chromeStubSource } from '../store-assets/chrome-stub.js';
import { BRAND, promoTileHtml, screenshotHtml } from '../store-assets/canvas.js';
import { pngInfo, stripAlpha } from '../store-assets/png.js';
import { normalisePendingPair } from '../../extension-core/src/lib/pending-pair.js';
import { normaliseRemoteTargets } from '../../extension-core/src/remote-targets.js';
import { unavailableCapabilities } from '../../extension-core/src/capabilities.js';
import { CAPABILITY_DISPLAY } from '../../extension-core/src/popup/popup.js';

/**
 * The Chrome Web Store listing assets (docs/store-assets/) are rendered from
 * the real popup by `npm run store-assets -w @fetchproxy/extension-chrome`.
 * These tests hold the pure halves of that generator — the fixtures, the
 * chrome.* stub, the branded canvases, the PNG fix-up — and the committed
 * outputs to the store's size and format rules.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ASSETS = join(ROOT, 'docs/store-assets');
const manifest = JSON.parse(
  readFileSync(join(ROOT, 'packages/extension-chrome/manifest.json'), 'utf8'),
) as { version: string };

/** Every probe present: what Chrome serves. */
const CHROME_PROBE = {
  downloads: { download: () => {}, onChanged: {} },
  webRequest: {
    onBeforeSendHeaders: { addListener: () => {} },
    onBeforeRedirect: { addListener: () => {} },
  },
  scripting: {
    getRegisteredContentScripts: () => {},
    registerContentScripts: () => {},
    updateContentScripts: () => {},
    unregisterContentScripts: () => {},
    executeScript: () => {},
  },
  cookies: { set: () => {} },
};

describe('scenes', () => {
  it('has a trusted-MCP status scene and a pairing scene', () => {
    const names = SCREENSHOTS.map((s) => s.scene);
    expect(names).toContain('status');
    expect(names).toContain('pair');
    expect(SCREENSHOTS.length).toBeGreaterThanOrEqual(2);
    for (const s of SCREENSHOTS) expect(SCENES[s.scene]).toBeDefined();
  });

  it('the pairing scene is a queue the popup accepts, with a pair code and capabilities', () => {
    const queue = normalisePendingPair<{
      key: string;
      mcpIds: string[];
      kind: string;
      pairCode?: string;
      capabilities: string[];
    }>(SCENES.pair.pendingPair);
    const entries = Object.values(queue);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('pair');
    expect(entries[0]!.pairCode).toMatch(/^\d{4}-\d{4}$/);
    expect(entries[0]!.capabilities.length).toBeGreaterThan(1);
  });

  it('the status scene trusts at least one connected MCP', () => {
    const s = SCENES.status;
    expect(s.pendingPair).toBeUndefined();
    expect(s.trusted.length).toBeGreaterThan(0);
    expect(s.trusted.some((t) => s.connectedHashes.includes(t.identityHash))).toBe(true);
  });

  it('every remote bridge in a scene survives the real normaliser', () => {
    for (const scene of Object.values(SCENES)) {
      expect(normaliseRemoteTargets(scene.remoteTargets)).toHaveLength(scene.remoteTargets.length);
    }
  });

  it('shows only capabilities Chrome serves, each with its real popup label', () => {
    const chromeMissing = unavailableCapabilities(CHROME_PROBE);
    for (const scene of Object.values(SCENES)) {
      const caps = [
        ...scene.trusted.flatMap((t) => t.input.capabilities),
        ...Object.values(
          (scene.pendingPair ?? {}) as Record<
            string,
            {
              capabilities: string[];
              previousScope?: { capabilities: string[] };
              unavailableCapabilities?: string[];
            }
          >,
        ).flatMap((p) => [...p.capabilities, ...(p.previousScope?.capabilities ?? [])]),
      ];
      for (const c of caps) {
        expect(CAPABILITY_DISPLAY[c], c).toBeDefined();
        expect(chromeMissing.has(c as never), c).toBe(false);
      }
      for (const p of Object.values(
        (scene.pendingPair ?? {}) as Record<string, { unavailableCapabilities?: string[] }>,
      )) {
        expect(p.unavailableCapabilities ?? []).toEqual([]);
      }
    }
  });
});

describe('chromeStubSource', () => {
  interface StubbedChrome {
    runtime: {
      getManifest: () => { version: string };
      sendMessage: (m: unknown) => Promise<unknown>;
      onMessage: { addListener: (cb: unknown) => void };
    };
    storage: {
      local: {
        get: (k: string | string[]) => Promise<Record<string, unknown>>;
        remove: (k: string) => Promise<void>;
      };
      session: {
        get: (k: string | string[]) => Promise<Record<string, unknown>>;
        set: (kv: Record<string, unknown>) => Promise<void>;
        remove: (k: string) => Promise<void>;
      };
    };
  }
  const load = (scene: keyof typeof SCENES): StubbedChrome => {
    const sandbox: { chrome?: StubbedChrome } = {};
    runInNewContext(chromeStubSource(SCENES[scene], manifest.version), sandbox);
    return sandbox.chrome!;
  };

  it('answers the pairing queue from storage.session', async () => {
    const chrome = load('pair');
    const got = await chrome.storage.session.get(['pendingPair']);
    expect(JSON.parse(JSON.stringify(got.pendingPair))).toEqual(SCENES.pair.pendingPair);
  });

  it('has an empty queue in the status scene, and nothing in storage.local', async () => {
    const chrome = load('status');
    expect((await chrome.storage.session.get(['pendingPair'])).pendingPair).toBeUndefined();
    expect(await chrome.storage.local.get('versionMismatch')).toEqual({});
  });

  it('answers the connection query the way the background does', async () => {
    const chrome = load('status');
    const resp = (await chrome.runtime.sendMessage({ type: 'get-connected-identities' })) as {
      connectedHashes: string[];
      links: unknown[];
    };
    expect(resp.connectedHashes).toEqual(SCENES.status.connectedHashes);
    expect(resp.links).toEqual(SCENES.status.links);
  });

  it('reports the manifest version, so the trust store keeps the seeded records', () => {
    expect(load('status').runtime.getManifest().version).toBe(manifest.version);
  });

  it('stores what the page writes to storage.session', async () => {
    const chrome = load('status');
    await chrome.storage.session.set({ x: 1 });
    expect(await chrome.storage.session.get('x')).toEqual({ x: 1 });
    await chrome.storage.session.remove('x');
    expect(await chrome.storage.session.get('x')).toEqual({});
  });
});

describe('canvases', () => {
  it('uses the ContextMint palette', () => {
    expect(BRAND).toMatchObject({ ink: '#0b0b0f', paper: '#fafafa', star: '#f5c518' });
  });

  it('a screenshot canvas is 1280x800, carries the popup image and escapes its text', () => {
    const html = screenshotHtml({
      headline: 'Pair <once>',
      sub: 'a & b',
      popupPng: 'data:image/png;base64,AAAA',
      popupWidth: 404,
      popupHeight: 500,
    });
    expect(html).toContain('width: 1280px');
    expect(html).toContain('height: 800px');
    expect(html).toContain('data:image/png;base64,AAAA');
    expect(html).toContain('Pair &lt;once&gt;');
    expect(html).toContain('a &amp; b');
    for (const hex of [BRAND.ink, BRAND.paper, BRAND.star]) expect(html).toContain(hex);
  });

  it('scales a tall popup down so it fits the canvas', () => {
    const html = screenshotHtml({
      headline: 'h',
      sub: 's',
      popupPng: 'data:image/png;base64,AAAA',
      popupWidth: 404,
      popupHeight: 1600,
    });
    const m = /--popup-scale: ([\d.]+)/.exec(html);
    expect(m).not.toBeNull();
    expect(1600 * Number(m![1])).toBeLessThanOrEqual(800);
  });

  it('the promo tile is 440x280 and names the extension', () => {
    const html = promoTileHtml();
    expect(html).toContain('width: 440px');
    expect(html).toContain('height: 280px');
    expect(html).toContain('ContextMint Bridge');
  });
});

/** A minimal PNG: 2x1, colour type 6 (RGBA), filter 0 rows. */
function rgbaPng(alpha = 255): Buffer {
  const crc = (buf: Buffer): number => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.from([0, 10, 20, 30, 255, 40, 50, 60, alpha]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('png', () => {
  it('reads size and colour type', () => {
    expect(pngInfo(rgbaPng())).toEqual({ width: 2, height: 1, colorType: 6, bitDepth: 8 });
  });

  it('stripAlpha turns an opaque RGBA PNG into 24-bit RGB with the same pixels', () => {
    const out = stripAlpha(rgbaPng());
    expect(pngInfo(out)).toEqual({ width: 2, height: 1, colorType: 2, bitDepth: 8 });
  });

  it('stripAlpha refuses a PNG that is not fully opaque', () => {
    expect(() => stripAlpha(rgbaPng(128))).toThrow(/opaque/);
  });

  it('stripAlpha passes a 24-bit PNG through unchanged', () => {
    const rgb = stripAlpha(rgbaPng());
    expect(stripAlpha(rgb).equals(rgb)).toBe(true);
  });
});

describe('committed store assets', () => {
  const read = (p: string): Buffer => readFileSync(join(ASSETS, p));

  it('the small promo tile is a 440x280 24-bit PNG', () => {
    expect(pngInfo(read('promo-small-440x280.png'))).toEqual({
      width: 440,
      height: 280,
      colorType: 2,
      bitDepth: 8,
    });
  });

  it.each(SCREENSHOTS.map((s) => s.file))('%s is a 1280x800 24-bit PNG', (file) => {
    expect(pngInfo(read(file))).toEqual({ width: 1280, height: 800, colorType: 2, bitDepth: 8 });
  });

  it('holds no stray screenshots the generator no longer makes', () => {
    const dir = join(ASSETS, 'screenshots');
    const onDisk = existsSync(dir) ? readdirSync(dir).map((f) => `screenshots/${f}`) : [];
    expect(onDisk.sort()).toEqual(SCREENSHOTS.map((s) => s.file).sort());
  });

  it('the store-assets README says how to regenerate them', () => {
    const md = readFileSync(join(ASSETS, 'README.md'), 'utf8');
    expect(md).toContain('npm run store-assets --workspace=@fetchproxy/extension-chrome');
  });
});
