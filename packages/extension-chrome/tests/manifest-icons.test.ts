import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The icons are copied from the nullnet design system
// (chrischall/nullnet-design-system, system/assets/contextmint-bridge-icon-*),
// which is their source of truth. Guard that every icon the manifest declares
// exists and is a PNG of the pixel size its key claims — a missing or
// mis-sized file makes Chrome reject the unpacked load or blur the toolbar.
const PKG = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('manifest.json', PKG)), 'utf8')) as {
  icons?: Record<string, string>;
  action?: { default_icon?: Record<string, string> };
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width/height from a PNG's IHDR chunk (always the first chunk, at byte 8). */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).equals(PNG_SIGNATURE), 'PNG signature').toBe(true);
  expect(buf.toString('latin1', 12, 16), 'first chunk is IHDR').toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const declared: [string, string, string][] = [
  ...Object.entries(manifest.icons ?? {}).map(([k, p]): [string, string, string] => [
    'icons',
    k,
    p,
  ]),
  ...Object.entries(manifest.action?.default_icon ?? {}).map(([k, p]): [string, string, string] => [
    'action.default_icon',
    k,
    p,
  ]),
];

describe('manifest icons', () => {
  it('declares the 16/32/48/128 set in both icons and action.default_icon', () => {
    expect(Object.keys(manifest.icons ?? {}).sort()).toEqual(['128', '16', '32', '48']);
    expect(Object.keys(manifest.action?.default_icon ?? {}).sort()).toEqual([
      '128',
      '16',
      '32',
      '48',
    ]);
  });

  it.each(declared)('%s[%s] → %s exists and is a PNG of that size', (_field, size, path) => {
    const file = fileURLToPath(new URL(path, PKG));
    expect(existsSync(file), `${path} exists`).toBe(true);
    const { width, height } = pngSize(readFileSync(file));
    expect({ width, height }).toEqual({ width: Number(size), height: Number(size) });
  });

  it('ships the scalable source mark at icons/icon.svg', () => {
    const svg = readFileSync(fileURLToPath(new URL('icons/icon.svg', PKG)), 'utf8');
    expect(svg).toMatch(/<svg[\s>]/);
  });
});
