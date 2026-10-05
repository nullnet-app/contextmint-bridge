import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The appex pre-build phase, `apple/tools/stage-extension.sh` (plan
 * 2026-10-05-safari-extension-standalone, Task 1 step 3). It builds the Safari
 * resources from THIS tree and copies `packages/extension-safari/dist/` into
 * the appex's resources folder — `Contents/Resources` on macOS, the flat
 * bundle root on iOS — refusing anything Safari would load and never run, or
 * App Store validation would refuse after the upload.
 *
 * The rules are mcp-host-app's `tools/fetch_bridge_resources.py`, minus the
 * download (the extension and the container are the same commit) and minus the
 * `nativeMessaging` requirement (the standalone extension talks to no app),
 * plus one: the manifest's `version` is the project's `MARKETING_VERSION`.
 *
 * Every case shells out to the real script against a temp directory, the way
 * Xcode runs it: build settings in as environment variables.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT_DIR = join(ROOT, 'apple', 'tools');
const VERSION = '1.5.0';

type Manifest = Record<string, unknown>;

const goodManifest = (): Manifest => ({
  manifest_version: 3,
  name: 'ContextMint Bridge',
  version: VERSION,
  description: 'Lets ContextMint and local MCP tools use your signed-in browser tabs.',
  icons: { '16': 'icons/16.png', '128': 'icons/128.png' },
  action: { default_popup: 'popup.html', default_icon: { '16': 'icons/16.png' } },
  background: { scripts: ['background.js'], persistent: false },
  permissions: ['storage', 'tabs', 'scripting', 'cookies', 'webRequest', 'alarms'],
  host_permissions: ['<all_urls>'],
  browser_specific_settings: { safari: { strict_min_version: '27.0' } },
});

/** A built Safari `dist/` (manifest, background, popup, icons). */
function writeDist(dir: string, manifest: Manifest = goodManifest()): void {
  mkdirSync(join(dir, 'icons'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'background.js'), '(() => {})();\n');
  writeFileSync(join(dir, 'popup.html'), '<!doctype html>\n');
  writeFileSync(join(dir, 'icons', '16.png'), 'png');
  writeFileSync(join(dir, 'icons', '128.png'), 'png');
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cmb-stage-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Form {
  label: string;
  /** UNLOCALIZED_RESOURCES_FOLDER_PATH, relative to TARGET_BUILD_DIR. */
  resources: string;
}
const MAC: Form = {
  label: 'macOS (Contents/Resources)',
  resources: 'ContextMintBridgeExtension.appex/Contents/Resources',
};
const IOS: Form = { label: 'iOS (flat appex)', resources: 'ContextMintBridgeExtension.appex' };

interface Run {
  result: SpawnSyncReturns<string>;
  dest: string;
}

/**
 * Runs the script as Xcode would. `dist` set means STAGE_EXTENSION_DIST (no
 * npm build); otherwise the script builds, so the caller gives it a fake repo.
 */
function stage(
  form: Form,
  opts: {
    dist?: string;
    script?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Run {
  const buildDir = join(tmp, 'Build');
  const dest = join(buildDir, form.resources);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...process.env,
    TARGET_BUILD_DIR: buildDir,
    UNLOCALIZED_RESOURCES_FOLDER_PATH: form.resources,
    EXECUTABLE_NAME: 'ContextMintBridgeExtension',
    MARKETING_VERSION: VERSION,
    DERIVED_FILE_DIR: join(tmp, 'Derived'),
    STAGE_EXTENSION_DIST: opts.dist,
    ...opts.env,
  })) {
    if (v !== undefined) env[k] = v;
  }
  const result = spawnSync('/bin/sh', [opts.script ?? join(SCRIPT_DIR, 'stage-extension.sh')], {
    encoding: 'utf8',
    env,
  });
  return { result, dest };
}

const listed = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => join(d.parentPath, d.name).slice(dir.length + 1))
        .sort()
    : [];

