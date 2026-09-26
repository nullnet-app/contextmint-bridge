import { describe, it, expect, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';

/**
 * `build.ts` runs the Safari build only when it IS the entry script (the same
 * exact real-path guard as `packages/extension-chrome/build.ts`): importing it
 * from a test or from another build must never write `dist/`.
 */

const SAFARI_BUILD = fileURLToPath(new URL('../build.ts', import.meta.url));
const CHROME_BUILD = fileURLToPath(new URL('../../extension-chrome/build.ts', import.meta.url));
const realArgv = [...process.argv];

async function importBuildWithArgv1(argv1: string) {
  vi.resetModules();
  const esbuildBuild = vi.fn(async () => ({ outputFiles: [], errors: [], warnings: [] }));
  vi.doMock('esbuild', () => ({ build: esbuildBuild }));
  vi.doMock('node:fs/promises', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs/promises')>()),
    mkdir: vi.fn(async () => undefined),
    copyFile: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.argv[1] = argv1;
  await import('../build.js');
  await new Promise((r) => setTimeout(r, 50));
  return esbuildBuild;
}

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...realArgv);
  vi.doUnmock('esbuild');
  vi.doUnmock('node:fs/promises');
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('extension-safari build.ts runs main only when it is the entry script', () => {
  it('does NOT build when the Chrome build.ts is the entry', async () => {
    expect(await importBuildWithArgv1(CHROME_BUILD)).not.toHaveBeenCalled();
  });

  it('builds when invoked as itself', async () => {
    expect(await importBuildWithArgv1(SAFARI_BUILD)).toHaveBeenCalled();
  });
});
