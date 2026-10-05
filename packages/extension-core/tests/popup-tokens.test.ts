import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The popup's design tokens mirror the Nullnet design system's.
 *
 * `popup.html` carries a SUBSET of the design system's `system/tokens.css`
 * inline — the popup cannot reach that repo at runtime, and it needs a fraction
 * of the file. A copy drifts unless something holds it, and this is the
 * something: `design-system/tokens.css` is the design system's generated file,
 * vendored verbatim (the way `extension-chrome/icons/` vendors the mark), and
 * every value the popup declares must equal it in the same theme.
 *
 * To take a design-system change: re-copy `system/tokens.css` over
 * `design-system/tokens.css`, run this, and update the popup's block until it
 * passes. Never edit the vendored file by hand.
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const POPUP = read('../src/popup/popup.html');
const VENDORED = read('../design-system/tokens.css');

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const norm = (v: string): string => v.trim().replace(/\s+/g, ' ');

/** The `{ … }` body that opens at `from` (the index of its `{`). */
function blockAt(css: string, from: number): string {
  let depth = 0;
  for (let i = from; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(from + 1, i);
  }
  throw new Error('unbalanced braces');
}

function decls(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of stripComments(body).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, norm(m[2]!));
  return out;
}

/** Light (`:root`) and dark (`@media (prefers-color-scheme: dark) { :root }`) values. */
function themes(css: string): { light: Map<string, string>; dark: Map<string, string> } {
  const bare = stripComments(css);
  const rootAt = bare.indexOf(':root');
  const light = decls(blockAt(bare, bare.indexOf('{', rootAt)));
  const mediaAt = bare.indexOf('@media (prefers-color-scheme: dark)');
  if (mediaAt < 0) throw new Error('no dark block');
  const media = blockAt(bare, bare.indexOf('{', mediaAt));
  const darkOnly = decls(blockAt(media, media.indexOf('{')));
  return { light, dark: new Map([...light, ...darkOnly]) };
}

const tokenBlock = ((): string => {
  const m = /\/\* tokens:begin \*\/([\s\S]*?)\/\* tokens:end \*\//.exec(POPUP);
  if (!m) throw new Error('popup.html has no tokens:begin … tokens:end block');
  return m[1]!;
})();

const ds = themes(VENDORED);
const popup = themes(tokenBlock);

describe('popup.html design tokens', () => {
  it('vendors the design system’s generated tokens file, untouched', () => {
    expect(VENDORED).toContain('GENERATED FROM tokens.json — DO NOT EDIT.');
    expect(ds.light.get('--nn-star')).toBe('#f5c518');
  });

  it('declares only tokens the design system defines', () => {
    const unknown = [...popup.light.keys()].filter((k) => !ds.light.has(k));
    expect(unknown).toEqual([]);
  });

  it.each(['light', 'dark'] as const)('matches the design system value for every token, in %s', (theme) => {
    const drift = [...popup.light.keys()]
      .filter((k) => popup[theme].get(k) !== ds[theme].get(k))
      .map((k) => `${k}: popup ${popup[theme].get(k)} ≠ design system ${ds[theme].get(k)}`);
    expect(drift).toEqual([]);
  });

  it('redeclares in dark every token whose value changes there', () => {
    const darkBlock = decls(blockAt(tokenBlock, tokenBlock.indexOf('{', tokenBlock.indexOf('@media'))));
    const missing = [...popup.light.keys()].filter(
      (k) => ds.dark.get(k) !== ds.light.get(k) && !darkBlock.has(k),
    );
    expect(missing).toEqual([]);
  });

  it('names no colour outside the token block', () => {
    const rest = stripComments(POPUP.replace(tokenBlock, ''));
    expect(rest.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/gi) ?? []).toEqual([]);
  });

  it('uses every token it copies, and copies every token it uses', () => {
    const rest = stripComments(POPUP.replace(tokenBlock, ''));
    const used = new Set([...rest.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
    // Tokens other tokens are built from count as used.
    for (const v of popup.dark.values()) for (const m of v.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(m[1]!);
    expect([...used].filter((k) => !popup.light.has(k))).toEqual([]);
    expect([...popup.light.keys()].filter((k) => !used.has(k))).toEqual([]);
  });
});

describe('popup.html under the extension CSP', () => {
  it('loads nothing remote — no @import, no external stylesheet, font or script', () => {
    expect(POPUP).not.toMatch(/@import|https?:\/\/|<link\b/i);
    expect([...POPUP.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual([
      '<script type="module" src="popup.js">',
    ]);
  });

  it('heads the popup with the ContextMint Bridge mark the extension ships', () => {
    expect(POPUP).toContain('<img class="popup-mark" src="icons/icon.svg" alt=""');
    expect(existsSync(fileURLToPath(new URL('../../extension-chrome/icons/icon.svg', import.meta.url)))).toBe(true);
    expect(POPUP).toMatch(/<h1 class="popup-name">ContextMint <span>Bridge<\/span><\/h1>/);
  });

  it('keeps the motion it has behind prefers-reduced-motion, and a forced-colors fallback', () => {
    expect(POPUP).toContain('@media (prefers-reduced-motion: reduce)');
    expect(POPUP).toContain('@media (forced-colors: active)');
    expect(POPUP).toContain(':focus-visible');
  });
});
