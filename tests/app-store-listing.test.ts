import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The App Store listing for ContextMint Bridge (plan
 * docs/superpowers/plans/2026-10-05-safari-extension-standalone.md, Task 6)
 * is typed into App Store Connect by hand from docs/store-assets/app-store/.
 * App Store Connect enforces its limits only at the moment of pasting, and App
 * Review rejects a Safari listing that names another browser or platform
 * (Guideline 2.3.10), so both are held here.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'docs/store-assets/app-store');
const read = (file: string): string => readFileSync(join(DIR, file), 'utf8');

/** The fenced block under `## <heading>` in a listing file: what gets pasted. */
function field(md: string, heading: string): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  expect(start, `## ${heading}`).toBeGreaterThanOrEqual(0);
  const open = lines.findIndex((l, i) => i > start && l.startsWith('```'));
  const close = lines.findIndex((l, i) => i > open && l.startsWith('```'));
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  expect(next < 0 || open < next, `## ${heading} has a fenced block`).toBe(true);
  return lines.slice(open + 1, close).join('\n').trim();
}

const THIRD_PARTY_PRODUCTS = /claude|cursor|windsurf|chatgpt|openai|anthropic|copilot|gemini/i;

const OTHER_PLATFORMS = /chrome|chromium|android|google|firefox|\bedge\b|windows|linux/i;

describe('docs/store-assets/app-store/listing.md', () => {
  const md = read('listing.md');

  it('names the app as App Store Connect registered it (O2)', () => {
    expect(field(md, 'Name')).toBe('ContextMint Bridge');
  });

  it('keeps every field inside its App Store Connect limit', () => {
    expect([...field(md, 'Subtitle')].length).toBeLessThanOrEqual(30);
    expect([...field(md, 'Promotional text')].length).toBeLessThanOrEqual(170);
    expect([...field(md, 'Description')].length).toBeLessThanOrEqual(4000);
    // Keywords: 100 bytes, comma-separated, no spaces around the commas.
    const keywords = field(md, 'Keywords');
    expect(Buffer.byteLength(keywords, 'utf8')).toBeLessThanOrEqual(100);
    expect(keywords).not.toMatch(/\s,|,\s/);
    // The name is indexed already; repeating it in keywords wastes bytes.
    expect(keywords.toLowerCase().split(',')).not.toContain('contextmint');
  });

  it('keeps third-party trademarks and other apps\' names out of the keywords (Guideline 2.3.7)', () => {
    const keywords = field(md, 'Keywords');
    expect(keywords).not.toMatch(THIRD_PARTY_PRODUCTS);
  });

  it('does not claim to collect nothing, which the App Privacy label may contradict (app-privacy.md)', () => {
    expect(field(md, 'Description')).not.toMatch(/collects nothing/i);
  });

  it('never names another browser or platform', () => {
    for (const h of ['Subtitle', 'Promotional text', 'Description', 'Keywords']) {
      expect(field(md, h), h).not.toMatch(OTHER_PLATFORMS);
    }
  });

  it('says plainly what iOS cannot do (plan Q5)', () => {
    const d = field(md, 'Description');
    expect(d).toMatch(/iPhone and iPad/);
    expect(d).toMatch(/while Safari is (open|in front|on screen)/i);
  });

  it('gives the privacy policy and support URLs as https', () => {
    expect(field(md, 'Privacy Policy URL')).toMatch(/^https:\/\/\S+PRIVACY\.md$/);
    expect(field(md, 'Support URL')).toMatch(/^https:\/\/\S+$/);
  });
});

describe('docs/store-assets/app-store/review-notes.md', () => {
  const md = read('review-notes.md');

  it('fits App Review Information → Notes (4000 characters)', () => {
    expect([...field(md, 'Notes')].length).toBeLessThanOrEqual(4000);
  });

  it('gives App Review a way to see it work, the Connect video, and why the app is minimal', () => {
    const notes = field(md, 'Notes');
    expect(notes).toMatch(/fpx/);
    expect(notes).toMatch(/example\.com/);
    expect(notes).toMatch(/4\.2/);
    // All-sites access and the per-MCP consent (plan Q4).
    expect(notes).toMatch(/all websites|every website/i);
    expect(notes).toMatch(/pair code/i);
  });

  it('needs no sign-in: Connect is shown by an attached video, not a demo account', () => {
    expect(md).toMatch(/\*\*Sign-in required: no\*\*/);
    const notes = field(md, 'Notes');
    expect(notes).toContain('ContextMint-Bridge-Connect.mov');
    expect(notes).toMatch(/invite-only/i);
    expect(notes).not.toMatch(/Sign-In Information/i);
    expect(notes).not.toMatch(/demo account/i);
  });

  it('gives the owner a shot list for the Connect video', () => {
    expect(md).toMatch(/^## Demo video shot list/m);
    expect(md).toContain('~/Movies/ContextMint-Bridge-Connect.mov');
    expect(md).toMatch(/Cmd-Shift-5/);
  });

  it('never carries a password', () => {
    expect(md).not.toMatch(/password\s*[:=]\s*\S/i);
  });
});

describe('docs/store-assets/app-store/app-privacy.md (owner step O5)', () => {
  const md = read('app-privacy.md');

  it('answers App Privacy, age rating and export compliance', () => {
    expect(md).toMatch(/^## App Privacy/m);
    expect(md).toMatch(/^## Age rating/m);
    expect(md).toMatch(/^## Export compliance/m);
    expect(md).toMatch(/4\+/);
  });

  it('agrees with the Info.plist export answer', () => {
    const project = readFileSync(join(ROOT, 'apple/project.yml'), 'utf8');
    expect(project).toMatch(/ITSAppUsesNonExemptEncryption: false/);
    expect(md).toMatch(/ITSAppUsesNonExemptEncryption.*false/);
  });

  it('accounts for what Connect sends the gateway, per PRIVACY.md §4', () => {
    expect(md).toMatch(/mcp\.nullnet\.app/);
    expect(md).toMatch(/public identity key/i);
    expect(md).toMatch(/browser name/i);
  });
});

describe('docs/store-assets/app-store/README.md', () => {
  it('maps every file to its App Store Connect field and says how to regenerate the shots', () => {
    const md = read('README.md');
    for (const f of ['listing.md', 'review-notes.md', 'app-privacy.md']) {
      expect(md).toContain(`(${f})`);
      expect(existsSync(join(DIR, f))).toBe(true);
    }
    expect(md).toContain('npm run store-assets --workspace=@fetchproxy/extension-chrome');
    expect(md).toMatch(/1320x2868/);
    expect(md).toMatch(/2064x2752/);
  });
});
