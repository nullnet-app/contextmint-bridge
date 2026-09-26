import { build, type BuildOptions } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Imported by relative path from the Chrome package: both are private
// workspaces in this repo, `build-lib.ts` is where the shared esbuild entry
// points live (so Safari owns only its manifest and platform constant, never a
// fork of the entries), and the `.js` specifier resolves to the `.ts` under
// both tsx and tsc (`moduleResolution: Bundler`), as the tests' `../build.js`
// imports do.
import {
  copyStatic,
  entryBuilds,
  isEntryScript,
  type BuildMode,
  type BuildTarget,
} from '../extension-chrome/build-lib.js';
import { safariManifest, type ChromeManifest } from './manifest.js';

export type { BuildMode } from '../extension-chrome/build-lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = join(HERE, '..', 'extension-chrome');

/**
 * The Safari web-extension resources. `backgroundFormat: 'iife'` because Safari
 * 27 ran the background only as a classic event-page script, never an ES
 * module (spike). `safari18` is the newest Safari esbuild 0.28 has compat data
 * for; Safari 27 runs everything it emits.
 */
export const SAFARI_TARGET: BuildTarget = {
  platform: 'safari',
  outdir: join(HERE, 'dist'),
  backgroundFormat: 'iife',
  target: 'safari18',
};

/**
 * Every esbuild build Safari needs (module popup, classic background, classic
 * content scripts), for the tests to build with `write: false`.
 */
export function safariEntryBuilds(mode: BuildMode = 'release'): BuildOptions[] {
  return entryBuilds(SAFARI_TARGET, mode);
}

/**
 * Build the resources directory mcp-host-app's appex unzips into `Resources/`:
 * the bundles, `popup.html`, the icons, and the manifest generated from
 * Chrome's at `manifest.json` in the directory's root. Reads only Chrome's
 * sources (manifest + icons), never its `dist/`, so it does not depend on the
 * Chrome build having run.
 */
export async function buildSafari({
  outdir,
  mode,
}: {
  outdir: string;
  mode: BuildMode;
}): Promise<void> {
  const target: BuildTarget = { ...SAFARI_TARGET, outdir };
  await mkdir(outdir, { recursive: true });
  for (const options of entryBuilds(target, mode)) await build(options);

  const chrome = JSON.parse(
    await readFile(join(CHROME, 'manifest.json'), 'utf8'),
  ) as ChromeManifest;
  // The icons' source of truth is the design system, copied once into
  // extension-chrome/icons/ — never a second copy in this package.
  await copyStatic(outdir, {
    manifest: JSON.stringify(safariManifest(chrome), null, 2) + '\n',
    iconsDir: join(CHROME, 'icons'),
  });
}

async function main(mode: BuildMode): Promise<void> {
  await buildSafari({ outdir: SAFARI_TARGET.outdir, mode });
  console.log(`extension-safari built (${mode}) →`, SAFARI_TARGET.outdir);
}

// Build only when run (`tsx build.ts`), never when imported. `--dev` is the
// only argument: release is the default because this same plain command is
// what gets zipped for mcp-host-app.
if (isEntryScript(import.meta.url)) {
  void main(process.argv.includes('--dev') ? 'development' : 'release');
}
