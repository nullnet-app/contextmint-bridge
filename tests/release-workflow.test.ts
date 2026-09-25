import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * Release guard. The bridge ships as a GitHub Release carrying the Chrome
 * extension zip and its SHA-256 — and nothing here is published to npm
 * (both workspaces are `private`). These tests pin the parts of
 * `.github/workflows/release-please.yml`, the release-please config, and the
 * `@next` protocol job in `ci.yml` that are easy to break silently.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  'working-directory'?: string;
}
interface Job {
  uses?: string;
  needs?: string | string[];
  if?: string;
  steps?: Step[];
  with?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
}
interface Workflow {
  on?: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const workflow = (file: string): Workflow =>
  parse(read(join('.github', 'workflows', file))) as Workflow;

const TAG_REF = '${{ needs.release-please.outputs.tag }}';
const ZIP = 'contextmint-bridge-chrome-${VERSION}.zip';

describe('release-please.yml', () => {
  const wf = workflow('release-please.yml');

  it('calls the fleet reusable release-please with NULLNET_RELEASE_PAT', () => {
    const rp = wf.jobs['release-please'];
    expect(rp?.uses).toBe(
      'chrischall/workflows/.github/workflows/reusable-release-please.yml@main',
    );
    expect(rp?.secrets?.release_pat).toBe('${{ secrets.NULLNET_RELEASE_PAT }}');
    expect(rp?.with?.republish_tag).toBe('${{ inputs.republish_tag }}');
  });

  /** The one job that builds and attaches the extension zip. */
  const zipJobs = Object.entries(wf.jobs).filter(([, job]) =>
    (job.steps ?? []).some((s) => (s.run ?? '').includes(ZIP)),
  );

  it('has exactly one job that builds the Chrome zip', () => {
    expect(zipJobs.map(([name]) => name)).toHaveLength(1);
  });

  const [, zipJob] = zipJobs[0] ?? ['', { steps: [] } as Job];
  const steps = zipJob.steps ?? [];
  const index = (pred: (s: Step) => boolean): number => steps.findIndex(pred);

  it('runs only when the reusable workflow reports a publish, and only from main', () => {
    const needs = [zipJob.needs].flat();
    expect(needs).toContain('release-please');
    expect(zipJob.if).toContain("needs.release-please.outputs.publish == 'true'");
    expect(zipJob.if).toContain("github.ref == 'refs/heads/main'");
  });

  it('checks out the release tag before building, so the zip is built from the tag', () => {
    const checkout = index((s) => (s.uses ?? '').startsWith('actions/checkout@'));
    const build = index(
      (s) => /build/.test(s.run ?? '') && (s.run ?? '').includes('extension-chrome'),
    );
    const zip = index((s) => (s.run ?? '').includes(`zip -r`));
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(steps[checkout]?.with?.ref).toBe(TAG_REF);
    // No other checkout in the job could swap the tree out from under the build.
    expect(steps.filter((s) => (s.uses ?? '').startsWith('actions/checkout@'))).toHaveLength(1);
    expect(build).toBeGreaterThan(checkout);
    expect(zip).toBeGreaterThan(build);
    expect(steps[zip]?.run).toContain(ZIP);
  });

  it('takes VERSION from the reusable workflow output, through env', () => {
    for (const s of steps.filter((s) => (s.run ?? '').includes('${VERSION}'))) {
      expect(s.env?.VERSION).toBe('${{ needs.release-please.outputs.version }}');
    }
  });

  it('refuses a zip whose manifest version disagrees with the tag', () => {
    const run = steps.map((s) => s.run ?? '').join('\n');
    expect(run).toMatch(/dist\/manifest\.json/);
    expect(run).toMatch(/exit 1/);
  });

  it('attaches the zip and its digest without ever overwriting a published asset', () => {
    const attach = steps.find((s) => (s.run ?? '').includes('gh release upload'));
    expect(attach).toBeDefined();
    const run = attach!.run!;
    expect(run).toContain(`ZIP="${ZIP}"`);
    expect(run).toContain('DIGEST="${ZIP}.sha256"');
    expect(run).toContain('sha256sum "$ZIP"');
    expect(run).not.toContain('--clobber');
    // An asset already there is left alone and the PUBLISHED zip is re-hashed.
    expect(run).toContain('gh release download "$RELEASE_TAG" --pattern "$ZIP"');
  });
});

describe('no workflow publishes to npm', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

  it.each(files)('%s never runs npm publish', (file) => {
    const wf = workflow(file);
    for (const [name, job] of Object.entries(wf.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        expect(step.run ?? '', `${file} → ${name}`).not.toMatch(/\bnpm\s+publish\b/);
        expect(step.uses ?? '', `${file} → ${name}`).not.toMatch(/npm-publish/);
      }
    }
  });
});

