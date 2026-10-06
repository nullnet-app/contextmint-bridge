import { describe, it, expect } from 'vitest';
import { claimContentScriptRun } from '../src/content-once.js';

// `content.js` can now be injected into a tab on demand (reviving a restored
// tab, `lib/revive-tab.ts`) as well as after an update. A second run in a page
// whose first copy is still alive would register a second onMessage listener,
// and one request would then be served twice — a POST sent twice. The guard
// lets a run proceed only when no LIVE copy is already installed; an orphaned
// copy (the extension updated, `chrome.runtime.id` gone) does not count.

describe('claimContentScriptRun', () => {
  it('lets the first run install, and refuses a second while the first is alive', () => {
    const g: Record<string, unknown> = { chrome: { runtime: { id: 'abc' } } };
    expect(claimContentScriptRun(g)).toBe(true);
    expect(claimContentScriptRun(g)).toBe(false);
  });

  it('lets a run install over an orphaned copy whose extension context is gone', () => {
    const runtime: { id?: string } = { id: 'abc' };
    const g: Record<string, unknown> = { chrome: { runtime } };
    expect(claimContentScriptRun(g)).toBe(true);
    delete runtime.id; // what an invalidated context reports
    expect(claimContentScriptRun(g)).toBe(true);
  });

  it('lets a run install when the chrome object itself was replaced', () => {
    const g: Record<string, unknown> = { chrome: { runtime: { id: 'abc' } } };
    expect(claimContentScriptRun(g)).toBe(true);
    g.chrome = { runtime: { id: 'abc' } };
    expect(claimContentScriptRun(g)).toBe(true);
  });

  it('never blocks where no extension id is visible (test fakes, odd contexts)', () => {
    const g: Record<string, unknown> = { chrome: { runtime: {} } };
    expect(claimContentScriptRun(g)).toBe(true);
    expect(claimContentScriptRun(g)).toBe(true);
  });
});
