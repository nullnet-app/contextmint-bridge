import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { Script } from 'node:vm';
import { safariEntryBuilds } from '../build.js';
import { moduleEntryOptions as chromeModuleEntryOptions } from '../../extension-chrome/build.js';

/**
 * Spike fact 2 (macOS Safari 27): the background runs only as a CLASSIC
 * event-page script — an ES-module background never ran. Content scripts are
 * classic in every browser. So every entry Safari loads as a classic script
 * must compile as one: `new vm.Script(text)` compiles exactly that way and
 * throws `SyntaxError` on a top-level `import` / `export` — which is what the
 * Chrome background bundle ends in (`background.ts` re-exports helpers for the
 * tests). `import.meta` is a module-only form and must not appear either.
 */

const CLASSIC = ['background.js', 'content.js', 'capture-logger.js'];

async function emitted() {
  const files: { name: string; text: string }[] = [];
  const warnings: string[] = [];
  for (const options of safariEntryBuilds('release')) {
    const result = await build({ ...options, write: false });
    warnings.push(...result.warnings.map((w) => w.text));
    for (const f of result.outputFiles)
      files.push({ name: f.path.split('/').pop()!, text: f.text });
  }
  return { files, warnings };
}

describe('Safari’s classic-script entries', () => {
  it.each(CLASSIC)('%s compiles as a classic script', async (name) => {
    const { files } = await emitted();
    const file = files.find((f) => f.name === name);
    expect(file, `no ${name} emitted`).toBeDefined();
    expect(() => new Script(file!.text, { filename: name })).not.toThrow();
    expect(file!.text.includes('import.meta'), `${name} uses import.meta`).toBe(false);
  });

  it('the build emits no esbuild warnings', async () => {
    const { warnings } = await emitted();
    expect(warnings).toEqual([]);
  });

  it('the popup is still an ES module (loaded by <script type="module">)', async () => {
    const { files } = await emitted();
    expect(files.map((f) => f.name)).toContain('popup.js');
  });
});

describe('the classic-script check itself', () => {
  it('rejects the Chrome background, which is an ES module with a trailing export block', async () => {
    // Proves the vm.Script check can fail: the same source built as Chrome's
    // module service worker is not a valid classic script.
    const result = await build({ ...chromeModuleEntryOptions('release'), write: false });
    const background = result.outputFiles.find((f) => f.path.endsWith('/background.js'));
    expect(background).toBeDefined();
    expect(() => new Script(background!.text)).toThrow(SyntaxError);
  });
});
