import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { build, type BuildOptions } from 'esbuild';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `build-lib.ts` holds the esbuild entry points every browser build shares, so
 * `extension-safari` (and any later browser) owns only its manifest and its
 * platform constant, never a fork of the entries. Two properties make that
 * safe, and both are pinned here:
 *
 * 1. Importing the library does nothing. Another package's `build.ts` imports
 *    it; if the module body built anything, that import would write a CHROME
 *    `dist/` as a side effect of building Safari.
 * 2. The factories honour the `BuildTarget` they are given — platform define,
 *    background format and outdir — rather than Chrome's values baked in.
 *
 * Asserted on the EMITTED TEXT where it matters, as the other build tests do.
 */

const TOP_LEVEL_EXPORT = /^\s*export[\s{*]/m;
const TOP_LEVEL_IMPORT = /^\s*import[\s{'"*]/m;

async function bundleAll(builds: BuildOptions[]) {
  const files: { path: string; text: string }[] = [];
  for (const options of builds) {
    const result = await build({ ...options, write: false });
    files.push(...result.outputFiles.map((f) => ({ path: f.path, text: f.text })));
  }
  return files;
}

function entryNames(options: BuildOptions): string[] {
  const entries = options.entryPoints;
  if (!entries || Array.isArray(entries)) throw new Error('expected a named entryPoints map');
  return Object.keys(entries);
}

describe('importing build-lib has no side effects', () => {
  afterEach(() => {
    vi.doUnmock('esbuild');
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });

  it('calls neither esbuild nor any filesystem write, and exports only functions', async () => {
    vi.resetModules();
    const esbuildBuild = vi.fn();
    const fsWrites = { mkdir: vi.fn(), copyFile: vi.fn(), writeFile: vi.fn(), cp: vi.fn() };
    vi.doMock('esbuild', () => ({ build: esbuildBuild }));
    vi.doMock('node:fs/promises', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:fs/promises')>()),
      ...fsWrites,
    }));

    const lib = await import('../build-lib.js');

    expect(esbuildBuild).not.toHaveBeenCalled();
    for (const [name, fn] of Object.entries(fsWrites)) {
      expect(fn, `importing build-lib called fs.${name}`).not.toHaveBeenCalled();
    }
    // Types vanish at runtime, so every runtime export must be a function: a
    // computed value at module scope is where a side effect would hide.
    for (const [name, value] of Object.entries(lib)) {
      expect(typeof value, `export ${name}`).toBe('function');
    }
  });
});

describe('the entry factories honour the BuildTarget', () => {
  const safariLike = {
    platform: 'safari',
    outdir: '/nonexistent/safari-dist',
    backgroundFormat: 'iife',
    target: 'safari18',
  } as const;
  const chromeLike = {
    platform: 'chrome',
    outdir: '/nonexistent/chrome-dist',
    backgroundFormat: 'esm',
    target: 'chrome120',
  } as const;

  it('an iife target builds a classic background announcing its own platform', async () => {
    const { entryBuilds } = await import('../build-lib.js');
    const files = await bundleAll(entryBuilds(safariLike, 'release'));

    const background = files.find((f) => f.path.endsWith('/background.js'));
    expect(background, 'no background.js emitted').toBeDefined();
    expect(background!.text).toMatch(/\? void 0 : "safari"/);
    // The protocol's own validators name every platform, so only the folded
    // `currentPlatform()` site distinguishes the build.
    expect(background!.text).not.toMatch(/\? void 0 : "chrome"/);
    // background.ts re-exports helpers for the test suite; an ESM build ends in
    // an `export { … }` block, which a classic event page cannot load.
    expect(TOP_LEVEL_EXPORT.test(background!.text), 'background has a top-level export').toBe(
      false,
    );
    expect(TOP_LEVEL_IMPORT.test(background!.text), 'background has a top-level import').toBe(
      false,
    );
    for (const { path, text } of files) {
      expect(text.includes('__FETCHPROXY_PLATFORM__'), `${path} kept the identifier`).toBe(false);
    }
  });

  it('every output lands in the target outdir', async () => {
    const { entryBuilds } = await import('../build-lib.js');
    for (const target of [safariLike, chromeLike]) {
      const files = await bundleAll(entryBuilds(target, 'release'));
      expect(files.length).toBeGreaterThan(0);
      for (const { path } of files) {
        expect(path.startsWith(target.outdir + '/'), `${path} outside ${target.outdir}`).toBe(true);
      }
    }
  });

  it('builds every entry exactly once, whichever format the background takes', async () => {
    const { entryBuilds } = await import('../build-lib.js');
    for (const target of [safariLike, chromeLike]) {
      const names = entryBuilds(target, 'release').flatMap(entryNames).sort();
      expect(names, target.platform).toEqual(
        ['background', 'capture-logger', 'content', 'popup'].sort(),
      );
    }
  });

  it('the popup stays an ES module and the background follows the target', async () => {
    const { entryBuilds } = await import('../build-lib.js');
    for (const target of [safariLike, chromeLike]) {
      const formatOf = (entry: string) =>
        entryBuilds(target, 'release').find((b) => entryNames(b).includes(entry))!.format;
      expect(formatOf('popup'), `${target.platform} popup`).toBe('esm');
      expect(formatOf('background'), `${target.platform} background`).toBe(target.backgroundFormat);
      expect(formatOf('content'), `${target.platform} content`).toBe('iife');
    }
  });

  it('esbuild targets the engine the BuildTarget names', async () => {
    const { entryBuilds } = await import('../build-lib.js');
    for (const b of entryBuilds(safariLike, 'release')) expect(b.target).toBe('safari18');
  });
});

describe('copyStatic', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('writes the manifest TEXT it is given, popup.html and every icon', async () => {
    const { copyStatic } = await import('../build-lib.js');
    const outdir = await mkdtemp(join(tmpdir(), 'build-lib-static-'));
    dirs.push(outdir);
    const iconsDir = fileURLToPath(new URL('../icons/', import.meta.url));
    const manifest = '{\n  "generated": true\n}\n';

    await copyStatic(outdir, { manifest, iconsDir });

    expect(await readFile(join(outdir, 'manifest.json'), 'utf8')).toBe(manifest);
    const popup = fileURLToPath(
      new URL('../../extension-core/src/popup/popup.html', import.meta.url),
    );
    expect(await readFile(join(outdir, 'popup.html'), 'utf8')).toBe(await readFile(popup, 'utf8'));
    expect((await readdir(join(outdir, 'icons'))).sort()).toEqual((await readdir(iconsDir)).sort());
  });
});
