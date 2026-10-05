import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * Release guard. The bridge ships as a GitHub Release carrying the Chrome
 * and Safari extension zips and their SHA-256s — and nothing here is
 * published to npm (every workspace is `private`). These tests pin the parts of
 * `.github/workflows/release-please.yml`, the release-please config, and the
 * `@next` protocol job in `ci.yml` that are easy to break silently.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

interface Step {
  id?: string;
  name?: string;
  if?: string;
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
const VERSION_REF = '${{ needs.release-please.outputs.version }}';

/**
 * The two browser targets a release attaches, and the names the world
 * depends on. The Safari zip's name is a contract: nullnet-app/mcp-host-app
 * (plan 2026-09-25-contextmint-mac-v0, Task 6) downloads exactly
 * `releases/download/v${VERSION}/contextmint-bridge-safari-${VERSION}.zip`.
 */
const TARGETS = [
  { target: 'chrome', label: 'Chrome' },
  { target: 'safari', label: 'Safari' },
] as const;
const zipName = (target: string): string => `contextmint-bridge-${target}-\${VERSION}.zip`;

/** Runs a step's script the way Actions' default `bash` shell does. */
function runStep(
  script: string,
  opts: { cwd: string; env: Record<string, string>; bin?: string },
): SpawnSyncReturns<string> {
  const file = join(opts.cwd, '.step.sh');
  writeFileSync(file, script);
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
    cwd: opts.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...opts.env,
      PATH: opts.bin ? `${opts.bin}:${process.env['PATH']}` : (process.env['PATH'] ?? ''),
    },
  });
}

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

  /** Jobs with a step that names a target's zip. */
  const zipJobsFor = (target: string): string[] =>
    Object.entries(wf.jobs)
      .filter(([, job]) => (job.steps ?? []).some((s) => (s.run ?? '').includes(zipName(target))))
      .map(([name]) => name);

  it.each(TARGETS)('has exactly one job that builds the $label zip', ({ target }) => {
    expect(zipJobsFor(target)).toHaveLength(1);
  });

  it('builds both zips in the same job: one checkout of the tag, one npm ci', () => {
    expect(zipJobsFor('safari')).toEqual(zipJobsFor('chrome'));
  });

  const zipJob = wf.jobs[zipJobsFor('chrome')[0] ?? ''] ?? ({ steps: [] } as Job);
  const steps = zipJob.steps ?? [];
  const index = (pred: (s: Step) => boolean): number => steps.findIndex(pred);
  const named = (name: string): number => index((s) => s.name === name);
  const checkout = index((s) => (s.uses ?? '').startsWith('actions/checkout@'));
  const detect = index((s) => (s.run ?? '').includes('test -f packages/extension-safari/package.json'));
  const attach = index((s) => (s.run ?? '').includes('gh release upload'));
  const detectId = steps[detect]?.id ?? '<no id>';
  const SAFARI_PRESENT = `steps.${detectId}.outputs.present == 'true'`;

  it('runs only when the reusable workflow reports a publish, and only from main', () => {
    const needs = [zipJob.needs].flat();
    expect(needs).toContain('release-please');
    expect(zipJob.if).toContain("needs.release-please.outputs.publish == 'true'");
    expect(zipJob.if).toContain("github.ref == 'refs/heads/main'");
  });

  it('checks out the release tag, once, before anything is built', () => {
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(steps[checkout]?.with?.ref).toBe(TAG_REF);
    // No other checkout in the job could swap the tree out from under a build.
    expect(steps.filter((s) => (s.uses ?? '').startsWith('actions/checkout@'))).toHaveLength(1);
  });

  it.each(TARGETS)(
    'builds the $label workspace from the tag and packages it after the build',
    ({ target, label }) => {
      const build = named(`Build ${label} extension`);
      const pack = named(`Package ${label} extension`);
      expect(build).toBeGreaterThan(checkout);
      expect(steps[build]?.run?.trim()).toBe(
        `npm run build --workspace=@fetchproxy/extension-${target}`,
      );
      expect(pack).toBeGreaterThan(build);
      const run = steps[pack]?.run ?? '';
      expect(run).toContain(`packages/extension-${target}/dist/manifest.json`);
      expect(run).toContain(`cd packages/extension-${target}/dist`);
      expect(run.indexOf(`cd packages/extension-${target}/dist`)).toBeLessThan(
        run.indexOf('zip -r'),
      );
      expect(run).toContain(`zip -r "../../../${zipName(target)}" .`);
    },
  );

  it('builds and packages BOTH targets before anything is attached', () => {
    // A Safari build or version-check failure must upload nothing at all.
    expect(attach).toBeGreaterThanOrEqual(0);
    for (const { label } of TARGETS) {
      expect(named(`Package ${label} extension`), label).toBeLessThan(attach);
    }
  });

  it('takes VERSION from the reusable workflow output, through env', () => {
    for (const s of steps.filter((s) => (s.run ?? '').includes('${VERSION}'))) {
      expect(s.env?.VERSION, s.name).toBe(VERSION_REF);
    }
  });

  it('skips Safari only when the tag predates packages/extension-safari', () => {
    // v1.0.0 has no Safari package; a republish of it must still attach Chrome.
    expect(detect).toBeGreaterThan(checkout);
    expect(detect).toBeLessThan(named('Build Safari extension'));
    expect(steps[detect]?.id).toBeTruthy();
    for (const label of ['Build Safari extension', 'Package Safari extension']) {
      expect(steps[named(label)]?.if, label).toBe(SAFARI_PRESENT);
    }
    // Chrome is never conditional, and nothing else is skippable.
    for (const s of steps) {
      if (s.if !== undefined) expect([SAFARI_PRESENT], s.name).toContain(s.if);
    }
    expect(steps[attach]?.if).toBeUndefined();
    expect(steps[attach]?.env?.SAFARI).toBe(`\${{ steps.${detectId}.outputs.present }}`);
  });

  it('never overwrites a published asset', () => {
    expect(steps[attach]?.run).not.toContain('--clobber');
  });

  describe('Safari package detection (executed)', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cmb-detect-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const detectIn = (withPackage: boolean): { out: string; stdout: string; status: number | null } => {
      if (withPackage) {
        mkdirSync(join(dir, 'packages/extension-safari'), { recursive: true });
        writeFileSync(join(dir, 'packages/extension-safari/package.json'), '{}');
      }
      const out = join(dir, 'github_output');
      writeFileSync(out, '');
      const r = runStep(steps[detect]?.run ?? 'exit 99', {
        cwd: dir,
        env: { GITHUB_OUTPUT: out, RELEASE_TAG: 'v1.0.0', ...(steps[detect]?.env as object) },
      });
      return { out: readFileSync(out, 'utf8'), stdout: r.stdout, status: r.status };
    };

    it('reports present=true when the tag has the package', () => {
      const r = detectIn(true);
      expect(r.status).toBe(0);
      expect(r.out).toBe('present=true\n');
    });

    it('reports present=false with a ::notice:: when the tag predates it', () => {
      const r = detectIn(false);
      expect(r.status).toBe(0);
      expect(r.out).toBe('present=false\n');
      expect(r.stdout).toMatch(/^::notice::.*extension-safari/m);
    });
  });

  describe.each(TARGETS)('Package $label extension (executed)', ({ target, label }) => {
    let dir: string;
    const dist = (): string => join(dir, `packages/extension-${target}/dist`);
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), `cmb-pack-${target}-`));
      mkdirSync(join(dist(), 'icons'), { recursive: true });
      writeFileSync(join(dist(), 'background.js'), '// bundle\n');
      writeFileSync(join(dist(), 'icons/16.png'), 'png');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const pack = (manifestVersion: string): SpawnSyncReturns<string> => {
      writeFileSync(join(dist(), 'manifest.json'), JSON.stringify({ version: manifestVersion }));
      return runStep(steps[named(`Package ${label} extension`)]?.run ?? 'exit 99', {
        cwd: dir,
        env: { VERSION: '1.2.3' },
      });
    };

    it(`zips dist/ with manifest.json at the zip root, as contextmint-bridge-${target}-1.2.3.zip`, () => {
      const r = pack('1.2.3');
      expect(r.status, r.stderr).toBe(0);
      const zip = join(dir, `contextmint-bridge-${target}-1.2.3.zip`);
      expect(existsSync(zip)).toBe(true);
      const entries = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' })
        .stdout.split('\n')
        .filter(Boolean);
      expect(entries).toContain('manifest.json');
      expect(entries).toContain('background.js');
      expect(entries).toContain('icons/16.png');
      expect(entries.some((e) => e.includes('dist/'))).toBe(false);
    });

    it('refuses to zip a manifest whose version disagrees with the release', () => {
      const r = pack('1.2.2');
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('refusing to zip');
      expect(existsSync(join(dir, `contextmint-bridge-${target}-1.2.3.zip`))).toBe(false);
    });
  });

  describe('Attach artifacts to release (executed against a fake gh)', () => {
    let dir: string;
    let bin: string;
    const log = (): string[] =>
      existsSync(join(dir, 'gh.log'))
        ? readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter(Boolean)
        : [];
    const uploaded = (name: string): string => readFileSync(join(dir, 'uploaded', name), 'utf8');
    const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cmb-attach-'));
      bin = join(dir, 'bin');
      mkdirSync(bin);
      mkdirSync(join(dir, 'uploaded'));
      mkdirSync(join(dir, 'work'));
      // A GitHub Release in miniature: `assets` lists what it serves,
      // `published/` holds those bytes, `uploaded/` what this run sent.
      writeFileSync(
        join(bin, 'gh'),
        `#!/usr/bin/env bash
set -euo pipefail
R=${JSON.stringify(dir)}
echo "$*" >> "$R/gh.log"
case "$1 $2" in
  "release view") cat "$R/assets" ;;
  "release upload") cp "$4" "$R/uploaded/"; basename "$4" >> "$R/assets" ;;
  "release download") cp "$R/published/$5" "$7/" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac
`,
      );
      chmodSync(join(bin, 'gh'), 0o755);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** `published` = assets the release already serves, name → bytes. */
    const attachRun = (opts: {
      safari: string;
      published?: Record<string, string>;
      built?: string[];
    }): SpawnSyncReturns<string> => {
      const published = opts.published ?? {};
      mkdirSync(join(dir, 'published'));
      for (const [name, body] of Object.entries(published)) {
        writeFileSync(join(dir, 'published', name), body);
      }
      writeFileSync(join(dir, 'assets'), Object.keys(published).map((n) => `${n}\n`).join(''));
      for (const name of opts.built ?? []) writeFileSync(join(dir, 'work', name), `rebuilt ${name}`);
      return runStep(steps[attach]?.run ?? 'exit 99', {
        cwd: join(dir, 'work'),
        bin,
        env: {
          GH_TOKEN: 'x',
          VERSION: '1.2.3',
          RELEASE_TAG: 'v1.2.3',
          SAFARI: opts.safari,
        },
      });
    };
    const CHROME = 'contextmint-bridge-chrome-1.2.3.zip';
    const SAFARI = 'contextmint-bridge-safari-1.2.3.zip';
    const uploads = (): string[] =>
      log()
        .filter((l) => l.startsWith('release upload'))
        .map((l) => l.split(' ')[3] ?? '');

    it('attaches both pairs to a fresh release, each digest in sha256sum format', () => {
      const r = attachRun({ safari: 'true', built: [CHROME, SAFARI] });
      expect(r.status, r.stderr).toBe(0);
      expect(uploads()).toEqual([CHROME, `${CHROME}.sha256`, SAFARI, `${SAFARI}.sha256`]);
      expect(uploaded(`${SAFARI}.sha256`)).toBe(`${sha(`rebuilt ${SAFARI}`)}  ${SAFARI}\n`);
      expect(uploaded(`${CHROME}.sha256`)).toBe(`${sha(`rebuilt ${CHROME}`)}  ${CHROME}\n`);
    });

    it('attaches only the Chrome pair for a tag that predates the Safari package', () => {
      const r = attachRun({ safari: 'false', built: [CHROME] });
      expect(r.status, r.stderr).toBe(0);
      expect(uploads()).toEqual([CHROME, `${CHROME}.sha256`]);
    });

    it('refuses to run when the Safari detection output is missing', () => {
      const r = attachRun({ safari: '', built: [CHROME, SAFARI] });
      expect(r.status).not.toBe(0);
      expect(uploads()).toEqual([]);
    });

    it('finishes a part-failed release: Chrome left alone, the Safari pair added', () => {
      const r = attachRun({
        safari: 'true',
        published: { [CHROME]: 'published chrome', [`${CHROME}.sha256`]: 'published digest' },
        built: [CHROME, SAFARI],
      });
      expect(r.status, r.stderr).toBe(0);
      expect(uploads()).toEqual([SAFARI, `${SAFARI}.sha256`]);
    });

    it('hashes the zip the release already serves, never the rebuild', () => {
      const r = attachRun({
        safari: 'true',
        published: {
          [CHROME]: 'published chrome',
          [`${CHROME}.sha256`]: 'published digest',
          [SAFARI]: 'published safari',
        },
        built: [CHROME, SAFARI],
      });
      expect(r.status, r.stderr).toBe(0);
      expect(log()).toContain(`release download v1.2.3 --pattern ${SAFARI} --dir .`);
      expect(uploads()).toEqual([`${SAFARI}.sha256`]);
      expect(uploaded(`${SAFARI}.sha256`)).toBe(`${sha('published safari')}  ${SAFARI}\n`);
    });

    it.each([CHROME, SAFARI])(
      'refuses a lone %s digest before uploading anything for either target',
      (lone) => {
        const r = attachRun({
          safari: 'true',
          published: { [`${lone}.sha256`]: 'orphan digest' },
          built: [CHROME, SAFARI],
        });
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain(`carries ${lone}.sha256 but not ${lone}`);
        expect(uploads()).toEqual([]);
      },
    );
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

  it('bumps every workspace package.json, so a new package cannot be forgotten', () => {
    const paths = (pkg['extra-files'] as { path: string; jsonpath: string }[])
      .filter((f) => f.jsonpath === '$.version')
      .map((f) => f.path);
    const workspaces = readdirSync(join(ROOT, 'packages'))
      .map((p) => `packages/${p}/package.json`)
      .filter((p) => existsSync(join(ROOT, p)));
    expect(workspaces.length).toBeGreaterThan(0);
    for (const ws of workspaces) expect(paths, ws).toContain(ws);
  });

  it('bumps the Safari container app’s MARKETING_VERSION, by its inline marker', () => {
    // A `generic` updater rewrites only the line carrying
    // `x-release-please-version`, so apple/project.yml keeps its comments and
    // its build number (CURRENT_PROJECT_VERSION is the deploy workflow's). The
    // container, its appex and manifest.json must carry one version, or App
    // Store validation refuses the upload. tests/apple-project.test.ts pins the
    // marker's line.
    const entries = (pkg['extra-files'] as (string | { type: string; path: string })[]).filter(
      (f) => (typeof f === 'string' ? f : f.path) === 'apple/project.yml',
    );
    expect(entries).toEqual([{ type: 'generic', path: 'apple/project.yml' }]);
  });

  it('keeps the workspace dependency version-free, so a release bump cannot strand it', () => {
    // release-please moves every workspace `version` but never an
    // inter-workspace range. The first release takes extension-core from
    // 3.2.2 to 1.0.0; a `^3.2.2` range would then no longer match the
    // workspace, and `npm ci` goes to the registry for a private package
    // that was never published (404). `*` always resolves to the workspace.
    for (const p of ['extension-chrome', 'extension-safari']) {
      const browser = JSON.parse(read(`packages/${p}/package.json`));
      expect(browser.dependencies['@fetchproxy/extension-core'], p).toBe('*');
    }
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

  it('pins the protocol in every workspace, so none keeps testing the locked version', () => {
    const names = readdirSync(join(ROOT, 'packages'))
      .filter((p) => existsSync(join(ROOT, 'packages', p, 'package.json')))
      .map((p) => JSON.parse(read(`packages/${p}/package.json`)).name as string);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(run, name).toContain(`-w ${name}`);
  });

  it('runs npm test after the install', () => {
    const steps = job.steps ?? [];
    const install = steps.findIndex((s) => (s.run ?? '').includes('@fetchproxy/protocol@'));
    const test = steps.findIndex((s) => /\bnpm test\b/.test(s.run ?? ''));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(test).toBeGreaterThan(install);
  });
});

/**
 * The TestFlight deploy of the Safari app (plan
 * 2026-10-05-safari-extension-standalone, Task 5). It holds the org's signing
 * certificates on the shared self-hosted Mac and uploads to App Store Connect,
 * so the parts pinned here are the ones whose silent drift would ship from the
 * wrong place, sign with the wrong profile, or leave signing material behind.
 * What it checks before signing is apple/tools/testflight-preflight.ts
 * (tests/apple-testflight-preflight.test.ts).
 */
describe('deploy-safari-app.yml', () => {
  const FILE = 'deploy-safari-app.yml';
  const text = read(join('.github', 'workflows', FILE));
  const wf = parse(text) as Workflow & {
    permissions?: Record<string, string>;
    concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  };
  interface DeployJob extends Job {
    'runs-on'?: string[];
    environment?: string;
    'timeout-minutes'?: number;
    strategy?: { 'fail-fast'?: boolean; matrix?: { include?: Record<string, string>[] } };
    env?: Record<string, string>;
  }
  const jobs = Object.entries(wf.jobs) as [string, DeployJob][];
  const [, job] = jobs[0] ?? ['', {} as DeployJob];
  const steps = job.steps ?? [];
  const named = (name: string): number => steps.findIndex((s) => s.name === name);
  const runOf = (name: string): string => steps[named(name)]?.run ?? '';
  const matrix = job.strategy?.matrix?.include ?? [];
  /** The workflow with its comments removed: what actually runs. */
  const code = text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('runs on a v* tag push or a manual dispatch, never on a PR or a branch push', () => {
    expect(Object.keys(wf.on ?? {}).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(wf.on?.['push']).toEqual({ tags: ['v*'] });
    const dispatch = wf.on?.['workflow_dispatch'] as {
      inputs: Record<string, { type: string; required: boolean }>;
    };
    expect(Object.keys(dispatch.inputs)).toEqual(['build_number']);
    expect(dispatch.inputs['build_number']).toMatchObject({ type: 'string', required: false });
  });

  it('is its own workflow, so an Apple failure never reddens attach-extension', () => {
    const release = workflow('release-please.yml');
    expect(Object.keys(release.jobs)).not.toContain(jobs[0]?.[0]);
    expect(read(join('.github', 'workflows', 'release-please.yml'))).not.toMatch(
      /xcodebuild|TestFlight upload|asc publish/,
    );
  });

  it('reads contents only, and never cancels a deploy half-way', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(wf.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('one job, on the testflight environment and the shared self-hosted Mac', () => {
    expect(jobs).toHaveLength(1);
    expect(job.environment).toBe('testflight');
    expect(job['runs-on']).toEqual(['self-hosted', 'macOS']);
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job.env?.['DEVELOPER_DIR']).toBe('/Applications/Xcode.app/Contents/Developer');
    expect(code).not.toContain('xcode-select');
  });

  it('builds iOS and macOS, each failing on its own', () => {
    expect(matrix.map((m) => m['platform'])).toEqual(['ios', 'macos']);
    expect(job.strategy?.['fail-fast']).toBe(false);
  });

  it.each([
    {
      platform: 'ios',
      scheme: 'ContextMintBridgeIOS',
      destination: 'generic/platform=iOS',
      profile_type: 'IOS_APP_STORE',
      app_profile_var: 'IOS_APP_PROFILE',
      extension_profile_var: 'IOS_EXTENSION_PROFILE',
      app_profile_name: 'ContextMint Bridge iOS App Store',
      extension_profile_name: 'ContextMint Bridge Extension iOS App Store',
    },
    {
      platform: 'macos',
      scheme: 'ContextMintBridgeMac',
      destination: 'generic/platform=macOS',
      profile_type: 'MAC_APP_STORE',
      app_profile_var: 'MAC_APP_PROFILE',
      extension_profile_var: 'MAC_EXTENSION_PROFILE',
      // Not the plan's "ContextMint Bridge Mac App Store": that profile signs
      // ContextMint for Mac's embedded appex until plan Task 7.
      app_profile_name: 'ContextMint Bridge App Mac App Store',
      extension_profile_name: 'ContextMint Bridge Extension Mac App Store',
    },
  ])('$platform signs with the owner’s profiles, by exact name', (expected) => {
    expect(matrix.find((m) => m['platform'] === expected.platform)).toMatchObject(expected);
    // The variables apple/project.yml reads each target's profile from.
    const project = read('apple/project.yml');
    expect(project).toContain(`PROVISIONING_PROFILE_SPECIFIER: $(${expected.app_profile_var})`);
    expect(project).toContain(
      `PROVISIONING_PROFILE_SPECIFIER: $(${expected.extension_profile_var})`,
    );
  });

  it('refuses a commit that is not on main before anything is checked out', () => {
    const checkout = steps.findIndex((s) => (s.uses ?? '').startsWith('actions/checkout@'));
    expect(steps[0]?.name).toBe('Refuse a commit that is not on main');
    expect(steps[0]?.run).toContain('compare/main...$GITHUB_SHA');
    expect(steps[0]?.run).toMatch(/identical\|behind\)/);
    expect(checkout).toBe(1);
  });

  it('never lets Xcode provision on its own, and signs manually', () => {
    expect(code).not.toMatch(/allowProvisioningUpdates/);
    expect(runOf('Archive')).toContain('CODE_SIGN_STYLE=Manual');
    expect(runOf('Archive')).toContain('CODE_SIGNING_ALLOWED=YES');
    // One profile per target, through the project's variables.
    expect(runOf('Archive')).not.toContain('PROVISIONING_PROFILE_SPECIFIER');
    expect(runOf('Export')).toContain('<string>manual</string>');
  });

  it('checks every prerequisite before a certificate reaches the runner', () => {
    const order = [
      'Resolve version and build number',
      'Check the App Store prerequisites',
      'Import signing certificates',
      'Download + install the App Store provisioning profiles',
      'Check the signing identities and profiles',
      'Archive',
      'The archive carries one version and the icon',
      'Export',
      'Upload to TestFlight via asc',
    ].map(named);
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(runOf('Resolve version and build number')).toContain('testflight-preflight.ts tag');
    expect(runOf('Check the App Store prerequisites')).toContain('testflight-preflight.ts account');
    expect(runOf('Check the signing identities and profiles')).toContain(
      'testflight-preflight.ts signing',
    );
    expect(runOf('The archive carries one version and the icon')).toContain(
      'testflight-preflight.ts archive',
    );
  });

  it('installs the workspaces without lifecycle scripts', () => {
    expect(runOf('Install the workspaces').trim()).toBe('npm ci --ignore-scripts');
  });

  it('uploads nothing but to TestFlight: no artifact, no App Store submission', () => {
    expect(steps.some((s) => (s.uses ?? '').startsWith('actions/upload-artifact'))).toBe(false);
    expect(code).not.toMatch(/--submit\b|asc submit|review submit/);
  });

  it('always destroys the signing material and build products, last', () => {
    const last = steps.at(-1);
    expect(last?.if).toBe('always()');
    for (const needle of [
      'security delete-keychain "$KEYCHAIN_PATH"',
      'installed-profiles.txt',
      '"$RUNNER_TEMP/private_keys"',
      '"$RUNNER_TEMP/dd"',
      '"$WORKSPACE_APPLE/build"',
    ]) {
      expect(last?.run, needle).toContain(needle);
    }
  });

  describe('Resolve version and build number (executed)', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'deploy-ver-'));
      mkdirSync(join(dir, 'tools'));
      writeFileSync(
        join(dir, 'tools', 'testflight-preflight.ts'),
        readFileSync(join(ROOT, 'apple', 'tools', 'testflight-preflight.ts')),
      );
      writeFileSync(
        join(dir, 'project.yml'),
        'settings:\n  base:\n    MARKETING_VERSION: "1.6.0" # x-release-please-version\n',
      );
      writeFileSync(join(dir, 'out'), '');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const run = (env: Record<string, string>) =>
      runStep(runOf('Resolve version and build number'), {
        cwd: dir,
        env: {
          GITHUB_OUTPUT: join(dir, 'out'),
          GITHUB_REF_TYPE: 'tag',
          GITHUB_REF_NAME: 'v1.6.0',
          EVENT: 'push',
          BUILD_IN: '',
          RUN_NUMBER: '42',
          RUN_ATTEMPT: '3',
          PLATFORM: 'ios',
          ...env,
        },
      });
    const outputs = (): string => readFileSync(join(dir, 'out'), 'utf8');

    it('numbers the build run_number*100 + run_attempt', () => {
      const r = run({});
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(outputs()).toBe('marketing=1.6.0\nbuild=4203\n');
    });

    it('takes a digits-only build_number override, and refuses anything else', () => {
      expect(run({ BUILD_IN: '9001' }).status).toBe(0);
      expect(outputs()).toContain('build=9001\n');
      const bad = run({ BUILD_IN: '9001; rm -rf /' });
      expect(bad.status).not.toBe(0);
      expect(bad.stdout).toContain('build_number must be digits');
    });

    it('refuses a tag that is not v + MARKETING_VERSION, writing no outputs', () => {
      const r = run({ GITHUB_REF_NAME: 'v1.7.0' });
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain('::error::The tag v1.7.0 is not v1.6.0');
      expect(outputs()).toBe('');
    });
  });
});
