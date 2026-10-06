/**
 * Revive a tab that matched a request by URL but whose content script did
 * not answer ("Receiving end does not exist").
 *
 * The live repro (2026-10-06): quit Chrome, reopen it, and the restored
 * www.compass.com tab is there but nothing in it answers. Chrome restores
 * tabs unloaded (discarded) or without ever giving them the manifest content
 * script, so every bridged call failed with `content_script_unreachable`
 * until the person reloaded the tab by hand — the remedy the error names, and
 * one the extension can apply itself:
 *
 *   - An UNLOADED tab (`discarded`, or status `'unloaded'`) has no live page
 *     state to lose, so it is reloaded and waited on until `'complete'`; the
 *     manifest content script comes with the load.
 *   - A LIVE page is never reloaded — that could throw away the person's
 *     unsaved input. Its declared content scripts are injected instead,
 *     through the same helper the update-time re-injection uses
 *     (`reinject-content-scripts.ts`): same files, same `matches` guard, and
 *     `content.js` refuses a second live install (`content-once.ts`).
 *   - A tab still LOADING is left alone: its manifest script is on the way.
 *
 * Feature-detected throughout: where `tabs.reload` or `scripting.executeScript`
 * is missing (Safari has no `discarded` either), that path does nothing and
 * the caller keeps today's behaviour. Every wait is bounded by one deadline.
 */

import type { ChromeApi } from '../chrome-api.js';
import {
  canInjectContentScripts,
  declaredContentScripts,
  injectDeclaredScriptsIntoTab,
  type ExtraContentScripts,
} from '../reinject-content-scripts.js';

declare const chrome: ChromeApi;

/** A matched tab as `chrome.tabs.query` reported it. */
export interface ReviveCandidate {
  id: number;
  url?: string;
  status?: string;
  discarded?: boolean;
}

export interface ReviveTiming {
  /** The longest one request spends reviving, across every tab, in ms. */
  budgetMs: number;
  /** Gap between `tabs.get` polls while a reloaded tab loads, in ms. */
  pollMs: number;
}

const DEFAULT_TIMING: ReviveTiming = { budgetMs: 8_000, pollMs: 200 };
let timing: ReviveTiming = { ...DEFAULT_TIMING };

/**
 * Scripts registered at runtime (the MAIN-world bridge on approved hosts),
 * set by boot. Kept here rather than passed by every handler so the request
 * path stays a leaf; absent in tests and before boot, where only the manifest
 * scripts are injected.
 */
let extraScripts: ExtraContentScripts | undefined;

export function setReviveExtraContentScripts(provider: ExtraContentScripts | undefined): void {
  extraScripts = provider;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUnloaded(tab: ReviveCandidate): boolean {
  return tab.discarded === true || tab.status === 'unloaded';
}

/** Poll until the tab reports `'complete'` or the deadline passes. */
async function waitForComplete(tabId: number, deadline: number): Promise<boolean> {
  const get = chrome.tabs.get;
  if (typeof get !== 'function') return false;
  for (;;) {
    try {
      const t = await chrome.tabs.get!(tabId);
      if (t?.status === 'complete') return true;
    } catch {
      return false; // the tab is gone
    }
    if (Date.now() >= deadline) return false;
    await delay(Math.min(timing.pollMs, Math.max(0, deadline - Date.now())));
  }
}

async function reviveOne(tab: ReviveCandidate, deadline: number): Promise<boolean> {
  if (isUnloaded(tab)) {
    if (typeof chrome.tabs.reload !== 'function') return false;
    try {
      await chrome.tabs.reload!(tab.id);
    } catch {
      return false;
    }
    if (!(await waitForComplete(tab.id, deadline))) return false;
    // `'complete'` and the manifest's `document_idle` injection land at about
    // the same moment; one poll's grace keeps the retry from beating it.
    await delay(Math.min(timing.pollMs, Math.max(0, deadline - Date.now())));
    return true;
  }
  if (tab.status === 'loading') return false;
  if (!canInjectContentScripts()) return false;
  const declared = await declaredContentScripts(extraScripts);
  return (await injectDeclaredScriptsIntoTab(tab, declared)) === 'landed';
}

/**
 * Revive each candidate once, in order, inside one bounded budget. Returns
 * the ids worth one retry. Never throws.
 */
export async function reviveTabs(tabs: readonly ReviveCandidate[]): Promise<Set<number>> {
  const revived = new Set<number>();
  // Nothing this browser can do: skip without spending any of the budget.
  if (typeof chrome?.tabs?.reload !== 'function' && !canInjectContentScripts()) return revived;
  const deadline = Date.now() + timing.budgetMs;
  for (const tab of tabs) {
    if (Date.now() >= deadline) break;
    try {
      if (await reviveOne(tab, deadline)) revived.add(tab.id);
    } catch {
      // Best-effort: a revive that throws is simply a revive that failed.
    }
  }
  return revived;
}

export function __setReviveTimingForTests(next: Partial<ReviveTiming>): void {
  timing = { ...timing, ...next };
}

export function __resetReviveForTests(): void {
  timing = { ...DEFAULT_TIMING };
  extraScripts = undefined;
}
