import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { safariEntryBuilds } from '../build.js';
import type { BuildMode } from '../../extension-chrome/build-lib.js';

/**
 * Release is the default and carries no sourcemaps; `--dev` inlines them.
 * Mirrors `packages/extension-chrome/tests/release-bundle-sourcemaps.test.ts`:
 * whatever the plain `tsx build.ts` emits is what gets zipped for mcp-host-app.
 */
async function bundles(mode?: BuildMode) {
  const out: { path: string; text: string }[] = [];
  for (const options of mode ? safariEntryBuilds(mode) : safariEntryBuilds()) {
    const result = await build({ ...options, write: false });
    out.push(...result.outputFiles.map((f) => ({ path: f.path, text: f.text })));
  }
  return out;
}

const SOURCEMAP_COMMENT = /\/\/# sourceMappingURL=/;

describe('the Safari bundles', () => {
  it.each([['release'], ['the default']])(
    '%s: no map file and no sourceMappingURL',
    async (label) => {
      const files = await bundles(label === 'release' ? 'release' : undefined);
      expect(files.length).toBeGreaterThan(0);
      for (const { path, text } of files) {
        expect(path.endsWith('.map'), `${path} is a sourcemap`).toBe(false);
        expect(SOURCEMAP_COMMENT.test(text), `${path} has a sourceMappingURL`).toBe(false);
      }
    },
  );

  it('development keeps its inline sourcemaps', async () => {
    const files = await bundles('development');
    expect(files.length).toBeGreaterThan(0);
    for (const { path, text } of files) {
      expect(SOURCEMAP_COMMENT.test(text), `${path} lost its sourceMappingURL`).toBe(true);
    }
  });
});
