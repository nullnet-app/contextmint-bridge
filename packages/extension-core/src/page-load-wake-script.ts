/**
 * The page-load wake script (`page-load-wake.js`): registered at runtime on
 * approved hosts only, isolated world, `document_idle`, top frame. See
 * `page-load-wake.ts`.
 */

import { sendPageLoadWake } from './page-load-wake.js';
import type { ChromeApi } from './chrome-api.js';

declare const chrome: ChromeApi;

if (
  typeof window !== 'undefined' &&
  typeof chrome !== 'undefined' &&
  typeof chrome.runtime?.sendMessage === 'function'
) {
  sendPageLoadWake(window, (message) => chrome.runtime.sendMessage?.(message));
}