describe('release-please config', () => {
  const config = JSON.parse(read('release-please-config.json'));
  const manifest = JSON.parse(read('.release-please-manifest.json'));
  const pkg = config.packages?.['.'];

  it('is one root node package', () => {
    expect(Object.keys(config.packages)).toEqual(['.']);
    expect(pkg['release-type']).toBe('node');
  });

  it('bumps both workspace package.jsons and the Chrome manifest', () => {
    const extra = (pkg['extra-files'] as { type: string; path: string; jsonpath: string }[]).map(
      (f) => `${f.type}:${f.path}:${f.jsonpath}`,
    );
    expect(extra).toEqual(
      expect.arrayContaining([
        'json:packages/extension-chrome/package.json:$.version',
        'json:packages/extension-core/package.json:$.version',
        'json:packages/extension-chrome/manifest.json:$.version',
      ]),
    );
    for (const f of pkg['extra-files']) expect(existsSync(join(ROOT, f.path)), f.path).toBe(true);
  });

  it('keeps the workspace dependency version-free, so a release bump cannot strand it', () => {
    // release-please moves every workspace `version` but never an
    // inter-workspace range. The first release takes extension-core from
    // 3.2.2 to 1.0.0; a `^3.2.2` range would then no longer match the
    // workspace, and `npm ci` goes to the registry for a private package
    // that was never published (404). `*` always resolves to the workspace.
    const chrome = JSON.parse(read('packages/extension-chrome/package.json'));
    expect(chrome.dependencies['@fetchproxy/extension-core']).toBe('*');
  });

  it('tags plain vX.Y.Z', () => {
    expect(config['include-v-in-tag']).toBe(true);
    expect(config['include-component-in-tag']).toBe(false);
  });

  it('only forces release-as 1.0.0 until v1.0.0 has shipped', () => {
    const problem = releaseAsProblem({
      releaseAs: pkg['release-as'],
      manifestVersion: manifest['.'],
      changelog: existsSync(join(ROOT, 'CHANGELOG.md')) ? read('CHANGELOG.md') : '',
      headRef: process.env['GITHUB_HEAD_REF'] ?? '',
    });
    expect(problem).toBeNull();
  });
});

/**
 * Why `"release-as": "1.0.0"` must not be in the release-please config right
 * now, or null when it may be.
 *
 * It exists only to force the FIRST bridge release to 1.0.0 (a fresh product,
 * not fetchproxy 3.x). It cannot be caught by the manifest outgrowing 1.0.0:
 * while it is set, release-please pins every release to 1.0.0, so the
 * manifest never moves past it. What does change is CHANGELOG.md — v1.0.0's
 * release PR writes its first `## [1.0.0]` entry. That PR is the one place
 * the entry and `release-as` may coexist (release-please cannot drop the
 * config key itself); everywhere else — main right after it merges, and every
 * later PR — it means v1.0.0 has shipped and the key must go.
 */
