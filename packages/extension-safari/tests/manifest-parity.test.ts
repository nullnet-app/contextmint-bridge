import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { safariManifest, type ChromeManifest, type SafariManifest } from '../manifest.js';
import { tempSafariBuild } from './helpers/temp-build.js';

/**
 * The Safari manifest is GENERATED from Chrome's (the file release-please
 * bumps), so name, version, icons, popup, content scripts and host permissions
 * cannot drift between the two browsers. These tests pin that the generator
 * changes exactly what the macOS Safari 27 spike required and nothing else —
 * against the real Chrome manifest, and against the manifest a real build
 * writes (a temp build, never `dist/`).
 */

const chrome = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../extension-chrome/manifest.json', import.meta.url)),
    'utf8',
  ),
) as ChromeManifest;

/** Absent in Safari 27 (spike): `chrome.downloads` and `chrome.tabGroups` do not exist. */
const DROPPED = ['downloads', 'tabGroups'];
/**
 * The ONE deliberate Safari-only addition: `browser.runtime.sendNativeMessage`
 * exists only with it, and nullnet-app/mcp-host-app's appex build refuses a
 * manifest without it (the extension asks the containing ContextMint app for
 * its bridge target).
 */
const ADDED = ['nativeMessaging'];

const PASSED_THROUGH = [
  'manifest_version',
  'name',
  'short_name',
  'version',
  'description',
  'icons',
  'action',
  'host_permissions',
] as const;

let built: Awaited<ReturnType<typeof tempSafariBuild>>;
beforeAll(async () => {
  built = await tempSafariBuild();
});
afterAll(async () => {
  await built?.cleanup();
});

const cases: [string, () => SafariManifest][] = [
  ['safariManifest(chrome manifest)', () => safariManifest(chrome)],
  ['the built manifest.json', () => built.manifest],
];

describe.each(cases)('%s keeps parity with Chrome', (_label, safari) => {
  it.each(PASSED_THROUGH)('%s equals Chrome’s', (key) => {
    expect(safari()[key]).toEqual(chrome[key]);
  });

  it('content_scripts equal Chrome’s minus the manifest `world` key', () => {
    const expected = (chrome.content_scripts ?? []).map(({ world: _world, ...rest }) => rest);
    expect(safari().content_scripts).toEqual(expected);
    for (const cs of safari().content_scripts ?? []) expect(cs).not.toHaveProperty('world');
  });

  it('permissions are Chrome’s minus exactly {downloads, tabGroups} plus exactly {nativeMessaging}', () => {
    const expected = [...(chrome.permissions ?? []).filter((p) => !DROPPED.includes(p)), ...ADDED];
    expect([...(safari().permissions ?? [])].sort()).toEqual([...expected].sort());
  });

  it('differs from Chrome’s key set only by minimum_chrome_version out and browser_specific_settings in', () => {
    const chromeKeys = Object.keys(chrome).filter((k) => k !== 'minimum_chrome_version');
    expect(Object.keys(safari()).sort()).toEqual(
      [...chromeKeys, 'browser_specific_settings'].sort(),
    );
  });

  it('requires Safari 27.0, the version the build was proven on', () => {
    expect(safari().browser_specific_settings).toEqual({ safari: { strict_min_version: '27.0' } });
  });

  it('replaces the service worker with the event-page background shape', () => {
    expect(chrome.background).toHaveProperty('service_worker');
    expect(safari().background).toEqual({ scripts: ['background.js'], persistent: false });
  });
});

describe('safariManifest', () => {
  it('does not mutate the Chrome manifest it is given', () => {
    const input = structuredClone(chrome);
    safariManifest(input);
    expect(input).toEqual(chrome);
  });

  it('copies a key it does not know about through untouched', () => {
    const safari = safariManifest({ ...chrome, homepage_url: 'https://example.com' });
    expect(safari['homepage_url']).toBe('https://example.com');
  });

  it('does not list nativeMessaging twice if Chrome ever asks for it', () => {
    const safari = safariManifest({
      ...chrome,
      permissions: [...(chrome.permissions ?? []), 'nativeMessaging'],
    });
    expect(safari.permissions?.filter((p) => p === 'nativeMessaging')).toHaveLength(1);
  });

  it('keeps another browser’s browser_specific_settings and sets only the Safari floor', () => {
    const safari = safariManifest({
      ...chrome,
      browser_specific_settings: {
        gecko: { id: 'x@example.com' },
        safari: { strict_min_version: '15.4', strict_max_version: '99' },
      },
    });
    expect(safari.browser_specific_settings).toEqual({
      gecko: { id: 'x@example.com' },
      safari: { strict_min_version: '27.0' },
    });
  });

  it('refuses a manifest-declared MAIN-world content script instead of demoting it to ISOLATED', () => {
    // Safari does not support the manifest `world` key; dropping `world: 'MAIN'`
    // would silently run the script in the isolated world. MAIN-world code is
    // registered at runtime (extension-core `main-world-bridge.ts`), which Safari runs.
    const withMain: ChromeManifest = {
      ...chrome,
      content_scripts: [{ matches: ['<all_urls>'], js: ['x.js'], world: 'MAIN' }],
    };
    expect(() => safariManifest(withMain)).toThrow(/MAIN/);
  });
});