describe.each([MAC, IOS])('stage-extension.sh into $label', (form) => {
  it('copies dist/ in, with manifest.json at the resources root', () => {
    const dist = join(tmp, 'dist');
    writeDist(dist);
    const { result, dest } = stage(form, { dist });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')).version).toBe(VERSION);
    expect(listed(dest)).toEqual([
      'background.js',
      'icons/128.png',
      'icons/16.png',
      'manifest.json',
      'popup.html',
    ]);
  });

  it('does not require nativeMessaging: the standalone extension asks no app for anything', () => {
    const dist = join(tmp, 'dist');
    writeDist(dist);
    const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')) as Manifest;
    expect(manifest['permissions']).not.toContain('nativeMessaging');
    expect(stage(form, { dist }).result.status).toBe(0);
  });

  it('refuses a manifest whose version is not MARKETING_VERSION, naming both', () => {
    const dist = join(tmp, 'dist');
    writeDist(dist, { ...goodManifest(), version: '1.4.0' });
    const { result, dest } = stage(form, { dist });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/^error: /m);
    expect(result.stderr).toContain('1.4.0');
    expect(result.stderr).toContain(VERSION);
    expect(result.stderr).toContain('MARKETING_VERSION');
    expect(existsSync(join(dest, 'manifest.json'))).toBe(false);
  });

  it('refuses to run without MARKETING_VERSION rather than skip the version check', () => {
    const dist = join(tmp, 'dist');
    writeDist(dist);
    const { result } = stage(form, { dist, env: { MARKETING_VERSION: '' } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('MARKETING_VERSION');
  });

  it('refuses a dist/ that brings its own PrivacyInfo.xcprivacy (the appex has its own)', () => {
    const dist = join(tmp, 'dist');
    writeDist(dist);
    writeFileSync(join(dist, 'privacyinfo.xcprivacy'), '<plist/>');
    const { result } = stage(form, { dist });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('privacyinfo.xcprivacy');
  });

  it('refuses a dist/ with no manifest.json at its root', () => {
    const dist = join(tmp, 'dist');
    writeDist(dist);
    rmSync(join(dist, 'manifest.json'));
    const { result } = stage(form, { dist });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no manifest\.json/);
  });

  it('keeps the appex’s own PrivacyInfo.xcprivacy and drops the previous run’s files on a re-stage', () => {
    const dist = join(tmp, 'dist');
    writeDist(dist);
    writeFileSync(join(dist, 'old.js'), '');
    const first = stage(form, { dist });
    expect(first.result.status).toBe(0);
    // Xcode's resources phase copies the appex's privacy manifest AFTER this
    // phase, and on an incremental build does not copy it again.
    writeFileSync(join(first.dest, 'PrivacyInfo.xcprivacy'), '<plist/>');

    rmSync(join(dist, 'old.js'));
    const second = stage(form, { dist });
    expect(second.result.status).toBe(0);
    expect(existsSync(join(second.dest, 'old.js'))).toBe(false);
    expect(readFileSync(join(second.dest, 'PrivacyInfo.xcprivacy'), 'utf8')).toBe('<plist/>');
  });

  it('leaves the previous good staging in place when a later dist/ is refused', () => {
    const dist = join(tmp, 'dist');
    writeDist(dist);
    expect(stage(form, { dist }).result.status).toBe(0);
    writeDist(dist, { ...goodManifest(), version: '9.9.9' });
    const { result, dest } = stage(form, { dist });
    expect(result.status).not.toBe(0);
    expect(JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')).version).toBe(VERSION);
  });
});

describe('stage-extension.sh: the flat iOS appex', () => {
  it.each([
    'ContextMintBridgeExtension',
    'contextmintbridgeextension',
    'Info.plist',
    '_CodeSignature',
    'embedded.mobileprovision',
    'SC_Info',
  ])('refuses a dist/ file named %s, which would overwrite the bundle’s own', (name) => {
    const dist = join(tmp, 'dist');
    writeDist(dist);
    writeFileSync(join(dist, name), 'x');
    const { result, dest } = stage(IOS, { dist });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(existsSync(join(dest, 'manifest.json'))).toBe(false);
  });

  it('refuses a file named like the appex even when EXECUTABLE_NAME differs from the bundle stem', () => {
    const dist = join(tmp, 'dist');
    writeDist(dist);
    writeFileSync(join(dist, 'ContextMintBridgeExtension'), 'x');
    const { result } = stage(IOS, { dist, env: { EXECUTABLE_NAME: 'Other' } });
    expect(result.status).not.toBe(0);
  });

  it('allows the same names under Contents/Resources on macOS, where they cannot clash', () => {
    const dist = join(tmp, 'dist');
    writeDist(dist);
    writeFileSync(join(dist, 'Info.plist'), 'x');
    expect(stage(MAC, { dist }).result.status).toBe(0);
  });
});

describe('stage-extension.sh: where it writes', () => {
  it.each(['ContextMintBridge.app/Contents/Resources', 'Somewhere/Else', 'X.appex/Contents/MacOS'])(
    'refuses a resources folder that is no form of an appex (%s)',
    (resources) => {
      const dist = join(tmp, 'dist');
      writeDist(dist);
      const { result } = stage({ label: resources, resources }, { dist });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/not an appex/);
    },
  );
});

