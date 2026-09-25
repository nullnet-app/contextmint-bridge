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

  it('only forces release-as 1.0.0 around the first release', () => {
    // The first bridge release is 1.0.0 (a fresh product, not fetchproxy 3.x).
    // `release-as` may survive into the release PR itself (which moves the
    // manifest to 1.0.0), but once the manifest is past 1.0.0 it must be gone
    // — it was meant to be deleted right after v1.0.0 shipped.
    if (pkg['release-as'] !== undefined) {
      expect(pkg['release-as']).toBe('1.0.0');
      expect(['0.0.0', '1.0.0']).toContain(manifest['.']);
    }
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
