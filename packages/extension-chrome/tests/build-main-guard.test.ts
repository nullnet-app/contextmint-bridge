import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `build.ts` runs the Chrome build only when it IS the entry script. The old
 * guard also accepted any `process.argv[1]` that merely ended in `build.ts`, so
 * `tsx packages/extension-safari/build.ts` importing this module would have
 * built — and written — the CHROME `dist/` as a side effect.
 *
 * Each test points `process.argv[1]` somewhere, re-imports `build.ts` fresh
 * with esbuild and the filesystem writes mocked, and watches whether `main`
 * reached esbuild.
 */

const BUILD_TS = fileURLToPath(new URL('../build.ts', import.meta.url));
const realArgv = [...process.argv];
const dirs: string[] = [];

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
  // `main` is async and fire-and-forget; give it every chance to reach esbuild.
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

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('build.ts runs main only when it is the entry script', () => {
  it('does NOT build when another package’s build.ts is the entry', async () => {
    const other = join(tmpdir(), 'extension-safari', 'build.ts');
    const esbuildBuild = await importBuildWithArgv1(other);
    expect(esbuildBuild).not.toHaveBeenCalled();
  });

  it('builds when invoked as itself', async () => {
    const esbuildBuild = await importBuildWithArgv1(BUILD_TS);
    expect(esbuildBuild).toHaveBeenCalled();
  });

  it('builds when invoked through a symlink (macOS /tmp → /private/tmp)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'build-main-guard-'));
    dirs.push(dir);
    const link = join(dir, 'chrome-entry.ts');
    await symlink(BUILD_TS, link);
    const esbuildBuild = await importBuildWithArgv1(link);
    expect(esbuildBuild).toHaveBeenCalled();
  });
});
