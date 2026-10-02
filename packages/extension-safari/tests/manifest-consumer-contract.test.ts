import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempSafariBuild } from './helpers/temp-build.js';

/**
 * The consumer's gate, restated — the ONE place this repo pins it.
 * nullnet-app/mcp-host-app unzips this package's release zip
 * (`contextmint-bridge-safari-${VERSION}.zip`) into its Safari appex's
 * `Resources/`, and its `tools/fetch_bridge_resources.py` (`validate_manifest`,
 * run by the appex's pre-build phase `tools/fetch_bridge_resources.sh`) fails
 * the app build unless the manifest:
 *
 * - runs the background as a non-persistent event page: exactly
 *   `{"scripts": [...], "persistent": false}` — no `service_worker`, no
 *   `"type": "module"`;
 * - has `nativeMessaging` in `permissions`, and neither `downloads` nor
 *   `tabGroups`;
 * - names only PNG icons, as size-keyed maps, that are there — in `icons` and
 *   `action.default_icon`. Safari 27 silently drops the WHOLE extension (gone
 *   from Settings → Extensions, no log line) for an SVG toolbar icon, as a
 *   string or a size-keyed map (proven live 2026-09-27; #28);
 * - requires `browser_specific_settings.safari.strict_min_version` 27.0 — the
 *   Safari every rule above was proven on (proven live 2026-09-27).
 * - has a `description` string of at most 112 characters — App Store Connect
 *   rejects the whole app upload otherwise (error 90849, ContextMint Mac build
 *   201, run 36323416643); Chrome's 132-character limit is looser.
 *
 * If that repo's check changes, this one must change with it.
 * `manifest-parity.test.ts` pins how the generator gets there; this file pins
 * what the consumer refuses.
 */

let built: Awaited<ReturnType<typeof tempSafariBuild>>;
beforeAll(async () => {
  built = await tempSafariBuild();
});
afterAll(async () => {
  await built?.cleanup();
});

describe('the built Safari manifest passes mcp-host-app’s appex build check', () => {
  it('runs the background as a non-persistent event page — no service_worker, no module type', () => {
    expect(built.manifest.background).toStrictEqual({
      scripts: ['background.js'],
      persistent: false,
    });
  });

  it('asks for nativeMessaging', () => {
    expect(built.manifest.permissions).toContain('nativeMessaging');
  });

  // Passed through from Chrome's manifest like every permission whose API
  // Safari has: harmless where WebKit does not honour it for IndexedDB, and
  // the vault's eviction tripwire (fleet-audit #1002) covers that case.
  it('asks for unlimitedStorage, passed through from Chrome', () => {
    expect(built.manifest.permissions).toContain('unlimitedStorage');
  });

  it.each(['downloads', 'tabGroups'])('does not ask for %s', (absent) => {
    expect(built.manifest.permissions).not.toContain(absent);
  });

  it.each(['icons', 'action.default_icon'] as const)(
    '%s is a size-keyed map of PNGs that the build contains — Safari 27 drops the extension for an SVG',
    (where) => {
      const icon: unknown =
        where === 'icons' ? built.manifest.icons : built.manifest.action?.default_icon;
      // A bare string (even a .png) is not the contract: only a size-keyed map.
      expect(icon).toBeTypeOf('object');
      expect(icon).not.toBeNull();
      const entries = Object.entries(icon as Record<string, unknown>);
      expect(entries.length).toBeGreaterThan(0);
      for (const [size, path] of entries) {
        expect(size).toMatch(/^\d+$/);
        expect(path).toBeTypeOf('string');
        expect(path as string).toMatch(/\.png$/);
        expect(existsSync(join(built.outdir, path as string)), `${where}.${size}: ${path}`).toBe(
          true,
        );
      }
    },
  );

  it('has a description of at most 112 characters — App Store Connect error 90849 otherwise', () => {
    expect(built.manifest.description).toBeTypeOf('string');
    expect([...(built.manifest.description as string)].length).toBeLessThanOrEqual(112);
  });

  it('requires Safari 27.0 — browser_specific_settings.safari.strict_min_version', () => {
    expect(built.manifest.browser_specific_settings.safari.strict_min_version).toBe('27.0');
  });
});
