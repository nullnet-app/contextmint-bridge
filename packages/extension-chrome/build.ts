import { build, type BuildOptions } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copyStatic,
  entryBuilds,
  isEntryScript,
  moduleEntryOptions as sharedModuleEntryOptions,
  contentScriptEntryOptions as sharedContentScriptEntryOptions,
  type BuildMode,
  type BuildTarget,
} from './build-lib.js';

export type { BuildMode } from './build-lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * This package is the Chrome build: an ES-module MV3 service worker
 * (manifest `"type": "module"`). The entry points themselves live in
 * `build-lib.ts`, shared with every other browser's build.
 */
export const CHROME_TARGET: BuildTarget = {
  platform: 'chrome',
  outdir: join(HERE, 'dist'),
  backgroundFormat: 'esm',
  target: 'chrome120',
};

/**
 * The shared factories, pre-bound to the Chrome target. With an `'esm'`
 * background the module build carries both background and popup, exactly as
 * before the entries were shared — the regression tests import these.
 */
export function moduleEntryOptions(mode: BuildMode = 'release'): BuildOptions {
  return sharedModuleEntryOptions(CHROME_TARGET, mode);
}

export function contentScriptEntryOptions(mode: BuildMode = 'release'): BuildOptions {
  return sharedContentScriptEntryOptions(CHROME_TARGET, mode);
}

async function main(mode: BuildMode): Promise<void> {
  const out = CHROME_TARGET.outdir;
  await mkdir(out, { recursive: true });

  // ES-module entries (background, popup) and classic content-script entries
  // (content, capture-logger). See `build-lib.ts` for why the split is
  // load-bearing.
  for (const options of entryBuilds(CHROME_TARGET, mode)) await build(options);

  // Chrome's manifest ships verbatim: it is the file release-please bumps.
  await copyStatic(out, {
    manifest: await readFile(join(HERE, 'manifest.json'), 'utf8'),
    iconsDir: join(HERE, 'icons'),
  });
  console.log(`extension-chrome built (${mode}) →`, out);
}

// `--dev` is the only argument: release is the default because this same plain
// command is what the release workflow zips.
// The guard is `isEntryScript` in `build-lib.ts`, shared with every browser.
if (isEntryScript(import.meta.url)) {
  void main(process.argv.includes('--dev') ? 'development' : 'release');
}
