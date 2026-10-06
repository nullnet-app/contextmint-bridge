/**
 * Regenerate the Chrome Web Store listing images in docs/store-assets/, and
 * the App Store's in docs/store-assets/app-store/screenshots/:
 *
 *   npm run store-assets --workspace=@fetchproxy/extension-chrome
 *
 * `-- --only=chrome` or `-- --only=app-store` renders just one set. The App
 * Store set is captured from the SAFARI build's popup
 * (packages/extension-safari/dist/, which the npm script builds too), so it
 * shows what Safari shows ("Safari on iPhone", not "Chrome on Mac").
 *
 * For each screenshot scene it serves the BUILT popup (`dist/popup.html` +
 * `popup.js`, rebuilt by the npm script first) from a loopback HTTP server,
 * with a `chrome.*` stub (`chrome-stub.ts`) injected ahead of the popup's
 * module and the scene's trust records seeded through the extension's own
 * vault code (`seed.ts`), in a fresh headless-Chrome profile. The captured
 * popup is then composited onto a branded 1280x800 canvas (`canvas.ts`), and
 * every PNG is re-encoded without alpha (`png.ts`), as the store requires.
 *
 * Needs a local Chrome or Chromium: `CHROME_PATH`, else the usual install
 * locations. Dev-only — nothing here is bundled into the extension.
 */
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import puppeteer, { type Browser } from 'puppeteer-core';
import { CHROME_TARGET } from '../build.js';
import {
  APP_STORE_SCREENSHOTS,
  APP_STORE_SIZES,
  POPUP_SHOTS,
  SCENES,
  SCREENSHOTS,
  type AppStoreDevice,
  type PopupScene,
  type SceneName,
} from './scenes.js';
import { chromeStubSource } from './chrome-stub.js';
import { appStoreScreenshotHtml, marqueeTileHtml, promoTileHtml, screenshotHtml } from './canvas.js';
import { stripAlpha } from './png.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const DIST = CHROME_TARGET.outdir;
/** extension-safari's SAFARI_TARGET.outdir, built by the npm script first. */
const SAFARI_DIST = join(ROOT, 'packages', 'extension-safari', 'dist');
const OUT = join(ROOT, 'docs', 'store-assets');

/** Chrome's popup never grows past 600px tall; neither does ours. */
const POPUP_MAX_HEIGHT = 600;
/** popup.html's `body { width: 380px }`. */
const POPUP_WIDTH = 380;
/** Captured at 2x so the enlarged popup on the canvas stays sharp. */
const POPUP_SCALE = 2;
/** The portrait App Store canvases enlarge the popup up to ~4.7x. */
const APP_STORE_CAPTURE_SCALE: Record<AppStoreDevice, number> = { mac: 2, iphone: 5, ipad: 5 };
/** What `navigator.platform` says on each device: the popup names this browser by it. */
const APP_STORE_NAVIGATOR_PLATFORM: Record<AppStoreDevice, string> = {
  mac: 'MacIntel',
  iphone: 'iPhone',
  ipad: 'iPad',
};

function chromePath(): string {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const found = candidates.find((p): p is string => !!p && existsSync(p));
  if (!found) throw new Error('No Chrome found: set CHROME_PATH to a Chrome or Chromium binary.');
  return found;
}

async function seedBundle(): Promise<string> {
  const result = await build({
    entryPoints: [join(HERE, 'seed.ts')],
    bundle: true,
    format: 'esm',
    target: CHROME_TARGET.target,
    platform: 'browser',
    write: false,
    define: { __FETCHPROXY_PLATFORM__: JSON.stringify(CHROME_TARGET.platform) },
  });
  return result.outputFiles[0]!.text;
}

interface Routes {
  [path: string]: { type: string; body: string | Buffer };
}

