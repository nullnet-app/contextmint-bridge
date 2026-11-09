import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WHATS_NEW_MAX,
  reviewPlan,
  submitSetting,
  whatsNewFromChangelog,
} from '../apple/tools/app-review';

/**
 * `apple/tools/app-review.ts`: what the deploy's "Submit for App Review" step
 * does with the platform's App Store versions once this run's build is on
 * TestFlight. It decides; the workflow runs asc. The rules that matter are the
 * non-destructive ones: a version already with Apple is never resubmitted,
 * another version in review is never cancelled, and nothing is released.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'apple', 'tools', 'app-review.ts');

const version = (
  id: string,
  versionString: string,
  state: string,
  opts: { platform?: string; createdDate?: string; legacyOnly?: boolean } = {},
): object => ({
  id,
  type: 'appStoreVersions',
  attributes: {
    versionString,
    platform: opts.platform ?? 'MAC_OS',
    createdDate: opts.createdDate ?? '2026-10-05T09:21:24-07:00',
    releaseType: 'MANUAL',
    ...(opts.legacyOnly
      ? { appStoreState: state }
      : { appVersionState: state, appStoreState: state }),
  },
});
const doc = (...rows: object[]): object => ({ data: rows });
const base = {
  ascPlatform: 'MAC_OS' as const,
  version: '1.9.0',
  appId: '6819349214',
  buildId: 'B1',
};

describe('submitSetting (APP_REVIEW_SUBMIT)', () => {
  it.each(['', undefined, 'true', 'TRUE', ' true '])('submits when the variable is %j', (raw) => {
    expect(submitSetting(raw).enabled).toBe(true);
  });

  it('is turned off by false, with a notice naming the variable', () => {
    const s = submitSetting('false');
    expect(s.enabled).toBe(false);
    expect(s.level).toBe('notice');
    expect(s.message).toMatch(/APP_REVIEW_SUBMIT/);
  });

  it('fails closed on anything else: no submission, and a warning naming the value', () => {
    const s = submitSetting('yes please');
    expect(s.enabled).toBe(false);
    expect(s.level).toBe('warning');
    expect(s.message).toContain('"yes please"');
  });
});

describe('reviewPlan', () => {
  it.each(['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE'])(
    'skips with a notice when this version is already %s (a re-run is a no-op)',
    (state) => {
      const plan = reviewPlan({ ...base, versions: doc(version('v19', '1.9.0', state)) });
      expect(plan).toMatchObject({ action: 'skip', level: 'notice' });
      expect(plan.message).toContain(state);
      expect(plan.message).toContain('1.9.0');
    },
  );

  it('skips with a notice when this version is already live', () => {
    const plan = reviewPlan({
      ...base,
      versions: doc(version('v19', '1.9.0', 'READY_FOR_DISTRIBUTION')),
    });
    expect(plan).toMatchObject({ action: 'skip', level: 'notice' });
  });

  it.each(['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE'])(
    'never cancels an older version that is %s: warns, names it and the remedy',
    (state) => {
      const plan = reviewPlan({
        ...base,
        versions: doc(
          version('v18', '1.8.0', state),
          version('v17', '1.7.4', 'READY_FOR_DISTRIBUTION'),
        ),
      });
      expect(plan).toMatchObject({ action: 'skip', level: 'warning' });
      expect(plan.message).toContain(`1.8.0 is ${state}`);
      expect(plan.message).toMatch(/one submission/i);
      expect(plan.message).toContain('asc review submit');
      expect(plan.message).toContain('--build-id B1');
      expect(plan.message).toMatch(/never cancels/);
    },
  );

  it('blocks on a version in another state it does not know, rather than guessing', () => {
    const plan = reviewPlan({ ...base, versions: doc(version('v18', '1.8.0', 'SOMETHING_NEW')) });
    expect(plan).toMatchObject({ action: 'skip', level: 'warning' });
    expect(plan.message).toContain('SOMETHING_NEW');
  });

  it('submits an editable version that already carries this version string', () => {
    const plan = reviewPlan({
      ...base,
      versions: doc(
        version('v19', '1.9.0', 'PREPARE_FOR_SUBMISSION'),
        version('v18', '1.8.0', 'READY_FOR_DISTRIBUTION'),
      ),
    });
    expect(plan).toMatchObject({
      action: 'submit',
      versionId: 'v19',
      rename: false,
      create: false,
      releasedBefore: true,
    });
  });

  it.each([
    'PREPARE_FOR_SUBMISSION',
    'DEVELOPER_REJECTED',
    'REJECTED',
    'METADATA_REJECTED',
    'INVALID_BINARY',
    'READY_FOR_REVIEW',
  ])('renames the one editable (%s) version to this release', (state) => {
    const plan = reviewPlan({
      ...base,
      versions: doc(
        version('v18', '1.8.0', state),
        version('v17', '1.7.4', 'READY_FOR_DISTRIBUTION'),
      ),
    });
    expect(plan).toMatchObject({ action: 'submit', versionId: 'v18', rename: true, create: false });
    expect(plan.message).toContain('1.8.0');
  });

  it('creates the version when none is editable, copying the live version’s metadata', () => {
    const plan = reviewPlan({
      ...base,
      versions: doc(
        version('v18', '1.8.0', 'READY_FOR_DISTRIBUTION', { createdDate: '2026-11-01T00:00:00Z' }),
        version('v17', '1.7.4', 'REPLACED_WITH_NEW_VERSION', {
          createdDate: '2026-10-01T00:00:00Z',
        }),
      ),
    });
    expect(plan).toMatchObject({
      action: 'submit',
      create: true,
      rename: false,
      copyFrom: '1.8.0',
      releasedBefore: true,
    });
    expect(plan).not.toHaveProperty('versionId');
  });

  it('reads the legacy appStoreState when appVersionState is absent', () => {
    const plan = reviewPlan({
      ...base,
      versions: doc(version('v18', '1.8.0', 'READY_FOR_SALE', { legacyOnly: true })),
    });
    expect(plan).toMatchObject({ action: 'submit', create: true, copyFrom: '1.8.0' });
  });

  it('says a never-released app has no previous release (so no What’s New)', () => {
    const plan = reviewPlan({
      ...base,
      versions: doc(version('v19', '1.9.0', 'PREPARE_FOR_SUBMISSION')),
    });
    expect(plan).toMatchObject({ action: 'submit', releasedBefore: false });
  });

  it('only looks at this platform', () => {
    const plan = reviewPlan({
      ...base,
      versions: doc(
        version('ios18', '1.8.0', 'WAITING_FOR_REVIEW', { platform: 'IOS' }),
        version('v19', '1.9.0', 'PREPARE_FOR_SUBMISSION'),
      ),
    });
    expect(plan).toMatchObject({ action: 'submit', versionId: 'v19' });
  });

  it('refuses an asc answer it cannot read', () => {
    expect(() => reviewPlan({ ...base, versions: null })).toThrow(/versions/);
    expect(() => reviewPlan({ ...base, versions: { data: 'nope' } })).toThrow(/versions/);
  });

  it('refuses a release version that is not X.Y.Z', () => {
    expect(() => reviewPlan({ ...base, version: '1.9', versions: doc() })).toThrow(/1\.9/);
  });
});

describe('whatsNewFromChangelog', () => {
  const CHANGELOG = `# Changelog

## [1.9.0](https://github.com/nullnet-app/contextmint-bridge/compare/v1.8.0...v1.9.0) (2026-11-20)


### Features

* **extension-core:** open the popup on a pending pair ([#130](https://github.com/nullnet-app/contextmint-bridge/issues/130)) ([abc1234](https://github.com/nullnet-app/contextmint-bridge/commit/abc1234))


### Bug Fixes

* **deps:** bump @fetchproxy/protocol ([#131](https://github.com/nullnet-app/contextmint-bridge/issues/131)) ([def5678](https://github.com/nullnet-app/contextmint-bridge/commit/def5678))
* keep [the badge](https://example.com) clear

## [1.8.0](https://github.com/nullnet-app/contextmint-bridge/compare/v1.7.4...v1.8.0) (2026-11-07)


### Features

* **extension-core:** serve binary fetch from the background
`;

  it('renders exactly the release’s section as plain text, links and commit refs removed', () => {
    expect(whatsNewFromChangelog(CHANGELOG, '1.9.0')).toBe(
      'Features\n' +
        '- extension-core: open the popup on a pending pair\n' +
        '\n' +
        'Bug Fixes\n' +
        '- deps: bump @fetchproxy/protocol\n' +
        '- keep the badge clear',
    );
  });

  it('stops at the next release heading', () => {
    expect(whatsNewFromChangelog(CHANGELOG, '1.8.0')).toBe(
      'Features\n- extension-core: serve binary fetch from the background',
    );
  });

  it('reads the unlinked heading release-please writes with no previous tag', () => {
    expect(
      whatsNewFromChangelog('## 1.0.0 (2026-09-26)\n\n### Features\n\n* first\n', '1.0.0'),
    ).toBe('Features\n- first');
  });

  it('is empty, never invented, when the release has no section', () => {
    expect(whatsNewFromChangelog(CHANGELOG, '2.0.0')).toBe('');
    expect(whatsNewFromChangelog(CHANGELOG, '1.9')).toBe('');
  });

  it('cuts an over-long section on a line boundary, within App Store Connect’s limit', () => {
    const long = `## 3.0.0 (2026-12-01)\n\n### Features\n\n${Array.from({ length: 400 }, (_, i) => `* change number ${i} with some words`).join('\n')}\n`;
    const text = whatsNewFromChangelog(long, '3.0.0');
    expect(text.length).toBeLessThanOrEqual(WHATS_NEW_MAX);
    expect(text.endsWith('with some words')).toBe(true);
  });
});

describe('app-review.ts CLI', () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const withDir = (fn: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'app-review-'));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('plan: writes the decision to $GITHUB_OUTPUT', () => {
    withDir((dir) => {
      writeFileSync(
        join(dir, 'versions.json'),
        JSON.stringify(doc(version('v18', '1.8.0', 'PREPARE_FOR_SUBMISSION'))),
      );
      const out = join(dir, 'out');
      writeFileSync(out, '');
      const r = run([
        'plan',
        '--asc-platform=MAC_OS',
        '--version=1.9.0',
        '--app=6819349214',
        '--build-id=B1',
        `--versions=${join(dir, 'versions.json')}`,
        `--github-output=${out}`,
      ]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe(
        'action=submit\nversion_id=v18\nrename=true\ncreate=false\ncopy_from=\nreleased_before=false\n',
      );
    });
  });

  it('plan: a skip is a ::notice:: / ::warning:: and exits 0', () => {
    withDir((dir) => {
      writeFileSync(
        join(dir, 'versions.json'),
        JSON.stringify(doc(version('v18', '1.8.0', 'IN_REVIEW'))),
      );
      const out = join(dir, 'out');
      writeFileSync(out, '');
      const r = run([
        'plan',
        '--asc-platform=MAC_OS',
        '--version=1.9.0',
        '--app=6819349214',
        '--build-id=B1',
        `--versions=${join(dir, 'versions.json')}`,
        `--github-output=${out}`,
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^::warning::macOS 1\.9\.0 was not submitted/m);
      expect(readFileSync(out, 'utf8')).toBe('action=skip\n');
    });
  });

  it.each([
    { submit: '', enabled: 'true', annotation: null },
    { submit: 'false', enabled: 'false', annotation: /^::notice::iOS: .*APP_REVIEW_SUBMIT=false/m },
    { submit: 'maybe', enabled: 'false', annotation: /^::warning::iOS: .*"maybe"/m },
  ])(
    'enabled: APP_REVIEW_SUBMIT=$submit gives enabled=$enabled',
    ({ submit, enabled, annotation }) => {
      withDir((dir) => {
        const out = join(dir, 'out');
        writeFileSync(out, '');
        const r = run([
          'enabled',
          '--asc-platform=IOS',
          `--submit=${submit}`,
          `--github-output=${out}`,
        ]);
        expect(r.status, r.stderr).toBe(0);
        expect(readFileSync(out, 'utf8')).toBe(`enabled=${enabled}\n`);
        if (annotation) expect(r.stdout).toMatch(annotation);
        else expect(r.stdout).not.toMatch(/^::/m);
      });
    },
  );

  it('plan: an unreadable asc answer is an ::error:: and exit 1', () => {
    withDir((dir) => {
      const r = run([
        'plan',
        '--asc-platform=IOS',
        '--version=1.9.0',
        `--versions=${join(dir, 'missing.json')}`,
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/^::error::/m);
    });
  });

  it('whats-new: writes the text, or a notice and an empty file when there is none', () => {
    withDir((dir) => {
      writeFileSync(
        join(dir, 'CHANGELOG.md'),
        '## 1.9.0 (2026-11-20)\n\n### Features\n\n* a thing\n',
      );
      const out = join(dir, 'whats-new.txt');
      let r = run([
        'whats-new',
        '--version=1.9.0',
        `--changelog=${join(dir, 'CHANGELOG.md')}`,
        `--out=${out}`,
      ]);
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe('Features\n- a thing');
      r = run([
        'whats-new',
        '--version=2.0.0',
        `--changelog=${join(dir, 'CHANGELOG.md')}`,
        `--out=${out}`,
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^::notice::.*2\.0\.0/m);
      expect(readFileSync(out, 'utf8')).toBe('');
    });
  });
});
