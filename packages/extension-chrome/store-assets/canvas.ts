/**
 * The branded pages the store assets are captured from: a 1280x800 canvas
 * with a headline beside the real popup, and the 440x280 small promo tile.
 *
 * Brand: ContextMint, from chrischall/nullnet-design-system v1.6.1 —
 * `--nn-ink`, `--nn-paper`, `--nn-star`, the system font stacks, the
 * ContextMint Bridge mark (the same file as `icons/icon.svg`) and the Cursor
 * C (`brand/contextmint-icon.svg`, copied verbatim from `system/assets/`).
 * Dev-only; never bundled into the extension.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const BRAND = {
  ink: '#0b0b0f',
  ink2: '#16161c',
  ink3: '#20202a',
  paper: '#fafafa',
  mutedOnInk: '#b6b6c0',
  star: '#f5c518',
  fontText: '-apple-system, BlinkMacSystemFont, "Inter", system-ui, "Segoe UI", Roboto, sans-serif',
  fontMono: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
} as const;

const CANVAS = { width: 1280, height: 800 };
/** The popup is shown enlarged, but never taller than this. */
const POPUP_MAX_HEIGHT = 700;
const POPUP_PREFERRED_SCALE = 1.3;

const svgDataUrl = (path: string): string =>
  `data:image/svg+xml;base64,${readFileSync(path).toString('base64')}`;

export const bridgeIcon = (): string => svgDataUrl(join(HERE, '..', 'icons', 'icon.svg'));
export const contextMintIcon = (): string =>
  svgDataUrl(join(HERE, 'brand', 'contextmint-icon.svg'));

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(width: number, height: number, css: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; }
  body {
    width: ${width}px; height: ${height}px; overflow: hidden;
    background: ${BRAND.ink}; color: ${BRAND.paper};
    font-family: ${BRAND.fontText};
    -webkit-font-smoothing: antialiased;
  }
  .wordmark { font-family: ${BRAND.fontMono}; font-weight: 700; letter-spacing: -0.03em; }
  .cursor { display: inline-block; background: ${BRAND.star}; vertical-align: -0.12em; }
${css}
</style></head><body>${body}</body></html>`;
}

export interface ScreenshotCanvas {
  headline: string;
  sub: string;
  /** The captured popup, as a data URL. */
  popupPng: string;
  /** The popup's CSS size at capture. */
  popupWidth: number;
  popupHeight: number;
}

export function screenshotHtml(c: ScreenshotCanvas): string {
  const scale = Math.min(POPUP_PREFERRED_SCALE, POPUP_MAX_HEIGHT / c.popupHeight);
  const w = Math.round(c.popupWidth * scale);
  const h = Math.round(c.popupHeight * scale);
  const css = `
  body { --popup-scale: ${scale.toFixed(4)}; display: flex; align-items: center; }
  .copy { width: 560px; padding: 0 0 0 88px; box-sizing: content-box; }
  .brand { display: flex; align-items: center; gap: 14px; margin-bottom: 56px; }
  .brand img { width: 52px; height: 52px; }
  .brand .wordmark { font-size: 26px; }
  .brand .name { font-size: 15px; color: ${BRAND.mutedOnInk}; margin-top: 2px; letter-spacing: 0.02em; }
  h1 { font-size: 46px; line-height: 1.12; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 24px; }
  h1::after { content: ''; display: inline-block; width: 0.22em; height: 0.8em; margin-left: 0.14em;
    background: ${BRAND.star}; vertical-align: -0.05em; }
  p { font-size: 21px; line-height: 1.5; color: ${BRAND.mutedOnInk}; margin: 0; }
  .works { display: flex; align-items: center; gap: 12px; margin-top: 44px; font-size: 16px; color: ${BRAND.mutedOnInk}; }
  .works img { width: 30px; height: 30px; }
  .works b { color: ${BRAND.paper}; font-weight: 600; }
  .stage { flex: 1; height: 100%; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(ellipse at 60% 40%, ${BRAND.ink3} 0%, ${BRAND.ink} 70%); }
  .popup { width: ${w}px; height: ${h}px; border-radius: 12px; overflow: hidden; background: #fff;
    box-shadow: 0 0 0 1px rgba(250,250,250,0.10), 0 30px 80px rgba(0,0,0,0.55); }
  .popup img { display: block; width: 100%; height: 100%; }
`;
  const body = `
  <section class="copy">
    <div class="brand">
      <img src="${bridgeIcon()}" alt="">
      <div>
        <div class="wordmark">contextmint<span class="cursor" style="width:0.42em;height:0.9em;margin-left:0.08em"></span></div>
        <div class="name">Bridge</div>
      </div>
    </div>
    <h1>${escapeHtml(c.headline)}</h1>
    <p>${escapeHtml(c.sub)}</p>
    <div class="works"><img src="${contextMintIcon()}" alt="">
      <span>Works with <b>ContextMint</b>, any fetchproxy-based MCP server, and <b>fpx</b>.</span></div>
  </section>
  <section class="stage"><div class="popup"><img src="${c.popupPng}" alt=""></div></section>`;
  return page(CANVAS.width, CANVAS.height, css, body);
}

export function promoTileHtml(): string {
  const css = `
  body { display: flex; flex-direction: column; justify-content: center; padding: 0 36px; box-sizing: border-box;
    background: radial-gradient(ellipse at 85% 20%, ${BRAND.ink3} 0%, ${BRAND.ink} 65%); }
  .row { display: flex; align-items: center; gap: 18px; }
  .row img { width: 76px; height: 76px; }
  .title { white-space: nowrap; font-size: 29px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }
  .title .cursor { width: 0.2em; height: 0.85em; margin-left: 0.1em; }
  .tag { margin-top: 22px; font-size: 17px; line-height: 1.4; color: ${BRAND.mutedOnInk}; }
  .tag b { color: ${BRAND.paper}; font-weight: 600; }
`;
  const body = `
  <div class="row">
    <img src="${bridgeIcon()}" alt="">
    <div class="title">ContextMint Bridge<span class="cursor"></span></div>
  </div>
  <div class="tag">Let <b>ContextMint</b> and your local <b>MCP tools</b> work in the tabs you’re already signed into.</div>`;
  return page(440, 280, css, body);
}