async function routesFor(
  scene: PopupScene,
  version: string,
  seedJs: string,
  dist: string = DIST,
): Promise<Routes> {
  const popupHtml = await readFile(join(dist, 'popup.html'), 'utf8');
  const stub = '<script src="stub.js"></script>';
  if (!popupHtml.includes('<script type="module" src="popup.js">')) {
    throw new Error('dist/popup.html no longer loads popup.js the way this generator expects');
  }
  const seed = {
    version,
    trusted: scene.trusted,
    remoteTargets: scene.remoteTargets,
    accounts: scene.accounts ?? [],
    derived: scene.derived ?? [],
    vaultLoss: scene.vaultLoss ?? null,
  };
  return {
    '/popup.html': {
      type: 'text/html',
      body: popupHtml.replace('</head>', `  ${stub}\n  </head>`),
    },
    '/popup.js': { type: 'text/javascript', body: await readFile(join(dist, 'popup.js')) },
    // The header's mark, as the extension serves it from dist/icons/.
    '/icons/icon.svg': { type: 'image/svg+xml', body: await readFile(join(dist, 'icons', 'icon.svg')) },
    '/stub.js': { type: 'text/javascript', body: chromeStubSource(scene, version) },
    '/seed.js': { type: 'text/javascript', body: seedJs },
    '/seed.html': {
      type: 'text/html',
      body: `<!doctype html><meta charset="utf-8">${stub}
<script>window.__SEED__ = ${JSON.stringify(seed)};</script>
<script type="module" src="seed.js"></script>`,
    },
  };
}

function serve(getRoutes: () => Routes): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const route = getRoutes()[new URL(req.url ?? '/', 'http://x').pathname];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': route.type, 'cache-control': 'no-store' }).end(route.body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

async function capturePopup(
  browser: Browser,
  origin: string,
  scene: PopupScene,
  scheme: 'light' | 'dark' = 'light',
  { scale = POPUP_SCALE, navigatorPlatform }: { scale?: number; navigatorPlatform?: string } = {},
): Promise<{ png: Buffer; width: number; height: number; end?: Buffer }> {
  // A fresh profile per scene: the vault is per-origin IndexedDB, and every
  // scene is served from the same origin.
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('[popup]', e));
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await page.setViewport({
      width: POPUP_WIDTH,
      height: POPUP_MAX_HEIGHT,
      deviceScaleFactor: scale,
    });
    if (navigatorPlatform) {
      // A source string, not a function: tsx's __name helper does not exist in the page.
      await page.evaluateOnNewDocument(
        `Object.defineProperty(Navigator.prototype, 'platform', { get: () => ${JSON.stringify(navigatorPlatform)} });`,
      );
    }

    await page.goto(`${origin}/seed.html`);
    await page.waitForFunction(
      () =>
        (window as { __seeded?: boolean; __seedError?: string }).__seeded ||
        (window as { __seedError?: string }).__seedError,
    );
    const seedError = await page.evaluate(() => (window as { __seedError?: string }).__seedError);
    if (seedError) throw new Error(`seeding failed: ${seedError}`);

    await page.goto(`${origin}/popup.html`);
    await page.waitForFunction(() => {
      const root = document.getElementById('root');
      return !!root && root.textContent !== 'Loading…' && root.childElementCount > 0;
    });
    if (scene.openInactive) {
      await page.evaluate(() =>
        document.querySelector('details.trusted-inactive')?.setAttribute('open', ''),
      );
    }
    // Nothing focused: a focus ring on the default button is not the popup at rest.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // At rest, too: the disclosure's rise would be captured half-faded.
    await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));

    const height = Math.min(
      POPUP_MAX_HEIGHT,
      // The body's own height: the document's is never less than the viewport.
      await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height)),
    );
    const png = Buffer.from(
      await page.screenshot({ clip: { x: 0, y: 0, width: POPUP_WIDTH, height } }),
    );
    // Past 600px the body scrolls under a sticky header; show its end as well.
    const scrolls = await page.evaluate(() => {
      const b = document.body;
      if (b.scrollHeight <= b.clientHeight) return false;
      b.scrollTop = b.scrollHeight;
      return true;
    });
    const end = scrolls
      ? Buffer.from(
          await page.screenshot({
            clip: { x: 0, y: 0, width: POPUP_WIDTH, height },
            // Growing the viewport to fit the clip would undo the scroll.
            captureBeyondViewport: false,
          }),
        )
      : undefined;
    return { png, width: POPUP_WIDTH, height, ...(end ? { end } : {}) };
  } finally {
    await context.close();
  }
}

