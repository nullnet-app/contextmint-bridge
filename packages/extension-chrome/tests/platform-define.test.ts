import { describe, it, expect } from 'vitest';
import { build, type BuildOptions } from 'esbuild';
import { contentScriptEntryOptions, moduleEntryOptions } from '../build.js';

/**
 * The extension hello's `platform` is an esbuild define, read by
 * extension-core's `currentPlatform()`. This package is the Chrome build, so
 * every entry must substitute the literal `"chrome"` — and a bundle that still
 * mentions `__FETCHPROXY_PLATFORM__` would throw on the first connect instead
 * of saying hello.
 *
 * Asserted on the EMITTED TEXT (as release-bundle-sourcemaps.test.ts does), so
 * this pins what ships rather than restating `build.ts` to itself.
 */
async function bundle(options: BuildOptions) {
  const result = await build({ ...options, write: false });
  return result.outputFiles.map((f) => ({ path: f.path, text: f.text }));
}

describe('the Chrome bundle is built for platform "chrome"', () => {
  it.each([
    ['module entries', moduleEntryOptions],
    ['content-script entries', contentScriptEntryOptions],
  ])('%s leave no __FETCHPROXY_PLATFORM__ identifier behind', async (_label, options) => {
    const files = await bundle(options('release'));
    expect(files.length).toBeGreaterThan(0);
    for (const { path, text } of files) {
      expect(text.includes('__FETCHPROXY_PLATFORM__'), `${path} kept the identifier`).toBe(false);
    }
  });

  it('background.js carries the substituted "chrome" literal where the platform is read', async () => {
    const files = await bundle(moduleEntryOptions('release'));
    const background = files.find((f) => f.path.endsWith('background.js'));
    expect(background, 'no background.js emitted').toBeDefined();
    // With the define, esbuild folds `typeof __FETCHPROXY_PLATFORM__ === 'undefined'
    // ? undefined : __FETCHPROXY_PLATFORM__` in `currentPlatform()` to
    // `false ? void 0 : "chrome"`. Without it, the identifier survives instead.
    expect(background!.text).toMatch(/\? void 0 : "chrome"/);
  });
});
