import type { BuildOptions } from 'esbuild';
import { mkdir, copyFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Platform } from '@fetchproxy/protocol';

/**
 * The esbuild entry points every browser build shares. `build.ts` in this
 * package is the Chrome target; `extension-safari` imports this module and owns
 * only its manifest and its platform constant — never a fork of the entries.
 *
 * This module must stay PURE: it exports functions and types and its body calls
 * none of them. Another package's `build.ts` imports it, and a module-scope
 * build here would write a Chrome `dist/` every time Safari built
 * (`tests/build-lib.test.ts` pins that).
 */

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension-core', 'src');

/**
 * Which build this is. The release `.zip` attached to every GitHub Release is
 * produced by the plain `tsx build.ts` the release workflow runs, so whatever
 * the DEFAULT is, is what ships — which is why `'release'` is the default and
 * `--dev` is the opt-in, rather than a release flag the workflow has to
 * remember. `npm run build:dev` is the developer's path.
 */
export type BuildMode = 'release' | 'development';

/**
 * One browser's build. `platform` is what the extension hello announces;
 * `backgroundFormat` is how that browser loads the background — Chrome runs an
 * ES-module service worker (`'esm'`), Safari only a classic event-page script
 * (`'iife'`); `target` is the esbuild engine target.
 */
export interface BuildTarget {
  platform: Platform;
  outdir: string;
  backgroundFormat: 'esm' | 'iife';
  target: string;
}

/**
 * Sourcemaps are a development affordance only. `sourcemap: 'inline'` was
 * unconditional, so the shipped `dist/background.js` (754 KB) carried a base64
 * copy of every extension-core and protocol source inside it.
 */
function sharedOptions(target: BuildTarget, mode: BuildMode): BuildOptions {
  return {
    bundle: true,
    platform: 'browser',
    target: target.target,
    outdir: target.outdir,
    sourcemap: mode === 'development' ? 'inline' : false,
    // The platform the extension hello announces (extension-core `platform.ts`).
    // Every entry gets it: there is no default, and a bundle without it throws.
    define: { __FETCHPROXY_PLATFORM__: JSON.stringify(target.platform) },
  };
}

/**
 * The ES-module entries, built with `format: 'esm'`. The popup is always one
 * (loaded via `<script type="module">` from an extension page, which Chrome and
 * the spike's Safari both run). The background is one only when the target's
 * background loads as a module — Chrome's service worker (manifest
 * `"type": "module"`); otherwise `classicBackgroundEntryOptions` builds it.
 */
export function moduleEntryOptions(target: BuildTarget, mode: BuildMode = 'release'): BuildOptions {
  return {
    ...sharedOptions(target, mode),
    format: 'esm',
    entryPoints: {
      ...(target.backgroundFormat === 'esm' ? { background: join(CORE, 'background.ts') } : {}),
      popup: join(CORE, 'popup', 'popup.ts'),
    },
  };
}

/**
 * The background as a classic script, for a target whose background is not a
 * module — Safari 27 ran the background only as a non-persistent event page
 * (`"background": {"scripts": [...], "persistent": false}`) and never an ES
 * module. `format: 'iife'` also drops the trailing `export { … }` block that
 * `background.ts`'s test re-exports leave in an ESM bundle, without touching
 * the source. `undefined` for an `'esm'` target, whose background
 * `moduleEntryOptions` already builds.
 */
export function classicBackgroundEntryOptions(
  target: BuildTarget,
  mode: BuildMode = 'release',
): BuildOptions | undefined {
  if (target.backgroundFormat !== 'iife') return undefined;
  return {
    ...sharedOptions(target, mode),
    format: 'iife',
    entryPoints: { background: join(CORE, 'background.ts') },
  };
}

/**
 * `content.ts` + `capture-logger.ts` are injected as **classic** content
 * scripts — MV3 has no module content scripts. A content-script file that
 * contains a top-level `import`/`export` statement is not a valid classic
 * script: Chrome silently refuses to inject it, so its
 * `chrome.runtime.onMessage` listener never registers and every
 * service-worker→content-script `sendMessage` fails with "Could not
 * establish connection. Receiving end does not exist." (surfaced by the
 * bridge as "N URL match(es), none responded").
 *
 * `format: 'iife'` wraps each bundle in a function expression and emits
 * **no** top-level `import`/`export`, regardless of what the source
 * module exports (e.g. `content.ts` exports `readDomValues` /
 * `runGraphqlQuery` and `capture-logger.ts` exports `installApolloBridge`
 * / `recordDocsFromLink` for unit tests). This is the invariant enforced
 * by `packages/extension-chrome/tests/content-scripts-classic.test.ts`. Do
 * not switch these entries back to `esm`.
 */
export function contentScriptEntryOptions(
  target: BuildTarget,
  mode: BuildMode = 'release',
): BuildOptions {
  return {
    ...sharedOptions(target, mode),
    format: 'iife',
    entryPoints: {
      content: join(CORE, 'content.ts'),
      'capture-logger': join(CORE, 'capture-logger.ts'),
    },
  };
}

/**
 * Every esbuild build a target needs, each entry exactly once: the ES-module
 * entries, the classic background when the target has one, and the classic
 * content scripts. The split by format is load-bearing — see each factory.
 */
export function entryBuilds(target: BuildTarget, mode: BuildMode = 'release'): BuildOptions[] {
  const classicBackground = classicBackgroundEntryOptions(target, mode);
  return [
    moduleEntryOptions(target, mode),
    ...(classicBackground ? [classicBackground] : []),
    contentScriptEntryOptions(target, mode),
  ];
}

/**
 * The static files beside the bundles: the manifest, the popup page and the
 * icons. `manifest` is the manifest's JSON TEXT, not a path — Chrome passes its
 * `manifest.json` file's contents verbatim, Safari a manifest it generates from
 * Chrome's — so one helper serves both. `iconsDir` is copied flat into
 * `<outdir>/icons/`.
 */
export async function copyStatic(
  outdir: string,
  { manifest, iconsDir }: { manifest: string; iconsDir: string },
): Promise<void> {
  await mkdir(join(outdir, 'icons'), { recursive: true });
  await writeFile(join(outdir, 'manifest.json'), manifest);
  await copyFile(join(CORE, 'popup', 'popup.html'), join(outdir, 'popup.html'));
  for (const f of await readdir(iconsDir)) {
    await copyFile(join(iconsDir, f), join(outdir, 'icons', f));
  }
}
