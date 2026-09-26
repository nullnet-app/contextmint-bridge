import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tempSafariBuild } from './helpers/temp-build.js';

/**
 * The consumer's gate, restated. nullnet-app/mcp-host-app's plan
 * `docs/superpowers/plans/2026-09-25-contextmint-mac-v0.md` Task 6 unzips this
 * package's release zip into its Safari appex's `Resources/` and its
 * `tools/fetch_bridge_resources.sh` (in nullnet-app/mcp-host-app, not on its
 * `main` yet) fails the app build unless the manifest's background is exactly
 * `{"scripts": [...], "persistent": false}`, `permissions` contains
 * `nativeMessaging`, and `permissions` does not contain `downloads`.
 *
 * If that repo's check changes, this one must change with it.
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

  it('does not ask for downloads', () => {
    expect(built.manifest.permissions).not.toContain('downloads');
  });
});
