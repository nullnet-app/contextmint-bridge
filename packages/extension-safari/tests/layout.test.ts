import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempSafariBuild } from './helpers/temp-build.js';

/**
 * The build's output directory is exactly what nullnet-app/mcp-host-app's
 * appex unzips into `Resources/`, so `manifest.json` must be at its root and
 * every file the manifest names must be beside it. Built into a temp dir,
 * never `dist/` (see `helpers/temp-build.ts`).
 */

let built: Awaited<ReturnType<typeof tempSafariBuild>>;
beforeAll(async () => {
  built = await tempSafariBuild();
});
afterAll(async () => {
  await built?.cleanup();
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).equals(PNG_SIGNATURE), 'PNG signature').toBe(true);
  expect(buf.toString('latin1', 12, 16), 'first chunk is IHDR').toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('the Safari resources directory', () => {
  it('has manifest.json at its root', () => {
    expect(existsSync(join(built.outdir, 'manifest.json'))).toBe(true);
  });

  it('contains every file the manifest names', () => {
    const m = built.manifest;
    const named = [
      ...m.background.scripts,
      ...(m.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
      ...(m.action?.default_popup ? [m.action.default_popup] : []),
      ...Object.values(m.icons ?? {}),
      ...Object.values(m.action?.default_icon ?? {}),
    ];
    expect(named.length).toBeGreaterThan(0);
    for (const file of named) expect(existsSync(join(built.outdir, file)), file).toBe(true);
  });

  it('contains the files the extension loads without the manifest naming them', () => {
    // capture-logger.js is registered at runtime (main-world-bridge.ts); popup.js
    // is loaded by popup.html.
    for (const file of ['capture-logger.js', 'popup.js']) {
      expect(existsSync(join(built.outdir, file)), file).toBe(true);
    }
    expect(readFileSync(join(built.outdir, 'popup.html'), 'utf8')).toContain('popup.js');
  });

  it.each(['icons', 'default_icon'] as const)(
    'every %s entry is a PNG of its declared size',
    (field) => {
      const icons = field === 'icons' ? built.manifest.icons : built.manifest.action?.default_icon;
      expect(Object.keys(icons ?? {}).sort()).toEqual(['128', '16', '32', '48']);
      for (const [size, path] of Object.entries(icons ?? {})) {
        const { width, height } = pngSize(readFileSync(join(built.outdir, path)));
        expect({ width, height }, path).toEqual({ width: Number(size), height: Number(size) });
      }
    },
  );
});