async function renderHtml(
  browser: Browser,
  html: string,
  width: number,
  height: number,
): Promise<Buffer> {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    return stripAlpha(Buffer.from(await page.screenshot({ clip: { x: 0, y: 0, width, height } })));
  } finally {
    await page.close();
  }
}

async function write(path: string, png: Buffer): Promise<void> {
  const abs = join(OUT, path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, png);
  console.log('wrote', relative(ROOT, abs));
}

async function main(): Promise<void> {
  if (!existsSync(join(DIST, 'popup.js'))) {
    throw new Error(`${relative(ROOT, DIST)}/popup.js is missing — build the extension first`);
  }
  const manifest = JSON.parse(await readFile(join(HERE, '..', 'manifest.json'), 'utf8')) as {
    version: string;
  };
  const seedJs = await seedBundle();

  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
  if (only !== undefined && only !== 'chrome' && only !== 'app-store') {
    throw new Error(`--only=${only}: expected chrome or app-store`);
  }
  if (only !== 'chrome' && !existsSync(join(SAFARI_DIST, 'popup.js'))) {
    throw new Error(`${relative(ROOT, SAFARI_DIST)}/popup.js is missing — build extension-safari first`);
  }

  let routes: Routes = {};
  const { server, origin } = await serve(() => routes);
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true });
  try {
    if (only !== 'app-store') await renderChrome();
    if (only !== 'chrome') await renderAppStore();
  } finally {
    await browser.close();
    server.close();
  }

  async function renderAppStore(): Promise<void> {
    for (const shot of APP_STORE_SCREENSHOTS) {
      routes = await routesFor(SCENES[shot.scene], manifest.version, seedJs, SAFARI_DIST);
      const popup = await capturePopup(browser, origin, SCENES[shot.scene], 'light', {
        scale: APP_STORE_CAPTURE_SCALE[shot.device],
        navigatorPlatform: APP_STORE_NAVIGATOR_PLATFORM[shot.device],
      });
      const { width, height } = APP_STORE_SIZES[shot.device];
      const html = appStoreScreenshotHtml({
        device: shot.device,
        headline: shot.headline,
        sub: shot.sub,
        popupPng: `data:image/png;base64,${popup.png.toString('base64')}`,
        popupWidth: popup.width,
        popupHeight: popup.height,
      });
      await write(shot.file, await renderHtml(browser, html, width, height));
    }
  }

  async function renderChrome(): Promise<void> {
    const popups = new Map<SceneName, { png: Buffer; width: number; height: number }>();
    for (const shot of SCREENSHOTS) {
      if (!popups.has(shot.scene)) {
        routes = await routesFor(SCENES[shot.scene], manifest.version, seedJs);
        popups.set(shot.scene, await capturePopup(browser, origin, SCENES[shot.scene]));
      }
      const popup = popups.get(shot.scene)!;
      const html = screenshotHtml({
        headline: shot.headline,
        sub: shot.sub,
        popupPng: `data:image/png;base64,${popup.png.toString('base64')}`,
        popupWidth: popup.width,
        popupHeight: popup.height,
      });
      await write(shot.file, await renderHtml(browser, html, 1280, 800));
    }
    await write('promo-small-440x280.png', await renderHtml(browser, promoTileHtml(), 440, 280));
    // The marquee carries the first screenshot's popup (the trusted-MCPs scene).
    const marqueePopup = popups.get(SCREENSHOTS[0]!.scene)!;
    await write(
      'promo-marquee-1400x560.png',
      await renderHtml(
        browser,
        marqueeTileHtml({
          popupPng: `data:image/png;base64,${marqueePopup.png.toString('base64')}`,
          popupWidth: marqueePopup.width,
          popupHeight: marqueePopup.height,
        }),
        1400,
        560,
      ),
    );
    for (const shot of POPUP_SHOTS) {
      routes = await routesFor(SCENES[shot.scene], manifest.version, seedJs);
      const popup = await capturePopup(browser, origin, SCENES[shot.scene], shot.scheme);
      await write(shot.file, stripAlpha(popup.png));
      if (popup.end) await write(shot.file.replace(/\.png$/, '-end.png'), stripAlpha(popup.end));
    }
  }
}

await main();