function releaseAsProblem(input: {
  releaseAs: unknown;
  manifestVersion: string;
  changelog: string;
  headRef: string;
}): string | null {
  const { releaseAs, manifestVersion, changelog, headRef } = input;
  if (releaseAs === undefined) return null;
  if (releaseAs !== '1.0.0') return `release-as is ${String(releaseAs)}, expected 1.0.0 or absent`;
  if (manifestVersion !== '0.0.0' && manifestVersion !== '1.0.0') {
    return `release-as 1.0.0 survived a manifest of ${manifestVersion}`;
  }
  const shipped = /^##\s+\[?1\.0\.0\]?(?:\s|\(|$)/m.test(changelog);
  if (shipped && !headRef.startsWith('release-please--')) {
    return 'CHANGELOG.md has a 1.0.0 entry, so v1.0.0 shipped: delete release-as from release-please-config.json';
  }
  return null;
}

describe('releaseAsProblem', () => {
  const FIRST_ENTRY =
    '# Changelog\n\n## [1.0.0](https://github.com/nullnet-app/contextmint-bridge/compare/v0.0.0...v1.0.0) (2026-09-26)\n\n### Features\n';
  const base = { releaseAs: '1.0.0', manifestVersion: '0.0.0', changelog: '', headRef: '' };

  it('allows no release-as at all', () => {
    expect(releaseAsProblem({ ...base, releaseAs: undefined, changelog: FIRST_ENTRY })).toBeNull();
  });

  it('allows release-as 1.0.0 before the first release', () => {
    expect(releaseAsProblem(base)).toBeNull();
  });

  it('allows it on the v1.0.0 release PR itself', () => {
    expect(
      releaseAsProblem({
        ...base,
        manifestVersion: '1.0.0',
        changelog: FIRST_ENTRY,
        headRef: 'release-please--branches--main',
      }),
    ).toBeNull();
  });

  it('fails on main once the v1.0.0 release PR has merged', () => {
    expect(releaseAsProblem({ ...base, manifestVersion: '1.0.0', changelog: FIRST_ENTRY })).toMatch(
      /delete release-as/,
    );
  });

  it('fails on any other PR after v1.0.0 shipped', () => {
    expect(
      releaseAsProblem({
        ...base,
        manifestVersion: '1.0.0',
        changelog: FIRST_ENTRY,
        headRef: 'feat/something',
      }),
    ).toMatch(/delete release-as/);
  });

  it('recognises the unlinked heading release-please writes with no previous tag', () => {
    expect(
      releaseAsProblem({ ...base, manifestVersion: '1.0.0', changelog: '## 1.0.0 (2026-09-26)\n' }),
    ).toMatch(/delete release-as/);
  });

  it('does not mistake a later version for 1.0.0', () => {
    expect(
      releaseAsProblem({ ...base, changelog: '## [1.0.01](x) (2026-09-26)\n## 11.0.0\n' }),
    ).toBeNull();
  });

  it('fails on any pin other than 1.0.0, and on a manifest past 1.0.0', () => {
    expect(releaseAsProblem({ ...base, releaseAs: '2.0.0' })).toMatch(/expected 1\.0\.0/);
    expect(releaseAsProblem({ ...base, manifestVersion: '1.0.1' })).toMatch(/survived/);
  });
});

describe('ci.yml protocol@next job', () => {
  const wf = workflow('ci.yml');
  const jobs = Object.entries(wf.jobs).filter(([, job]) =>
    (job.steps ?? []).some((s) => (s.run ?? '').includes('@fetchproxy/protocol@')),
  );

  it('exists', () => {
    expect(jobs).toHaveLength(1);
  });

  const [, job] = jobs[0] ?? ['', { steps: [] } as Job];
  const run = (job.steps ?? []).map((s) => s.run ?? '').join('\n');

  it('installs the next dist-tag, falling back to latest with a log line', () => {
    expect(run).toContain('dist-tags.next');
    expect(run).toMatch(/latest/);
    expect(run).toMatch(/::notice::|::warning::/);
  });

  it('runs npm test after the install', () => {
    const steps = job.steps ?? [];
    const install = steps.findIndex((s) => (s.run ?? '').includes('@fetchproxy/protocol@'));
    const test = steps.findIndex((s) => /\bnpm test\b/.test(s.run ?? ''));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(test).toBeGreaterThan(install);
  });
});
