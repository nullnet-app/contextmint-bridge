import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * The Safari container app's project definition, `apple/project.yml`
 * (XcodeGen), and the files it points at. Plan
 * 2026-10-05-safari-extension-standalone, Task 1, Decisions D1–D3.
 *
 * The .xcodeproj is generated and never checked in, so this file is the only
 * reviewable form of the project, and these are the parts of it that break
 * silently: an App Store upload refused after the archive (versions, privacy
 * manifests, encryption key), a profile that no longer matches (entitlements,
 * bundle IDs), or an appex that Safari never finds.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APPLE = join(ROOT, 'apple');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

interface Target {
  type: string;
  platform: string;
  sources?: (string | { path: string; excludes?: string[] })[];
  info?: { path: string; properties: Record<string, unknown> };
  settings?: { base?: Record<string, unknown> };
  dependencies?: { target: string; embed?: boolean }[];
  preBuildScripts?: { name: string; script: string; basedOnDependencyAnalysis?: boolean }[];
}
interface Project {
  name: string;
  options: { deploymentTarget: Record<string, string> };
  settings: { base: Record<string, unknown> };
  targets: Record<string, Target>;
}

const projectText = read('apple/project.yml');
const project = parse(projectText) as Project;
const targets = project.targets;

const APP_ID = 'app.nullnet.contextmint.bridge';
const APPEX_ID = 'app.nullnet.contextmint.bridge.extension';

const TARGETS = [
  { name: 'ContextMintBridgeMac', type: 'application', platform: 'macOS', id: APP_ID },
  {
    name: 'ContextMintBridgeExtensionMac',
    type: 'app-extension',
    platform: 'macOS',
    id: APPEX_ID,
  },
  { name: 'ContextMintBridgeIOS', type: 'application', platform: 'iOS', id: APP_ID },
  {
    name: 'ContextMintBridgeExtensionIOS',
    type: 'app-extension',
    platform: 'iOS',
    id: APPEX_ID,
  },
] as const;
const APPS = TARGETS.filter((t) => t.type === 'application');
const APPEXES = TARGETS.filter((t) => t.type === 'app-extension');
const MACS = TARGETS.filter((t) => t.platform === 'macOS');

const settingsOf = (name: string): Record<string, unknown> => targets[name]?.settings?.base ?? {};
const sourcePaths = (name: string): string[] =>
  (targets[name]?.sources ?? []).map((s) => (typeof s === 'string' ? s : s.path));

/** Every file a target's sources pull in, relative to apple/. */
function sourceFiles(name: string): string[] {
  return sourcePaths(name).flatMap((path) => {
    const abs = join(APPLE, path);
    if (!existsSync(abs)) return [];
    if (!statSync(abs).isDirectory()) return [path];
    return readdirSync(abs, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name).slice(APPLE.length + 1));
  });
}

describe('apple/project.yml: targets and identifiers (D2)', () => {
  it('has exactly the four targets', () => {
    expect(Object.keys(targets).sort()).toEqual(TARGETS.map((t) => t.name).sort());
  });

  it.each(TARGETS)(
    '$name is a $platform $type with bundle id $id',
    ({ name, type, platform, id }) => {
      expect(targets[name]?.type).toBe(type);
      expect(targets[name]?.platform).toBe(platform);
      expect(settingsOf(name)['PRODUCT_BUNDLE_IDENTIFIER']).toBe(id);
    },
  );

  it('the appex bundle id is prefixed by the container’s, as an embedded extension’s must be', () => {
    expect(APPEX_ID.startsWith(`${APP_ID}.`)).toBe(true);
  });

  it.each([
    ['ContextMintBridgeMac', 'ContextMintBridgeExtensionMac'],
    ['ContextMintBridgeIOS', 'ContextMintBridgeExtensionIOS'],
  ])('%s embeds %s', (app, appex) => {
    expect(targets[app]?.dependencies).toEqual([{ target: appex, embed: true }]);
  });

  it('targets macOS 27 and iOS 27', () => {
    expect(project.options.deploymentTarget).toEqual({ macOS: '27.0', iOS: '27.0' });
  });

  it.each(MACS)('$name is Apple silicon only, like the rest of the fleet', ({ name }) => {
    expect(settingsOf(name)['ARCHS']).toBe('arm64');
  });

  it('every app and appex shows "ContextMint Bridge"', () => {
    for (const { name } of TARGETS) {
      expect(targets[name]?.info?.properties['CFBundleDisplayName'], name).toBe(
        'ContextMint Bridge',
      );
    }
  });
});

