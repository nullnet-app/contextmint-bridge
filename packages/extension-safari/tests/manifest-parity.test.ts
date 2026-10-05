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

  it('permissions are exactly Chrome’s minus {downloads, tabGroups} — nothing added', () => {
    const expected = (chrome.permissions ?? []).filter((p) => !DROPPED.includes(p));
    expect(safari().permissions).toEqual(expected);
  });

  it('differs from Chrome’s key set only by minimum_chrome_version out and browser_specific_settings in', () => {
    const chromeKeys = Object.keys(chrome).filter((k) => k !== 'minimum_chrome_version');
    expect(Object.keys(safari()).sort()).toEqual(
      [...chromeKeys, 'browser_specific_settings'].sort(),
    );
  });

  it('has a description App Store Connect accepts: a string of at most 112 characters', () => {
    // App Store Connect error 90849 rejected ContextMint Mac build 201
    // (nullnet-app/mcp-host-app run 36323416643) for a 131-character
    // description: the appex manifest's must be a string of <= 112 characters.
    // Chrome's limit is 132, so the Chrome-side check alone never caught it.
    const description = safari().description;
    expect(description).toBeTypeOf('string');
    expect([...(description as string)].length).toBeLessThanOrEqual(112);
  });

  it('requires Safari 27.0, the version the build was proven on', () => {
    expect(safari().browser_specific_settings).toEqual({ safari: { strict_min_version: '27.0' } });
  });

  it('replaces the service worker with the event-page background shape', () => {
    expect(chrome.background).toHaveProperty('service_worker');
    expect(safari().background).toEqual({ scripts: ['background.js'], persistent: false });
  });

  // The PNG-only icon rule (Safari 27 drops the extension for an SVG toolbar
  // icon) is pinned on the built output, so it lives with the rest of the
  // container's gate in appex-staging-contract.test.ts; `icons` and `action`
  // passing through from Chrome's manifest unchanged is pinned above.
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

  it('adds no permission to a manifest that has none', () => {
    const { permissions: _permissions, ...bare } = chrome;
    expect(safariManifest(bare)).not.toHaveProperty('permissions');
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
