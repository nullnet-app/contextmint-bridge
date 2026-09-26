import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSafari } from '../../build.js';
import type { SafariManifest } from '../../manifest.js';

/**
 * A real Safari build into a throwaway directory. No test in this package may
 * read `packages/extension-safari/dist/`: `npm test` runs with no prior build
 * in a fresh worktree and in CI's `protocol-next` job, so a test that needs
 * built output builds it here and removes it in `afterAll` (`cleanup`).
 */
export async function tempSafariBuild(): Promise<{
  outdir: string;
  manifest: SafariManifest;
  cleanup: () => Promise<void>;
}> {
  const outdir = await mkdtemp(join(tmpdir(), 'extension-safari-build-'));
  await buildSafari({ outdir, mode: 'release' });
  const manifest = JSON.parse(
    await readFile(join(outdir, 'manifest.json'), 'utf8'),
  ) as SafariManifest;
  return { outdir, manifest, cleanup: () => rm(outdir, { recursive: true, force: true }) };
}