describe('apple/project.yml: versions', () => {
  const pkg = JSON.parse(read('package.json')) as { version: string };

  it('MARKETING_VERSION is the release version, on a line release-please rewrites', () => {
    expect(project.settings.base['MARKETING_VERSION']).toBe(pkg.version);
    const line = projectText.split('\n').find((l) => /^\s*MARKETING_VERSION:/.test(l));
    expect(line).toMatch(/# x-release-please-version\s*$/);
  });

  it('only the MARKETING_VERSION line carries the marker, never the build number', () => {
    const marked = projectText
      .split('\n')
      .filter((l) => /x-release-please/.test(l) && !/^\s*#/.test(l));
    expect(marked).toHaveLength(1);
    expect(project.settings.base['CURRENT_PROJECT_VERSION']).toBe('1');
  });

  it.each(TARGETS)('$name restates the project’s version pair, never its own', ({ name }) => {
    const props = targets[name]?.info?.properties ?? {};
    expect(props['CFBundleShortVersionString']).toBe('$(MARKETING_VERSION)');
    expect(props['CFBundleVersion']).toBe('$(CURRENT_PROJECT_VERSION)');
    expect(settingsOf(name)['MARKETING_VERSION']).toBeUndefined();
    expect(settingsOf(name)['CURRENT_PROJECT_VERSION']).toBeUndefined();
  });
});

describe('apple/project.yml: signing', () => {
  it.each(TARGETS)('$name is unsigned unless a signed build asks', ({ name }) => {
    expect(settingsOf(name)['CODE_SIGNING_ALLOWED']).toBe('NO');
  });

  const PROFILE_VARS = {
    ContextMintBridgeMac: 'MAC_APP_PROFILE',
    ContextMintBridgeExtensionMac: 'MAC_EXTENSION_PROFILE',
    ContextMintBridgeIOS: 'IOS_APP_PROFILE',
    ContextMintBridgeExtensionIOS: 'IOS_EXTENSION_PROFILE',
  } as const;

  it.each(TARGETS)('$name reads its profile from a variable of its own', ({ name }) => {
    const variable = PROFILE_VARS[name];
    expect(settingsOf(name)['PROVISIONING_PROFILE_SPECIFIER']).toBe(`$(${variable})`);
    expect(project.settings.base[variable]).toBe('');
  });

  it('never asks Xcode to provision on its own', () => {
    const code = projectText
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/allowProvisioningUpdates|ProvisioningUpdates/);
    expect(project.settings.base['CODE_SIGN_STYLE']).toBe('Manual');
    for (const { name } of TARGETS)
      expect(settingsOf(name)['CODE_SIGN_STYLE'], name).not.toBe('Automatic');
  });
});

describe('apple/: entitlements (D2: the App Sandbox on macOS, nothing else anywhere)', () => {
  const SANDBOX_ONLY = ['com.apple.security.app-sandbox'];

  it.each(MACS)('$name signs with the sandbox and nothing more', ({ name }) => {
    const path = settingsOf(name)['CODE_SIGN_ENTITLEMENTS'];
    expect(typeof path).toBe('string');
    const plist = readFileSync(join(APPLE, path as string), 'utf8');
    const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(keys).toEqual(SANDBOX_ONLY);
    expect(plist).toMatch(/<key>com\.apple\.security\.app-sandbox<\/key>\s*<true\/>/);
  });

  it('the iOS targets carry no entitlements', () => {
    for (const name of ['ContextMintBridgeIOS', 'ContextMintBridgeExtensionIOS']) {
      expect(settingsOf(name)['CODE_SIGN_ENTITLEMENTS'], name).toBeUndefined();
    }
  });

  it('no App Group, keychain group or network entitlement anywhere under apple/', () => {
    const all = readdirSync(APPLE, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.entitlements'))
      .map((d) => readFileSync(join(d.parentPath, d.name), 'utf8'))
      .join('\n');
    expect(all).not.toMatch(
      /application-groups|keychain-access-groups|network\.client|network\.server/,
    );
  });
});

describe('apple/project.yml: App Store keys', () => {
  it.each(APPS)('$name declares no non-exempt encryption (TLS and WebCrypto only)', ({ name }) => {
    expect(targets[name]?.info?.properties['ITSAppUsesNonExemptEncryption']).toBe(false);
  });

  it('the Mac app declares a category (the Mac App Store refuses an upload without one)', () => {
    expect(targets['ContextMintBridgeMac']?.info?.properties['LSApplicationCategoryType']).toMatch(
      /^public\.app-category\./,
    );
  });
});

describe('apple/: the appex', () => {
  it.each(APPEXES)('$name is a Safari web extension with the handler stub', ({ name }) => {
    const ext = targets[name]?.info?.properties['NSExtension'] as Record<string, unknown>;
    expect(ext['NSExtensionPointIdentifier']).toBe('com.apple.Safari.web-extension');
    expect(ext['NSExtensionPrincipalClass']).toBe(
      '$(PRODUCT_MODULE_NAME).SafariWebExtensionHandler',
    );
  });

  it.each(APPEXES)('$name stages the extension from this tree on every build', ({ name }) => {
    const phases = targets[name]?.preBuildScripts ?? [];
    expect(phases).toHaveLength(1);
    expect(phases[0]?.script).toContain('tools/stage-extension.sh');
    expect(phases[0]?.basedOnDependencyAnalysis).toBe(false);
  });

  it('the handler answers nothing, and says why', () => {
    const swift = read('apple/Extension/SafariWebExtensionHandler.swift');
    expect(swift).toMatch(/class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling/);
    expect(swift).toMatch(/completeRequest\(returningItems: (nil|\[\])/);
    expect(swift).not.toMatch(/SFExtensionMessageKey/);
    expect(swift).toMatch(/nativeMessaging/);
  });

  it('the stage script is executable, as the phase runs it directly', () => {
    expect(statSync(join(APPLE, 'tools', 'stage-extension.sh')).mode & 0o111).not.toBe(0);
  });
});

describe('apple/: privacy manifests (one in each of the four products)', () => {
  it.each(TARGETS)('$name builds a PrivacyInfo.xcprivacy into its product', ({ name }) => {
    const manifests = sourceFiles(name).filter((f) => f.endsWith('PrivacyInfo.xcprivacy'));
    expect(manifests).toHaveLength(1);
  });

  const manifests = [
    ...new Set(
      TARGETS.flatMap(({ name }) => sourceFiles(name)).filter((f) =>
        f.endsWith('PrivacyInfo.xcprivacy'),
      ),
    ),
  ];

  it.each(manifests)('%s: no tracking, no collected data, no required-reason APIs', (file) => {
    const plist = readFileSync(join(APPLE, file), 'utf8');
    expect(plist).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/);
    expect(plist).toMatch(/<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\/>/);
    expect(plist).toMatch(/<key>NSPrivacyAccessedAPITypes<\/key>\s*<array\/>/);
  });

  it('no Swift under apple/ reaches a required-reason API the manifests would have to declare', () => {
    const swift = readdirSync(APPLE, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.swift'))
      .map((d) => readFileSync(join(d.parentPath, d.name), 'utf8'))
      .join('\n');
    expect(swift).not.toMatch(
      /UserDefaults|@AppStorage|systemUptime|mach_absolute_time|creationDate|modificationDate|volumeAvailableCapacity|activeInputModes/,
    );
  });
});

describe('apple/: the container screen (Task 1 step 4)', () => {
  const swift = [...new Set(APPS.flatMap(({ name }) => sourceFiles(name)))]
    .filter((f) => f.endsWith('.swift'))
    .map((f) => readFileSync(join(APPLE, f), 'utf8'))
    .join('\n');

  it('names the appex by its real bundle id', () => {
    expect(swift).toContain(`"${APPEX_ID}"`);
  });

  it('macOS: reads the live state and opens Safari’s extension settings', () => {
    expect(swift).toMatch(/SFSafariExtensionManager\.stateOfSafariExtension\(/);
    expect(swift).toMatch(/SFSafariApplication\.showPreferencesForExtension\(/);
  });

  it('iOS: opens Safari’s extension settings for this extension', () => {
    expect(swift).toMatch(/SFSafariSettings\.openExtensionsSettings\(/);
  });

  it('links the privacy policy and tells the person to Connect from the popup', () => {
    expect(swift).toContain(
      'https://github.com/nullnet-app/contextmint-bridge/blob/main/docs/PRIVACY.md',
    );
    expect(swift).toMatch(/choose Connect/);
  });

  it('has no network, accounts or analytics', () => {
    expect(swift).not.toMatch(/URLSession|URLRequest|WKWebView|Analytics|NWConnection/);
  });
});

describe('apple/: the generated project is not checked in', () => {
  it('.gitignore covers the .xcodeproj and the generated Info.plists', () => {
    const ignore = read('apple/.gitignore');
    expect(ignore).toMatch(/^\*\.xcodeproj\/?$/m);
    expect(ignore).toMatch(/^Support\/?$/m);
  });

  it('every info.path lives in the ignored Support/', () => {
    for (const { name } of TARGETS) expect(targets[name]?.info?.path, name).toMatch(/^Support\//);
  });
});

describe('apple/: the app icon (Task 1 step 7)', () => {
  /**
   * Both apps compile the one `App/Assets.xcassets`, so one AppIcon set holds
   * both platforms' icons: iOS's single 1024 and macOS's ten sizes. The
   * masters are chrischall/nullnet-design-system's, copied in byte for byte
   * (CLAUDE.md §Icons): `contextmint-bridge-icon-1024.png` (opaque, square:
   * iOS applies its own mask) and `contextmint-bridge-icon-macos-1024.png`
   * (the tile on Apple's macOS grid, transparent margin). The smaller macOS
   * sizes are `apple/tools/make-app-icons.sh`'s downscales of that master.
   */
  const SET = join(APPLE, 'App', 'Assets.xcassets', 'AppIcon.appiconset');
  const sha256 = (file: string): string =>
    createHash('sha256')
      .update(readFileSync(join(SET, file)))
      .digest('hex');
  /** Width, height and PNG colour type, from the IHDR chunk. */
  const png = (file: string): { width: number; height: number; colourType: number } => {
    const bytes = readFileSync(join(SET, file));
    expect(bytes.subarray(1, 4).toString('latin1'), file).toBe('PNG');
    expect(bytes.subarray(12, 16).toString('latin1'), file).toBe('IHDR');
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      colourType: bytes.readUInt8(25),
    };
  };

  // nullnet-design-system main @ 601a30a (PR #33), system/assets/.
  const IOS_MASTER_SHA256 = '46ceb4bddea022f7c153e304baa7d3ffbcdc98a0d0913695a5e007ff437c1a31';
  const MAC_MASTER_SHA256 = '9c16ab0e178eef862d33bb1a1b04cc5ac3d5d9e382523e371e68ecf8e33384ed';

  const MAC_SIZES = [16, 32, 128, 256, 512].flatMap((points) => [
    { file: `icon_${points}x${points}.png`, size: `${points}x${points}`, scale: '1x', px: points },
    {
      file: `icon_${points}x${points}@2x.png`,
      size: `${points}x${points}`,
      scale: '2x',
      px: points * 2,
    },
  ]);

  interface IconEntry {
    filename?: string;
    idiom: string;
    platform?: string;
    size: string;
    scale?: string;
  }
  const contents = JSON.parse(readFileSync(join(SET, 'Contents.json'), 'utf8')) as {
    images: IconEntry[];
  };

  it.each(APPS)('$name builds the AppIcon set', ({ name }) => {
    expect(settingsOf(name)['ASSETCATALOG_COMPILER_APPICON_NAME']).toBe('AppIcon');
    expect(sourcePaths(name)).toContain('App');
  });

  it('iOS: one universal 1024, the design system’s opaque master byte for byte', () => {
    const ios = contents.images.filter((i) => i.platform === 'ios');
    expect(ios).toEqual([
      { filename: 'icon-ios-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
    ]);
    expect(sha256('icon-ios-1024.png')).toBe(IOS_MASTER_SHA256);
    // App Store Connect rejects an iOS icon with an alpha channel, after the upload.
    expect(png('icon-ios-1024.png')).toEqual({ width: 1024, height: 1024, colourType: 2 });
  });

  it('macOS: all ten sizes, each the pixel size its slot asks for', () => {
    const mac = contents.images.filter((i) => i.idiom === 'mac');
    expect(mac).toEqual(
      MAC_SIZES.map(({ file, size, scale }) => ({ filename: file, idiom: 'mac', scale, size })),
    );
    for (const { file, px } of MAC_SIZES) {
      const { width, height } = png(file);
      expect([width, height], file).toEqual([px, px]);
    }
  });

  it('macOS: the 512@2x slot is the design system’s macOS master byte for byte', () => {
    expect(sha256('icon_512x512@2x.png')).toBe(MAC_MASTER_SHA256);
  });

  it('the set holds nothing but the icons it names', () => {
    const named = contents.images.map((i) => i.filename).sort();
    expect(contents.images).toHaveLength(1 + MAC_SIZES.length);
    expect(
      readdirSync(SET)
        .filter((f) => f !== 'Contents.json')
        .sort(),
    ).toEqual(named);
  });
});
