import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_BUNDLE_ID,
  APPEX_BUNDLE_ID,
  PLATFORMS,
  accountProblems,
  archiveProblems,
  parsePlist,
  signingProblems,
  tagProblems,
  type Platform,
} from '../apple/tools/testflight-preflight';

/**
 * `apple/tools/testflight-preflight.ts`: what the TestFlight deploy
 * (`.github/workflows/deploy-safari-app.yml`, plan Task 5) refuses to sign or
 * upload without. Every check names what is missing, all at once, before any
 * certificate reaches the runner (`account`), before anything is archived with
 * the wrong signing material (`signing`), and before an upload whose versions
 * disagree (`tag`, `archive`).
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'apple', 'tools', 'testflight-preflight.ts');
const PLATFORM_LIST: Platform[] = ['ios', 'macos'];

// --- asc fixtures -----------------------------------------------------------

const APP_BUNDLE_REF = 'CA375G35HX';
const APPEX_BUNDLE_REF = '8GN98D27N9';
const MCPHOST_BRIDGE_REF = 'SMMARX7A99';
const DIST_CERT = 'K592H7CRNF';
const DEV_CERT = 'P97QV92W3B';

const apps = { data: [{ id: '6819349214', type: 'apps' }] };
const versions = { data: [{ id: 'v1', type: 'appStoreVersions' }] };

function profileRow(
  id: string,
  name: string,
  bundleRef: string,
  opts: { state?: string; cert?: string } = {},
): object {
  return {
    id,
    type: 'profiles',
    attributes: { name, profileState: opts.state ?? 'ACTIVE' },
    relationships: {
      bundleId: { data: { type: 'bundleIds', id: bundleRef } },
      certificates: { data: [{ type: 'certificates', id: opts.cert ?? DIST_CERT }] },
    },
  };
}
const included = [
  { id: APP_BUNDLE_REF, type: 'bundleIds', attributes: { identifier: APP_BUNDLE_ID } },
  { id: APPEX_BUNDLE_REF, type: 'bundleIds', attributes: { identifier: APPEX_BUNDLE_ID } },
  {
    id: MCPHOST_BRIDGE_REF,
    type: 'bundleIds',
    attributes: { identifier: 'app.nullnet.mcphost.bridge' },
  },
  { id: DIST_CERT, type: 'certificates', attributes: { certificateType: 'DISTRIBUTION' } },
  { id: DEV_CERT, type: 'certificates', attributes: { certificateType: 'DEVELOPMENT' } },
];
const goodProfiles = (platform: Platform): object => ({
  data: [
    profileRow('APP1', PLATFORMS[platform].appProfile, APP_BUNDLE_REF),
    profileRow('EXT1', PLATFORMS[platform].extensionProfile, APPEX_BUNDLE_REF),
  ],
  included,
});
const goodAccount = (platform: Platform) => ({
  platform,
  apps,
  versions,
  profiles: goodProfiles(platform),
  distSecret: true,
  installerSecret: true,
});

describe('profile names (plan O3, as the owner created them)', () => {
  it('iOS', () => {
    expect(PLATFORMS.ios.appProfile).toBe('ContextMint Bridge iOS App Store');
    expect(PLATFORMS.ios.extensionProfile).toBe('ContextMint Bridge Extension iOS App Store');
  });

  it('macOS: the app’s is "ContextMint Bridge App Mac App Store", never mcp-host-app’s appex profile', () => {
    expect(PLATFORMS.macos.appProfile).toBe('ContextMint Bridge App Mac App Store');
    expect(PLATFORMS.macos.extensionProfile).toBe('ContextMint Bridge Extension Mac App Store');
    // "ContextMint Bridge Mac App Store" signs ContextMint for Mac's embedded
    // appex (app.nullnet.mcphost.bridge) until plan Task 7.
    expect(Object.values(PLATFORMS.macos)).not.toContain('ContextMint Bridge Mac App Store');
  });
});

describe('account', () => {
  it.each(PLATFORM_LIST)('%s: passes, resolving the app and both profile ids', (platform) => {
    expect(accountProblems(goodAccount(platform))).toEqual({
      problems: [],
      resolved: { app_id: '6819349214', app_profile_id: 'APP1', extension_profile_id: 'EXT1' },
    });
  });

  it.each(PLATFORM_LIST)('%s: names every missing item at once', (platform) => {
    const { problems } = accountProblems({
      platform,
      apps: { data: [] },
      versions: null,
      profiles: { data: [], included: [] },
      distSecret: false,
      installerSecret: false,
    });
    const expected = [
      /No App Store Connect app record for app\.nullnet\.contextmint\.bridge/,
      new RegExp(`profile named "${PLATFORMS[platform].appProfile}"`),
      new RegExp(`profile named "${PLATFORMS[platform].extensionProfile}"`),
      /DIST_CERT_P12_B64/,
    ];
    if (platform === 'macos') expected.push(/MAC_INSTALLER_CERT_P12_B64/);
    expect(problems).toHaveLength(expected.length);
    expected.forEach((re, i) => expect(problems[i]).toMatch(re));
  });

  it('iOS does not need the Mac installer certificate', () => {
    expect(accountProblems({ ...goodAccount('ios'), installerSecret: false }).problems).toEqual([]);
  });

  it.each(PLATFORM_LIST)('%s: an app with no record for the platform is named', (platform) => {
    const { problems } = accountProblems({ ...goodAccount(platform), versions: { data: [] } });
    expect(problems).toEqual([
      expect.stringMatching(new RegExp(`has no ${PLATFORMS[platform].label} platform`)),
    ]);
  });

  it('refuses a profile of the right name made for another App ID', () => {
    const profiles = {
      data: [
        profileRow('APP1', PLATFORMS.macos.appProfile, MCPHOST_BRIDGE_REF),
        profileRow('EXT1', PLATFORMS.macos.extensionProfile, APPEX_BUNDLE_REF),
      ],
      included,
    };
    const { problems, resolved } = accountProblems({ ...goodAccount('macos'), profiles });
    expect(problems).toEqual([
      expect.stringMatching(
        /"ContextMint Bridge App Mac App Store" \(APP1\) is for app\.nullnet\.mcphost\.bridge, not app\.nullnet\.contextmint\.bridge/,
      ),
    ]);
    expect(resolved['app_profile_id']).toBeUndefined();
  });

  it('refuses an inactive profile, or one bound only to a development certificate', () => {
    const profiles = {
      data: [
        profileRow('APP1', PLATFORMS.ios.appProfile, APP_BUNDLE_REF, { state: 'INVALID' }),
        profileRow('EXT1', PLATFORMS.ios.extensionProfile, APPEX_BUNDLE_REF, { cert: DEV_CERT }),
      ],
      included,
    };
    const { problems } = accountProblems({ ...goodAccount('ios'), profiles });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/\(APP1\) is INVALID/);
    expect(problems[1]).toMatch(/\(EXT1\) is not bound to an Apple Distribution certificate/);
  });
});

// --- decoded-profile fixtures ----------------------------------------------

const DIST_DER = Buffer.from('the Apple Distribution certificate');
const OTHER_DER = Buffer.from('some other certificate');
const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex').toUpperCase();

/** What `security cms -D` prints for a profile, trimmed to the keys read. */
function profileXml(
  platform: Platform,
  opts: {
    name?: string;
    bundleId?: string;
    der?: Buffer;
    devices?: boolean;
    getTaskAllow?: boolean;
    platformValue?: string;
  } = {},
): string {
  const spec = PLATFORMS[platform];
  const b64 = (opts.der ?? DIST_DER).toString('base64');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AppIDName</key>
	<string>ContextMint Bridge &amp; friends</string>
	<key>CreationDate</key>
	<date>2026-10-05T15:59:29Z</date>
	<key>Platform</key>
	<array>
		<string>${opts.platformValue ?? spec.profilePlatform}</string>
	</array>
	<key>IsXcodeManaged</key>
	<false/>
	<key>DeveloperCertificates</key>
	<array>
		<data>${b64.slice(0, 8)}
		${b64.slice(8)}</data>
	</array>
	<key>Entitlements</key>
	<dict>
		<key>${spec.appIdEntitlement}</key>
		<string>5A673K24X6.${opts.bundleId ?? APP_BUNDLE_ID}</string>
		<key>keychain-access-groups</key>
		<array>
			<string>5A673K24X6.*</string>
		</array>
		<key>get-task-allow</key>
		${opts.getTaskAllow ? '<true/>' : '<false/>'}
	</dict>
	${opts.devices ? '<key>ProvisionedDevices</key><array><string>00008112-0001</string></array>' : ''}
	<key>Name</key>
	<string>${opts.name ?? spec.appProfile}</string>
	<key>TimeToLive</key>
	<integer>248</integer>
	<key>Empty</key>
	<array/>
</dict>
</plist>
`;
}

const identities = (installer?: string): string =>
  [
    `  1) ${sha1(DIST_DER)} "Apple Distribution: Christopher Hall (5A673K24X6)"`,
    installer ? `  2) ${'A'.repeat(40)} "${installer}: Christopher Hall (5A673K24X6)"` : '',
    `  3) ${'B'.repeat(40)} "Apple Distribution: Someone Else (ZZZZZZZZZZ)"`,
    `     ${installer ? 3 : 2} valid identities found`,
  ]
    .filter(Boolean)
    .join('\n');

const goodSigning = (platform: Platform) => ({
  platform,
  identities: identities(platform === 'macos' ? '3rd Party Mac Developer Installer' : undefined),
  appProfile: parsePlist(profileXml(platform)),
  extensionProfile: parsePlist(
    profileXml(platform, {
      name: PLATFORMS[platform].extensionProfile,
      bundleId: APPEX_BUNDLE_ID,
    }),
  ),
});

describe('parsePlist', () => {
  it('reads the shapes a decoded profile carries', () => {
    const p = parsePlist(profileXml('ios')) as Record<string, unknown>;
    expect(p['AppIDName']).toBe('ContextMint Bridge & friends');
    expect(p['IsXcodeManaged']).toBe(false);
    expect(p['TimeToLive']).toBe(248);
    expect(p['Empty']).toEqual([]);
    expect(p['CreationDate']).toEqual(new Date('2026-10-05T15:59:29Z'));
    expect(Buffer.from((p['DeveloperCertificates'] as Uint8Array[])[0] ?? [])).toEqual(DIST_DER);
    expect((p['Entitlements'] as Record<string, unknown>)['keychain-access-groups']).toEqual([
      '5A673K24X6.*',
    ]);
  });

  it('refuses what it does not understand rather than guessing', () => {
    expect(() => parsePlist('<plist><dict><string>x</string></dict></plist>')).toThrow(/<key>/);
    expect(() => parsePlist('<plist><dict><key>a</key>')).toThrow(/truncated/);
  });
});

describe('signing', () => {
  it.each(PLATFORM_LIST)('%s: passes with this team’s identities and both profiles', (platform) => {
    const { problems, installer } = signingProblems(goodSigning(platform));
    expect(problems).toEqual([]);
    expect(installer).toBe(platform === 'macos' ? '3rd Party Mac Developer Installer' : undefined);
  });

  it('macOS: reports the installer name the keychain actually holds', () => {
    const { installer } = signingProblems({
      ...goodSigning('macos'),
      identities: identities('Mac Installer Distribution'),
    });
    expect(installer).toBe('Mac Installer Distribution');
  });

  it('macOS: no installer identity is a problem; iOS does not need one', () => {
    expect(signingProblems({ ...goodSigning('macos'), identities: identities() }).problems).toEqual(
      [expect.stringMatching(/No Mac installer identity/)],
    );
    expect(signingProblems({ ...goodSigning('ios'), identities: identities() }).problems).toEqual(
      [],
    );
  });

  it('only this team’s Apple Distribution identity counts', () => {
    const { problems } = signingProblems({
      ...goodSigning('ios'),
      identities: `  1) ${sha1(DIST_DER)} "Apple Distribution: Someone Else (ZZZZZZZZZZ)"`,
    });
    expect(problems[0]).toMatch(/No Apple Distribution identity for team 5A673K24X6/);
  });

  it.each(PLATFORM_LIST)('%s: names each way a profile can be wrong', (platform) => {
    const spec = PLATFORMS[platform];
    const { problems } = signingProblems({
      ...goodSigning(platform),
      appProfile: parsePlist(
        profileXml(platform, {
          bundleId: APPEX_BUNDLE_ID,
          der: OTHER_DER,
          devices: true,
          getTaskAllow: true,
          platformValue: platform === 'ios' ? 'OSX' : 'iOS',
        }),
      ),
      extensionProfile: parsePlist(profileXml(platform, { name: 'Something Else' })),
    });
    expect(problems).toEqual([
      expect.stringMatching(new RegExp(`"${spec.appProfile}" is not a ${spec.label} profile`)),
      expect.stringMatching(/lists devices/),
      expect.stringMatching(/is for 5A673K24X6\.app\.nullnet\.contextmint\.bridge\.extension, not/),
      expect.stringMatching(/get-task-allow/),
      expect.stringMatching(/is not bound to the Apple Distribution certificate/),
      expect.stringMatching(/downloaded as a profile named "Something Else"/),
      expect.stringMatching(
        /is for 5A673K24X6\.app\.nullnet\.contextmint\.bridge, not .*\.extension/,
      ),
    ]);
  });
});

describe('tag', () => {
  it('passes a tag push of v + MARKETING_VERSION', () => {
    expect(
      tagProblems({ event: 'push', refType: 'tag', refName: 'v1.6.0', marketing: '1.6.0' }),
    ).toEqual([]);
  });

  it('refuses a tag that disagrees with MARKETING_VERSION, pushed or dispatched', () => {
    for (const event of ['push', 'workflow_dispatch']) {
      expect(
        tagProblems({ event, refType: 'tag', refName: 'v1.6.1', marketing: '1.6.0' })[0],
      ).toMatch(/v1\.6\.1 is not v1\.6\.0/);
    }
  });

  it('refuses a push that is not a tag', () => {
    expect(
      tagProblems({ event: 'push', refType: 'branch', refName: 'main', marketing: '1.6.0' })[0],
    ).toMatch(/not a release tag/);
  });

  it('lets a dispatch from main through (the archive check still holds the versions)', () => {
    expect(
      tagProblems({
        event: 'workflow_dispatch',
        refType: 'branch',
        refName: 'main',
        marketing: '1.6.0',
      }),
    ).toEqual([]);
  });

  it('refuses a MARKETING_VERSION that is not X.Y.Z', () => {
    expect(tagProblems({ event: 'push', refType: 'tag', refName: 'v', marketing: '' })[0]).toMatch(
      /not a release version/,
    );
  });
});

describe('archive', () => {
  const appInfo = {
    CFBundleIdentifier: APP_BUNDLE_ID,
    CFBundleShortVersionString: '1.6.0',
    CFBundleVersion: '4201',
    CFBundleIconName: 'AppIcon',
  };
  const appexInfo = {
    CFBundleIdentifier: APPEX_BUNDLE_ID,
    CFBundleShortVersionString: '1.6.0',
    CFBundleVersion: '4201',
  };
  const good = {
    platform: 'ios' as const,
    marketing: '1.6.0',
    build: '4201',
    appInfo,
    appexInfo,
    manifest: { version: '1.6.0' },
  };

  it('passes when the app, the appex and manifest.json carry one version and the icon', () => {
    expect(archiveProblems(good)).toEqual([]);
  });

  it('accepts the icon name under CFBundleIcons, where iOS also records it', () => {
    const { CFBundleIconName: _, ...rest } = appInfo;
    expect(
      archiveProblems({
        ...good,
        appInfo: {
          ...rest,
          CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconName: 'AppIcon' } },
        },
      }),
    ).toEqual([]);
  });

  it('names every disagreement', () => {
    const problems = archiveProblems({
      ...good,
      appInfo: { CFBundleIdentifier: 'app.nullnet.mcphost', CFBundleShortVersionString: '1.5.0' },
      appexInfo: { ...appexInfo, CFBundleVersion: '1' },
      manifest: { version: '1.5.0' },
    });
    expect(problems).toEqual([
      expect.stringMatching(/app CFBundleIdentifier is "app\.nullnet\.mcphost"/),
      expect.stringMatching(/app CFBundleShortVersionString is "1\.5\.0", expected "1\.6\.0"/),
      expect.stringMatching(/manifest\.json version is "1\.5\.0"/),
      expect.stringMatching(/app CFBundleVersion is undefined, expected "4201"/),
      expect.stringMatching(/appex CFBundleVersion is "1", expected "4201"/),
      expect.stringMatching(/app icon \(CFBundleIconName\) is undefined/),
    ]);
  });
});

describe('the CLI, as the workflow runs it (node, no build step)', () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('account: writes the resolved ids to $GITHUB_OUTPUT on success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-preflight-'));
    try {
      writeFileSync(join(dir, 'apps.json'), JSON.stringify(apps));
      writeFileSync(join(dir, 'versions.json'), JSON.stringify(versions));
      writeFileSync(join(dir, 'profiles.json'), JSON.stringify(goodProfiles('macos')));
      const out = join(dir, 'out');
      writeFileSync(out, '');
      const r = run([
        'account',
        '--platform=macos',
        `--apps=${join(dir, 'apps.json')}`,
        `--versions=${join(dir, 'versions.json')}`,
        `--profiles=${join(dir, 'profiles.json')}`,
        '--dist-secret=true',
        '--installer-secret=true',
        `--github-output=${out}`,
      ]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe(
        'app_id=6819349214\napp_profile_id=APP1\nextension_profile_id=EXT1\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('account: fails with one ::error:: per missing item, and writes no outputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-preflight-'));
    try {
      const out = join(dir, 'out');
      writeFileSync(out, '');
      const r = run([
        'account',
        '--platform=ios',
        `--apps=${join(dir, 'missing.json')}`,
        `--profiles=${join(dir, 'missing.json')}`,
        '--dist-secret=false',
        '--installer-secret=false',
        `--github-output=${out}`,
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout.match(/^::error::/gm)).toHaveLength(4);
      expect(r.stdout).toMatch(/Nothing was uploaded/);
      expect(readFileSync(out, 'utf8')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('signing: macOS writes the installer identity name for the export', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-preflight-'));
    try {
      const s = goodSigning('macos');
      writeFileSync(join(dir, 'ids.txt'), s.identities);
      writeFileSync(join(dir, 'app.plist'), profileXml('macos'));
      writeFileSync(
        join(dir, 'ext.plist'),
        profileXml('macos', { name: PLATFORMS.macos.extensionProfile, bundleId: APPEX_BUNDLE_ID }),
      );
      const out = join(dir, 'out');
      writeFileSync(out, '');
      const r = run([
        'signing',
        '--platform=macos',
        `--identities=${join(dir, 'ids.txt')}`,
        `--app-profile=${join(dir, 'app.plist')}`,
        `--extension-profile=${join(dir, 'ext.plist')}`,
        `--github-output=${out}`,
      ]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe(
        'installer_identity=3rd Party Mac Developer Installer\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tag: exits non-zero on a disagreeing tag', () => {
    const r = run([
      'tag',
      '--event=push',
      '--ref-type=tag',
      '--ref-name=v9.9.9',
      '--marketing=1.6.0',
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/::error::The tag v9\.9\.9 is not v1\.6\.0/);
  });

  it('refuses an unknown platform', () => {
    expect(run(['account', '--platform=tvos']).status).toBe(2);
  });
});