describe('stage-extension.sh: the Safari manifest rules', () => {
  const refused = (manifest: Manifest, expected: RegExp, setup?: (dist: string) => void): void => {
    const dist = join(tmp, 'dist');
    writeDist(dist, manifest);
    setup?.(dist);
    const { result } = stage(MAC, { dist });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(expected);
  };
  const base = goodManifest();

  it('refuses a service-worker background (the Chrome build)', () => {
    refused({ ...base, background: { service_worker: 'background.js' } }, /service_worker/);
  });

  it('refuses a module background', () => {
    refused(
      { ...base, background: { scripts: ['background.js'], persistent: false, type: 'module' } },
      /"type": "module"/,
    );
  });

  it('refuses a background that is not a non-persistent event page', () => {
    refused({ ...base, background: { scripts: ['background.js'] } }, /persistent/);
  });

  it('refuses a background script the manifest names and dist/ lacks', () => {
    refused({ ...base, background: { scripts: ['missing.js'], persistent: false } }, /missing\.js/);
  });

  it('refuses no background at all', () => {
    const { background: _dropped, ...rest } = base;
    refused(rest, /background/);
  });

  it.each(['downloads', 'tabGroups'])('refuses the %s permission, absent in Safari', (perm) => {
    refused({ ...base, permissions: ['storage', perm] }, new RegExp(perm));
  });

  it('refuses an SVG toolbar icon (Safari silently drops the extension)', () => {
    refused(
      { ...base, action: { default_popup: 'popup.html', default_icon: 'icons/icon.svg' } },
      /not a PNG/,
      (dist) => writeFileSync(join(dist, 'icons', 'icon.svg'), '<svg/>'),
    );
  });

  it('refuses an icon the manifest names and dist/ lacks', () => {
    refused({ ...base, icons: { '48': 'icons/48.png' } }, /icons\/48\.png/);
  });

  it.each([undefined, '26.4', 'x'])('refuses a Safari floor below 27.0 (%s)', (floor) => {
    refused(
      {
        ...base,
        browser_specific_settings:
          floor === undefined ? {} : { safari: { strict_min_version: floor } },
      },
      /strict_min_version/,
    );
  });

  it('refuses a description over App Store Connect’s 112 characters (error 90849)', () => {
    refused({ ...base, description: 'x'.repeat(113) }, /112/);
  });

  it('refuses a manifest that is not JSON', () => {
    refused(base, /not valid JSON/, (dist) => writeFileSync(join(dist, 'manifest.json'), '{'));
  });

  it('names every problem at once', () => {
    refused(
      { ...base, permissions: ['downloads'], description: 'x'.repeat(200) },
      /downloads[\s\S]*112/,
    );
  });
});

describe('stage-extension.sh: the build', () => {
  /**
   * A copy of the script in a fake repo whose `npm` is a stub that records how
   * it was called and writes a dist/, so the real tree's dist/ is never touched.
   */
  function fakeRepo(): { repo: string; script: string; log: string } {
    const repo = join(tmp, 'repo');
    const tools = join(repo, 'apple', 'tools');
    mkdirSync(tools, { recursive: true });
    for (const f of readdirSync(SCRIPT_DIR)) copyFileSync(join(SCRIPT_DIR, f), join(tools, f));
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    const log = join(tmp, 'npm.log');
    const fixture = join(tmp, 'fixture');
    writeDist(fixture);
    writeFileSync(
      join(bin, 'npm'),
      [
        '#!/bin/sh',
        `printf '%s|%s\\n' "$PWD" "$*" >> '${log}'`,
        `mkdir -p '${repo}/packages/extension-safari'`,
        `rm -rf '${repo}/packages/extension-safari/dist'`,
        `cp -R '${fixture}' '${repo}/packages/extension-safari/dist'`,
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'npm'), 0o755);
    return { repo, script: join(tools, 'stage-extension.sh'), log };
  }

  it('runs the extension-safari release build from the repo root, then stages its dist/', () => {
    const { repo, script, log } = fakeRepo();
    const bin = dirname(join(tmp, 'bin', 'npm'));
    const { result, dest } = stage(MAC, {
      script,
      env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` },
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(readFileSync(log, 'utf8').trim()).toBe(
      `${repo}|run build --workspace=@fetchproxy/extension-safari`,
    );
    expect(existsSync(join(dest, 'manifest.json'))).toBe(true);
  });

  it('fails the phase when the build fails', () => {
    const { script } = fakeRepo();
    const bin = join(tmp, 'bin');
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho boom >&2\nexit 3\n');
    const { result } = stage(MAC, { script, env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('boom');
  });
});
