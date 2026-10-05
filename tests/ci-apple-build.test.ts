import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * The unsigned Apple build in `ci.yml` (plan
 * docs/superpowers/plans/2026-10-05-safari-extension-standalone.md, Task 4).
 * It runs on the org's ONE shared self-hosted Mac, so it must run only on PRs
 * that can change what it builds, and it must never become part of the
 * required `ci / ci` gate. These tests pin both, and the path filter itself.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const FILTER = '.github/scripts/apple-build-paths.sh';

const filter = (files: string[]): string => {
  const run = spawnSync('sh', [join(ROOT, FILTER)], {
    input: files.map((f) => `${f}\n`).join(''),
    encoding: 'utf8',
  });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.trim();
};

describe('apple build path filter', () => {
  it.each([
    ['apple/project.yml'],
    ['apple/App/BridgeScreen.swift'],
    ['packages/extension-safari/manifest.ts'],
    ['packages/extension-core/src/background/boot.ts'],
    // The job itself, and its filter: a PR changing either must exercise it.
    ['.github/workflows/ci.yml'],
    [FILTER],
  ])('builds for a PR touching %s', (file) => {
    expect(filter([file])).toBe('true');
  });

  it('builds when any one of several files matches', () => {
    expect(filter(['README.md', 'packages/extension-chrome/src/a.ts', 'apple/project.yml'])).toBe(
      'true',
    );
  });

  it.each([
    [['packages/extension-chrome/src/popup.ts', 'packages/extension-chrome/package.json']],
    [['docs/PRIVACY.md', 'README.md']],
    [['.github/workflows/release-please.yml']],
    // Prefixes are whole path segments, not string prefixes.
    [['apple-notes/x.swift', 'packages/extension-safari-old/a.ts', 'xapple/project.yml']],
    [[]],
  ])('skips a PR touching only %j', (files) => {
    expect(filter(files)).toBe('false');
  });
});

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  'working-directory'?: string;
}
interface Job {
  'runs-on'?: string | string[];
  needs?: string | string[];
  if?: string;
  uses?: string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  'timeout-minutes'?: number;
  env?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  jobs: Record<string, Job>;
}

describe('ci.yml apple job', () => {
  const ci = parse(read('.github/workflows/ci.yml')) as Workflow;
  const changes = ci.jobs['apple-changes'];
  const apple = ci.jobs['apple'];
  const runs = (apple?.steps ?? []).map((s) => s.run ?? '').join('\n');

  it('decides on a hosted runner, from the PR file list, with the tested filter', () => {
    expect(changes).toBeDefined();
    expect(changes?.['runs-on']).toBe('ubuntu-latest');
    expect(changes?.if).toContain("github.event_name == 'pull_request'");
    // A label changes no code, so it must not queue another Mac build.
    expect(changes?.if).toContain("github.event.action != 'labeled'");
    expect(changes?.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    const script = (changes?.steps ?? []).map((s) => s.run ?? '').join('\n');
    expect(script).toContain('/files');
    expect(script).toContain('--paginate');
    expect(script).toContain(FILTER);
    expect(changes?.outputs?.['apple']).toMatch(/steps\.\w+\.outputs\.apple/);
  });

  it('builds on the shared self-hosted Mac only when the filter says so', () => {
    expect(apple).toBeDefined();
    expect(apple?.['runs-on']).toEqual(['self-hosted', 'macOS']);
    expect(apple?.needs).toBe('apple-changes');
    expect(apple?.if).toBe("needs.apple-changes.outputs.apple == 'true'");
    expect(apple?.['timeout-minutes']).toBeGreaterThan(0);
    // Selects Xcode for this job only; never `sudo xcode-select`.
    expect(apple?.env?.['DEVELOPER_DIR']).toBe('/Applications/Xcode.app/Contents/Developer');
    expect(runs).not.toContain('xcode-select');
  });

  it('is not part of the required ci / ci gate', () => {
    const gated = ci.jobs['ci'];
    expect(gated?.uses).toBe('chrischall/workflows/.github/workflows/reusable-mcp-ci.yml@main');
    expect(gated?.needs).toBeUndefined();
    expect(gated?.if).toBeUndefined();
  });

  it('installs without lifecycle scripts and fetches xcodegen only if missing', () => {
    expect(runs).toContain('npm ci --ignore-scripts');
    expect(runs).toMatch(/command -v xcodegen[\s\S]*brew install xcodegen/);
    const generate = (apple?.steps ?? []).find((s) => (s.run ?? '').includes('xcodegen generate'));
    expect(generate?.['working-directory']).toBe('apple');
  });

  it('runs both unsigned builds from Task 1, into a job-local DerivedData', () => {
    const builds = (apple?.steps ?? [])
      .map((s) => s.run ?? '')
      .filter((r) => r.includes('xcodebuild'));
    const mac = builds.find((r) => r.includes('-scheme ContextMintBridgeMac'));
    const ios = builds.find((r) => r.includes('-scheme ContextMintBridgeIOS'));
    for (const build of [mac, ios]) {
      expect(build).toContain('CODE_SIGNING_ALLOWED=NO');
      expect(build).toContain('-derivedDataPath "$RUNNER_TEMP/DerivedData"');
      expect(build).not.toContain('-allowProvisioningUpdates');
    }
    expect(ios).toContain("-destination 'generic/platform=iOS Simulator'");
  });

  it('checks each built appex carries manifest.json at the release version', () => {
    expect(runs).toContain('ContextMintBridgeExtension.appex/Contents/Resources/manifest.json');
    expect(runs).toContain('Debug-iphonesimulator/');
    expect(runs).toContain('ContextMintBridgeExtension.appex/manifest.json');
    expect(runs).toContain('MARKETING_VERSION');
  });

  it('always removes the DerivedData it made on the shared Mac', () => {
    const cleanup = (apple?.steps ?? []).at(-1);
    expect(cleanup?.if).toBe('always()');
    expect(cleanup?.run).toContain('rm -rf "$RUNNER_TEMP/DerivedData"');
  });
});
