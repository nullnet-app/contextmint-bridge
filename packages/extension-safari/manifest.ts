/**
 * The Safari manifest is GENERATED from `packages/extension-chrome/manifest.json`
 * — the file release-please bumps — so name, short name, version, description,
 * icons, popup, content scripts and host permissions can never drift between
 * the two browsers. `safariManifest` changes exactly what the macOS Safari 27
 * spike (chrischall/fetchproxy
 * `docs/superpowers/specs/2026-09-25-contextmint-bridge-chrome-safari-design.md`,
 * *Spike results — macOS*) required, and copies everything else through:
 * `tests/manifest-parity.test.ts` decides whether a pass-through is allowed.
 *
 * Pure: no I/O, and the input is never mutated.
 */

export interface ContentScript {
  matches: string[];
  js?: string[];
  css?: string[];
  run_at?: string;
  world?: 'ISOLATED' | 'MAIN';
  [key: string]: unknown;
}

interface IconSet {
  [size: string]: string;
}

interface ManifestCommon {
  manifest_version: number;
  name: string;
  short_name?: string;
  version: string;
  description?: string;
  icons?: IconSet;
  action?: { default_popup?: string; default_icon?: IconSet; [key: string]: unknown };
  content_scripts?: ContentScript[];
  permissions?: string[];
  host_permissions?: string[];
  [key: string]: unknown;
}

export interface ChromeManifest extends ManifestCommon {
  background?: { service_worker: string; type?: 'module' } | Record<string, unknown>;
  minimum_chrome_version?: string;
}

export interface SafariManifest extends ManifestCommon {
  background: { scripts: string[]; persistent: false };
}

/**
 * Safari 27 ran the background ONLY as a non-persistent event page; a
 * `service_worker` background — module or classic — never ran, not even a
 * hello-world. `background.js` is built as a classic (IIFE) script to match
 * (`build.ts`). nullnet-app/mcp-host-app's appex build refuses any other shape.
 */
const EVENT_PAGE = { scripts: ['background.js'], persistent: false } as const;

/** Absent in Safari 27 (spike): `chrome.downloads` and `chrome.tabGroups` do not exist. */
const ABSENT_IN_SAFARI = new Set(['downloads', 'tabGroups']);

/**
 * `browser.runtime.sendNativeMessage` exists only with `nativeMessaging`: the
 * extension asks ContextMint — the app that contains it — for the bridge
 * target the user set up there. Chrome needs no such permission, so it is
 * Safari-only; mcp-host-app's appex build refuses a manifest without it.
 */
const SAFARI_ONLY = ['nativeMessaging'];

export function safariManifest(chrome: ChromeManifest): SafariManifest {
  const out: Record<string, unknown> = {};
  // Walk Chrome's keys in order, so the generated file reads like Chrome's.
  for (const [key, value] of Object.entries(structuredClone(chrome))) {
    switch (key) {
      case 'minimum_chrome_version':
        break; // Chrome-only; Safari ignores it.
      case 'background':
        out[key] = { ...EVENT_PAGE, scripts: [...EVENT_PAGE.scripts] };
        break;
      case 'permissions': {
        const kept = (value as string[]).filter((p) => !ABSENT_IN_SAFARI.has(p));
        out[key] = [...kept, ...SAFARI_ONLY.filter((p) => !kept.includes(p))];
        break;
      }
      case 'content_scripts':
        out[key] = (value as ContentScript[]).map(withoutWorld);
        break;
      default:
        out[key] = value;
    }
  }
  if (!('background' in out))
    out['background'] = { ...EVENT_PAGE, scripts: [...EVENT_PAGE.scripts] };
  if (!('permissions' in out)) out['permissions'] = [...SAFARI_ONLY];
  return out as SafariManifest;
}

/**
 * Safari does not support the manifest `world` key. `ISOLATED` is the default
 * anyway, so it is dropped — but a manifest-declared `MAIN` script would be
 * silently demoted to the isolated world, so it is refused instead. MAIN-world
 * code is registered at runtime (extension-core `main-world-bridge.ts`), which
 * the spike showed Safari does run.
 */
function withoutWorld(cs: ContentScript): ContentScript {
  const { world, ...rest } = cs;
  if (world === 'MAIN') {
    throw new Error(
      'safariManifest: a manifest-declared world: "MAIN" content script cannot be expressed for Safari; register it at runtime instead',
    );
  }
  return rest;
}
