import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Brand guard. In the stores the extension is **ContextMint Bridge**; the
 * protocol and npm packages are fetchproxy. The old store name, Transporter,
 * must not survive anywhere a person reads it: the popup, the manifest, the
 * package READMEs, the privacy policy the listings link to, or the store
 * assets pasted into the Chrome Web Store console.
 *
 * Source comments outside the popup may still name Transporter, but only as
 * history ("formerly Transporter", "then named Transporter") — never as the
 * current name.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

function walk(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((name) => {
    const full = join(abs, name);
    const rel = relative(ROOT, full);
    return statSync(full).isDirectory() ? walk(rel) : [rel];
  });
}

const PACKAGES = readdirSync(join(ROOT, 'packages')).filter((p) =>
  statSync(join(ROOT, 'packages', p)).isDirectory(),
);

const USER_FACING: string[] = [
  ...walk('packages/extension-core/src/popup'),
  'packages/extension-chrome/manifest.json',
  'packages/extension-safari/manifest.ts',
  ...PACKAGES.map((p) => `packages/${p}/README.md`),
  'README.md',
  'docs/PRIVACY.md',
  ...walk('docs/store-assets'),
];

describe('no user-facing Transporter', () => {
  it.each(USER_FACING)('%s does not say Transporter', (path) => {
    expect(read(path)).not.toMatch(/transporter/i);
  });
});

describe('source mentions of Transporter are historical only', () => {
  const HISTORICAL = /(formerly|then named|previously named|was named)\s+Transporter/i;
  const sources = PACKAGES.flatMap((p) => walk(`packages/${p}/src`));

  it.each(sources)('%s', (path) => {
    const offending = read(path)
      .split('\n')
      .filter((line) => /transporter/i.test(line) && !HISTORICAL.test(line));
    expect(offending).toEqual([]);
  });
});

describe('manifest identity', () => {
  const manifest = JSON.parse(read('packages/extension-chrome/manifest.json')) as {
    name: string;
    short_name?: string;
    description: string;
    permissions: string[];
  };

  it('is named ContextMint Bridge, short name Bridge', () => {
    expect(manifest.name).toBe('ContextMint Bridge');
    expect(manifest.short_name).toBe('Bridge');
  });

  it('has a Chrome Web Store description of at most 132 characters', () => {
    expect([...manifest.description].length).toBeLessThanOrEqual(132);
  });

  it('describes connecting ContextMint and local MCP tools to signed-in tabs', () => {
    expect(manifest.description).toMatch(/ContextMint/);
    expect(manifest.description).toMatch(/MCP/);
    expect(manifest.description).toMatch(/signed-in/i);
    expect(manifest.description).toMatch(/tab/i);
  });

  it('every requested permission has a store justification', () => {
    const justifications = read('docs/store-assets/permission-justifications.md');
    for (const perm of manifest.permissions) {
      expect(justifications, perm).toContain(`### \`${perm}\``);
    }
  });
});

describe('Safari-only permissions', () => {
  it('every permission the Safari manifest adds has a justification marked Safari-only', async () => {
    const { safariManifest } = await import('../packages/extension-safari/manifest.js');
    const chrome = JSON.parse(read('packages/extension-chrome/manifest.json'));
    const added = (safariManifest(chrome).permissions ?? []).filter(
      (p: string) => !(chrome.permissions as string[]).includes(p),
    );
    expect(added.length).toBeGreaterThan(0);
    const justifications = read('docs/store-assets/permission-justifications.md');
    for (const perm of added) {
      const heading = `### \`${perm}\``;
      expect(justifications, perm).toContain(heading);
      const body = justifications.slice(justifications.indexOf(heading)).split('\n---')[0]!;
      expect(body, perm).toMatch(/Safari only/i);
    }
  });
});

describe('store listing and README say who it works with', () => {
  it.each(['docs/store-assets/listing-description.md', 'README.md'])(
    '%s names ContextMint, fetchproxy-based MCPs and fpx',
    (path) => {
      const md = read(path);
      expect(md).toMatch(/ContextMint Bridge/);
      expect(md).toMatch(/fetchproxy-based MCP/);
      expect(md).toMatch(/`fpx`/);
    },
  );

  it('the root README carries the bridge sentence and links the protocol repo', () => {
    const md = read('README.md');
    expect(md).toMatch(
      /it's \*\*ContextMint Bridge\*\*; the protocol\s+and npm packages are \*\*fetchproxy\*\*/,
    );
    expect(md).toContain('https://github.com/chrischall/fetchproxy');
    expect(md).toMatch(/Load unpacked/);
  });
});
