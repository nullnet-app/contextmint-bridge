import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { safariEntryBuilds } from '../build.js';

/**
 * The extension hello's `platform` is an esbuild define, read by
 * extension-core's `currentPlatform()`. This package is the Safari build, so
 * every bundle must substitute the literal `"safari"`; a bundle still naming
 * `__FETCHPROXY_PLATFORM__` would throw on the first connect. Mirrors
 * `packages/extension-chrome/tests/platform-define.test.ts`, on emitted text.
 */
async function bundles() {
  const out: { path: string; text: string }[] = [];
  for (const options of safariEntryBuilds('release')) {
    const result = await build({ ...options, write: false });
    out.push(...result.outputFiles.map((f) => ({ path: f.path, text: f.text })));
  }
  return out;
}

describe('the Safari bundle is built for platform "safari"', () => {
  it('no bundle keeps the __FETCHPROXY_PLATFORM__ identifier', async () => {
    const files = await bundles();
    expect(files.length).toBeGreaterThan(0);
    for (const { path, text } of files) {
      expect(text.includes('__FETCHPROXY_PLATFORM__'), `${path} kept the identifier`).toBe(false);
    }
  });

  it('background.js carries the substituted "safari" literal where the platform is read', async () => {
    const background = (await bundles()).find((f) => f.path.endsWith('/background.js'));
    expect(background, 'no background.js emitted').toBeDefined();
    expect(background!.text).toMatch(/\? void 0 : "safari"/);
    expect(background!.text).not.toMatch(/\? void 0 : "chrome"/);
  });
});
