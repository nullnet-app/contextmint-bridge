import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';
import { tempSafariBuild } from './helpers/temp-build.js';

/**
 * What the ContextMint Bridge container app's appex build takes from this
 * package, restated — the ONE place this repo pins it. The appex's pre-build
 * phase (`apple/tools/stage-extension.sh`, docs/superpowers/plans/
 * 2026-10-05-safari-extension-standalone.md T1) copies this package's release
 * build into the appex's resources and refuses to build unless:
 *
 * - `manifest.json` is at the ROOT of the build (Safari reads it from the
 *   appex's resources root; a nested one is no extension at all);
 * - the manifest's `version` is the release version — the one release-please
 *   writes into every workspace and Chrome's manifest, and into the container's
 *   `MARKETING_VERSION`; App Store validation needs the three equal;
 * - no top-level file can collide with the appex executable, which is named
 *   after its target and has no file extension;
 *
 * and Safari itself needs:
 *
 * - the background as a non-persistent event page: exactly
 *   `{"scripts": [...], "persistent": false}` — no `service_worker`, no
 *   `"type": "module"` (Safari 27 never ran either);
 * - neither `downloads` nor `tabGroups` (no such APIs), and no
 *   `nativeMessaging`: the extension never talks to the app that contains it;
 * - only PNG icons, as size-keyed maps, that are there — in `icons` and
 *   `action.default_icon`. Safari 27 silently drops the WHOLE extension (gone
 *   from Settings → Extensions, no log line) for an SVG toolbar icon, as a
 *   string or a size-keyed map (proven live 2026-09-27; #28);
 * - `browser_specific_settings.safari.strict_min_version` 27.0 — the Safari
 *   every rule above was proven on (proven live 2026-09-27);
 * - a `description` string of at most 112 characters — App Store Connect
 *   rejects the whole app upload otherwise (error 90849, ContextMint Mac build
 *   201, run 36323416643); Chrome's 132-character limit is looser.
 *
 * `manifest-parity.test.ts` pins how the generator gets there; this file pins
 * what the container's build and Safari refuse.
 */

const rootPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
) as { version: string };

let built: Awaited<ReturnType<typeof tempSafariBuild>>;
beforeAll(async () => {
  built = await tempSafariBuild();
});
afterAll(async () => {
  await built?.cleanup();
});

describe('the built Safari extension is what the container app’s appex can stage', () => {
  it('has manifest.json at the root of the build', () => {
    expect(existsSync(join(built.outdir, 'manifest.json'))).toBe(true);
  });

  it('carries the release version (the root package.json, which release-please bumps)', () => {
    expect(built.manifest.version).toBe(rootPackage.version);
    expect(built.manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('has no extension-less top-level file that could collide with the appex executable', async () => {
    const entries = await readdir(built.outdir, { withFileTypes: true });
    const bare = entries.filter((e) => e.isFile() && extname(e.name) === '').map((e) => e.name);
    expect(bare).toEqual([]);
  });

  it('runs the background as a non-persistent event page — no service_worker, no module type', () => {
    expect(built.manifest.background).toStrictEqual({
      scripts: ['background.js'],
      persistent: false,
    });
    expect(existsSync(join(built.outdir, 'background.js'))).toBe(true);
  });

  it('does not ask for nativeMessaging — nothing talks to the containing app', () => {
    expect(built.manifest.permissions).not.toContain('nativeMessaging');
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
