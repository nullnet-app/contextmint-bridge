/**
 * What `.github/workflows/deploy-safari-app.yml` refuses to sign or upload
 * without, said precisely. Plan
 * docs/superpowers/plans/2026-10-05-safari-extension-standalone.md, Task 5.
 *
 * The TestFlight jobs need things no commit in this repo can create: an App
 * Store Connect record, App Store provisioning profiles and the org's signing
 * certificates. Only the owner makes those (the plan's O1–O4). Until every one
 * exists a job must FAIL, early, naming EVERY missing item at once (an owner
 * fixing the list needs one re-run, not one per item), rather than half-work:
 * an archive signed against the wrong profile, or an upload whose versions
 * App Store Connect refuses after the archive.
 *
 * Ported from nullnet-app/mcp-host-app `tools/mac_testflight_preflight.py`,
 * for both platforms, without its bridge pin (the extension is built from this
 * tree) and without its App Group / keychain / associated-domains checks (plan
 * D2: these App IDs have no capabilities at all).
 *
 * Run by the workflow with node's own TypeScript support, one mode per point
 * in a job:
 *
 * - `tag`: before anything else, the release tag is `v` + MARKETING_VERSION.
 * - `account`: after asc's key is configured, BEFORE any certificate is
 *   decoded onto the runner. Reads what asc printed (the app record, its App
 *   Store version for the platform, the App Store profiles with their bundle ids
 *   and certificates included) and whether the certificate secrets are set.
 * - `signing`: after the certificates are imported and both profiles
 *   downloaded and decoded (`security cms -D`). The job keychain holds this
 *   team's Apple Distribution identity (and a Mac installer identity on
 *   macOS), and each profile is a distribution profile for the right App ID on
 *   the right platform, bound to the certificate that was imported.
 * - `archive`: after the archive, before export and upload. The app, the
 *   appex and the appex's manifest.json carry one version, the build number is
 *   this run's, and the app carries the AppIcon.
 *
 * Tested by tests/apple-testflight-preflight.test.ts.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export const TEAM_ID = '5A673K24X6';
export const APP_BUNDLE_ID = 'app.nullnet.contextmint.bridge';
export const APPEX_BUNDLE_ID = 'app.nullnet.contextmint.bridge.extension';
const WHERE =
  'docs/superpowers/plans/2026-10-05-safari-extension-standalone.md, "Owner steps" O1–O4';

export type Platform = 'ios' | 'macos';

interface PlatformSpec {
  label: string;
  /** App Store Connect's platform, for `asc versions list --platform`. */
  ascPlatform: 'IOS' | 'MAC_OS';
  profileType: 'IOS_APP_STORE' | 'MAC_APP_STORE';
  /** The value a decoded profile's `Platform` array carries. */
  profilePlatform: string;
  /** The entitlement that names the App ID in a decoded profile. */
  appIdEntitlement: string;
  /** By EXACT name, as the workflow asks Xcode and the export for them. */
  appProfile: string;
  extensionProfile: string;
}

/**
 * The profile names (plan O3). The macOS app's is "ContextMint Bridge App Mac
 * App Store", not the plan's "ContextMint Bridge Mac App Store": that name
 * already belongs to the appex ContextMint for Mac embeds today
 * (app.nullnet.mcphost.bridge, nullnet-app/mcp-host-app), and must not be
 * touched until Task 7 removes it.
 */
export const PLATFORMS: Record<Platform, PlatformSpec> = {
  ios: {
    label: 'iOS',
    ascPlatform: 'IOS',
    profileType: 'IOS_APP_STORE',
    profilePlatform: 'iOS',
    appIdEntitlement: 'application-identifier',
    appProfile: 'ContextMint Bridge iOS App Store',
    extensionProfile: 'ContextMint Bridge Extension iOS App Store',
  },
  macos: {
    label: 'macOS',
    ascPlatform: 'MAC_OS',
    profileType: 'MAC_APP_STORE',
    profilePlatform: 'OSX',
    appIdEntitlement: 'com.apple.application-identifier',
    appProfile: 'ContextMint Bridge App Mac App Store',
    extensionProfile: 'ContextMint Bridge Extension Mac App Store',
  },
};

// ---------------------------------------------------------------------------
// account

interface Resource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: unknown }>;
}
interface Document {
  data?: Resource[];
  included?: Resource[];
}

const rows = (doc: unknown): Resource[] => {
  const data = (doc as Document | null)?.data;
  return Array.isArray(data) ? data : [];
};

function createProfileCommand(spec: PlatformSpec, name: string, bundleId: string): string {
  // `bundle-ids list --identifier` PREFIX-matches (the app's id also returns
  // the appex's), so the id is selected by the exact identifier.
  const lookup =
    `asc --profile Nullnet bundle-ids list --identifier ${bundleId} --output json ` +
    `| jq -r --arg i ${bundleId} '.data[] | select(.attributes.identifier == $i) | .id'`;
  return (
    `asc --profile Nullnet profiles create --name "${name}" --profile-type ${spec.profileType} ` +
    `--bundle "$(${lookup})" --certificate <the Apple Distribution certificate DIST_CERT_P12_B64 holds>`
  );
}

function profileProblems(
  spec: PlatformSpec,
  doc: unknown,
): { problems: string[]; ids: Record<string, string> } {
  const included = (doc as Document | null)?.included ?? [];
  const bundleOf = new Map(
    included
      .filter((r) => r.type === 'bundleIds')
      .map((r) => [r.id, r.attributes?.['identifier'] as string | undefined]),
  );
  const certType = new Map(
    included
      .filter((r) => r.type === 'certificates')
      .map((r) => [r.id, r.attributes?.['certificateType'] as string | undefined]),
  );

  const problems: string[] = [];
  const ids: Record<string, string> = {};
  const wanted = [
    { key: 'app_profile_id', name: spec.appProfile, bundleId: APP_BUNDLE_ID },
    { key: 'extension_profile_id', name: spec.extensionProfile, bundleId: APPEX_BUNDLE_ID },
  ];
  for (const { key, name, bundleId } of wanted) {
    const row = rows(doc).find((r) => r.attributes?.['name'] === name);
    if (!row) {
      problems.push(
        `No ${spec.profileType} provisioning profile named "${name}" for ${bundleId} — create it: ` +
          createProfileCommand(spec, name, bundleId),
      );
      continue;
    }
    const faults: string[] = [];
    const state = row.attributes?.['profileState'];
    if (state !== 'ACTIVE') faults.push(`is ${String(state)}`);
    const bundleRef = (row.relationships?.['bundleId']?.data as { id?: string } | undefined)?.id;
    const actual = bundleOf.get(bundleRef);
    if (actual !== bundleId)
      faults.push(`is for ${actual ?? 'an unknown bundle id'}, not ${bundleId}`);
    const certs = row.relationships?.['certificates']?.data;
    const certIds = Array.isArray(certs) ? certs.map((c: { id?: string }) => c.id) : [];
    if (!certIds.some((c) => certType.get(c) === 'DISTRIBUTION')) {
      faults.push('is not bound to an Apple Distribution certificate (DISTRIBUTION)');
    }
    if (faults.length > 0) {
      problems.push(
        `The ${spec.profileType} profile "${name}" (${String(row.id)}) ${faults.join('; ')} — delete it ` +
          `(asc --profile Nullnet profiles delete --id ${String(row.id)} --confirm; Apple refuses a second ` +
          `profile with the same name) and create it again: ${createProfileCommand(spec, name, bundleId)}`,
      );
      continue;
    }
    ids[key] = String(row.id);
  }
  return { problems, ids };
}

export interface AccountInput {
  platform: Platform;
  apps: unknown;
  versions: unknown;
  profiles: unknown;
  distSecret: boolean;
  /** macOS only: the installer certificate that signs the .pkg. */
  installerSecret: boolean;
}

/** Every owner-side item the upload still lacks, and the ids it resolved. */
export function accountProblems(input: AccountInput): {
  problems: string[];
  resolved: Record<string, string>;
} {
  const spec = PLATFORMS[input.platform];
  const problems: string[] = [];
  const resolved: Record<string, string> = {};

  const app = rows(input.apps)[0];
  if (!app?.id) {
    problems.push(
      `No App Store Connect app record for ${APP_BUNDLE_ID} — create "ContextMint Bridge" in App Store ` +
        'Connect (plan O2; there is no API for it)',
    );
  } else {
    resolved['app_id'] = app.id;
    if (rows(input.versions).length === 0) {
      problems.push(
        `The App Store Connect app ${app.id} (${APP_BUNDLE_ID}) has no ${spec.label} platform — App Store ` +
          `Connect → the app → Add Platform → ${spec.label}; TestFlight uploads for ${spec.label} attach to it`,
      );
    }
  }

  const profiles = profileProblems(spec, input.profiles);
  problems.push(...profiles.problems);
  Object.assign(resolved, profiles.ids);

  if (!input.distSecret) {
    problems.push(
      'The org secrets DIST_CERT_P12_B64 / DIST_CERT_PASSWORD (the Apple Distribution .p12) are empty or ' +
        'not visible to this repo',
    );
  }
  if (input.platform === 'macos' && !input.installerSecret) {
    problems.push(
      'The org secrets MAC_INSTALLER_CERT_P12_B64 / MAC_INSTALLER_CERT_PASSWORD (the Mac App Store installer ' +
        'certificate, private key included, which signs the .pkg) are empty or not visible to this repo',
    );
  }
  return { problems, resolved };
}

// ---------------------------------------------------------------------------
// signing

/** `security find-identity -v <keychain>`: `  1) <SHA-1> "Apple Distribution: Name (TEAM)"`. */
const IDENTITY = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/gm;
/** The Mac App Store installer certificate, under both names Apple has issued it with. */
const INSTALLER_PREFIXES = ['3rd Party Mac Developer Installer:', 'Mac Installer Distribution:'];

const ourIdentities = (findIdentity: string): { sha: string; name: string }[] =>
  [...findIdentity.matchAll(IDENTITY)]
    .map((m) => ({ sha: m[1] ?? '', name: m[2] ?? '' }))
    .filter(({ name }) => name.endsWith(`(${TEAM_ID})`));

/**
 * The installer name this team's identity in the keychain carries. The export's
 * `installerSigningCertificate` must be that name: exportArchive matches by
 * name, and asking for the other one finds nothing.
 */
export function installerSelector(findIdentity: string): string | undefined {
  for (const prefix of INSTALLER_PREFIXES) {
    if (ourIdentities(findIdentity).some(({ name }) => name.startsWith(prefix))) {
      return prefix.slice(0, -1);
    }
  }
  return undefined;
}

export type Plist =
  string | number | boolean | Date | Uint8Array | Plist[] | { [key: string]: Plist };

/**
 * A minimal XML property-list reader: enough for what `security cms -D` prints
 * for a provisioning profile (dict, array, string, data, date, integer, real,
 * true, false). No dependency, so the runner needs nothing beyond node.
 */
export function parsePlist(xml: string): Plist {
  const tokens = [...xml.matchAll(/<(\/?)([A-Za-z]+)(?:\s[^>]*?)?\s*(\/?)>|([^<]+)/g)].filter(
    (m) => m[4] === undefined || m[4].trim() !== '',
  );
  let i = 0;
  const next = (): RegExpMatchArray => {
    const t = tokens[i++];
    if (!t) throw new Error('truncated plist');
    return t;
  };
  const decode = (s: string): string =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  /** The text of a simple element whose open tag was just read. */
  const text = (tag: string): string => {
    let body = '';
    for (;;) {
      const t = next();
      if (t[4] !== undefined) body += t[4];
      else if (t[1] === '/' && t[2] === tag) return decode(body);
      else throw new Error(`unexpected <${t[1]}${t[2]}> in <${tag}>`);
    }
  };
  const value = (open: RegExpMatchArray): Plist => {
    const tag = open[2] ?? '';
    const selfClosing = open[3] === '/';
    switch (tag) {
      case 'true':
      case 'false':
        if (!selfClosing) text(tag);
        return tag === 'true';
      case 'string':
        return selfClosing ? '' : text(tag);
      case 'integer':
      case 'real':
        return Number(text(tag));
      case 'date':
        return new Date(text(tag));
      case 'data':
        return selfClosing
          ? new Uint8Array()
          : Buffer.from(text(tag).replace(/\s+/g, ''), 'base64');
      case 'array': {
        const out: Plist[] = [];
        if (selfClosing) return out;
        for (;;) {
          const t = next();
          if (t[1] === '/' && t[2] === 'array') return out;
          out.push(value(t));
        }
      }
      case 'dict': {
        const out: { [key: string]: Plist } = {};
        if (selfClosing) return out;
        for (;;) {
          const t = next();
          if (t[1] === '/' && t[2] === 'dict') return out;
          if (t[2] !== 'key') throw new Error(`expected <key> in <dict>, got <${t[2]}>`);
          const key = text('key');
          out[key] = value(next());
        }
      }
      default:
        throw new Error(`unsupported plist element <${tag}>`);
    }
  };
  for (;;) {
    const t = next();
    if (t[4] !== undefined || t[1] === '/') continue;
    // Skip the <?xml?> / <!DOCTYPE> prologue (not matched as tags) and <plist>.
    if (t[2] === 'plist') return value(next());
  }
}

const asDict = (v: Plist | undefined): { [key: string]: Plist } =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  !(v instanceof Uint8Array)
    ? v
    : {};
const asArray = (v: Plist | undefined): Plist[] => (Array.isArray(v) ? v : []);

/** Is this decoded profile the App Store profile the target signs with? */
export function decodedProfileProblems(
  profile: Plist,
  opts: { platform: Platform; name: string; bundleId: string; distSha1s: Set<string> },
): string[] {
  const spec = PLATFORMS[opts.platform];
  const p = asDict(profile);
  const said = `Profile "${opts.name}"`;
  const problems: string[] = [];
  if (p['Name'] !== opts.name) {
    problems.push(`${said} downloaded as a profile named "${String(p['Name'])}"`);
  }
  const platforms = asArray(p['Platform']);
  if (!platforms.includes(spec.profilePlatform)) {
    problems.push(
      `${said} is not a ${spec.label} profile (Platform ${JSON.stringify(platforms)}) — it must be ${spec.profileType}`,
    );
  }
  if (asArray(p['ProvisionedDevices']).length > 0) {
    problems.push(
      `${said} lists devices, so it is a development profile — the upload needs ${spec.profileType}`,
    );
  }
  const entitlements = asDict(p['Entitlements']);
  const wantedId = `${TEAM_ID}.${opts.bundleId}`;
  if (entitlements[spec.appIdEntitlement] !== wantedId) {
    problems.push(`${said} is for ${String(entitlements[spec.appIdEntitlement])}, not ${wantedId}`);
  }
  if (entitlements['get-task-allow'] === true) {
    problems.push(`${said} allows debugging (get-task-allow), so it is a development profile`);
  }
  const bound = new Set(
    asArray(p['DeveloperCertificates'])
      .filter((d): d is Uint8Array => d instanceof Uint8Array)
      .map((der) => createHash('sha1').update(der).digest('hex').toUpperCase()),
  );
  if (opts.distSha1s.size > 0 && ![...bound].some((sha) => opts.distSha1s.has(sha))) {
    problems.push(
      `${said} is not bound to the Apple Distribution certificate DIST_CERT_P12_B64 imported — recreate it ` +
        'with that certificate',
    );
  }
  return problems;
}

export interface SigningInput {
  platform: Platform;
  identities: string;
  appProfile: Plist;
  extensionProfile: Plist;
}

export function signingProblems(input: SigningInput): {
  problems: string[];
  installer: string | undefined;
} {
  const spec = PLATFORMS[input.platform];
  const ours = ourIdentities(input.identities);
  const dist = new Set(
    ours.filter(({ name }) => name.startsWith('Apple Distribution:')).map(({ sha }) => sha),
  );
  const problems: string[] = [];
  if (dist.size === 0) {
    problems.push(
      `No Apple Distribution identity for team ${TEAM_ID} in the job keychain — DIST_CERT_P12_B64 / ` +
        'DIST_CERT_PASSWORD did not import one (it signs the app and the appex)',
    );
  }
  const installer = input.platform === 'macos' ? installerSelector(input.identities) : undefined;
  if (input.platform === 'macos' && !installer) {
    problems.push(
      `No Mac installer identity ("3rd Party Mac Developer Installer" / "Mac Installer Distribution") for ` +
        `team ${TEAM_ID} in the job keychain — MAC_INSTALLER_CERT_P12_B64 / MAC_INSTALLER_CERT_PASSWORD must ` +
        'hold it WITH its private key; without it the .pkg cannot be signed',
    );
  }
  problems.push(
    ...decodedProfileProblems(input.appProfile, {
      platform: input.platform,
      name: spec.appProfile,
      bundleId: APP_BUNDLE_ID,
      distSha1s: dist,
    }),
    ...decodedProfileProblems(input.extensionProfile, {
      platform: input.platform,
      name: spec.extensionProfile,
      bundleId: APPEX_BUNDLE_ID,
      distSha1s: dist,
    }),
  );
  return { problems, installer };
}

// ---------------------------------------------------------------------------
// tag and archive: one version everywhere (plan Task 5, "Version guard")

export interface TagInput {
  event: string;
  refType: string;
  refName: string;
  marketing: string;
}

/**
 * The release tag is `v` + MARKETING_VERSION. A tag push must be a tag; a
 * dispatch from a tag is held to the same rule; a dispatch from a branch (main,
 * the build_number override path) has no tag to compare, and the archive check
 * still holds the manifest to MARKETING_VERSION.
 */
export function tagProblems(input: TagInput): string[] {
  if (!/^\d+\.\d+\.\d+$/.test(input.marketing)) {
    return [
      `apple/project.yml MARKETING_VERSION is "${input.marketing}", not a release version X.Y.Z`,
    ];
  }
  if (input.event === 'push' && input.refType !== 'tag') {
    return [
      `A push of ${input.refType} ${input.refName} is not a release tag; this workflow ships tags only`,
    ];
  }
  if (input.refType === 'tag' && input.refName !== `v${input.marketing}`) {
    return [
      `The tag ${input.refName} is not v${input.marketing}, apple/project.yml's MARKETING_VERSION — ` +
        'refusing to upload a build whose version disagrees with its release',
    ];
  }
  return [];
}

export interface ArchiveInput {
  platform: Platform;
  marketing: string;
  build: string;
  /** The archived app's and appex's Info.plist, as JSON (`plutil -convert json`). */
  appInfo: Record<string, unknown>;
  appexInfo: Record<string, unknown>;
  /** The archived appex's manifest.json. */
  manifest: Record<string, unknown>;
}

export function archiveProblems(input: ArchiveInput): string[] {
  const problems: string[] = [];
  const check = (what: string, actual: unknown, wanted: string): void => {
    if (actual !== wanted)
      problems.push(`${what} is ${JSON.stringify(actual)}, expected "${wanted}"`);
  };
  check('The app CFBundleIdentifier', input.appInfo['CFBundleIdentifier'], APP_BUNDLE_ID);
  check('The appex CFBundleIdentifier', input.appexInfo['CFBundleIdentifier'], APPEX_BUNDLE_ID);
  check(
    'The app CFBundleShortVersionString',
    input.appInfo['CFBundleShortVersionString'],
    input.marketing,
  );
  check(
    'The appex CFBundleShortVersionString',
    input.appexInfo['CFBundleShortVersionString'],
    input.marketing,
  );
  check("The appex's manifest.json version", input.manifest['version'], input.marketing);
  check('The app CFBundleVersion', input.appInfo['CFBundleVersion'], input.build);
  check('The appex CFBundleVersion', input.appexInfo['CFBundleVersion'], input.build);
  // actool writes the icon's name into the app's Info.plist only when the
  // AppIcon set compiled; App Store Connect refuses an app without one.
  const icons = input.appInfo['CFBundleIcons'] as
    { CFBundlePrimaryIcon?: { CFBundleIconName?: unknown } } | undefined;
  const iconName =
    input.appInfo['CFBundleIconName'] ?? icons?.CFBundlePrimaryIcon?.CFBundleIconName;
  check('The app icon (CFBundleIconName)', iconName, 'AppIcon');
  return problems;
}

// ---------------------------------------------------------------------------
// CLI

const readJson = (path: string | undefined): unknown => {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
};
const flag = (value: string | undefined): boolean =>
  ['true', 'yes', '1'].includes((value ?? '').trim().toLowerCase());

function fail(platform: Platform | undefined, items: string[]): number {
  // One annotation per item: the run's summary lists each on its own.
  for (const item of items) console.log(`::error::${item}`);
  const label = platform ? PLATFORMS[platform].label : 'The';
  console.log(
    `\n${label} TestFlight upload is missing ${items.length} item(s), listed above. Nothing was ` +
      `uploaded. The owner-side steps are in ${WHERE}.`,
  );
  return 1;
}

function writeOutputs(path: string | undefined, outputs: Record<string, string>): void {
  if (!path) return;
  appendFileSync(
    path,
    Object.entries(outputs)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(''),
  );
}

export function main(argv: string[]): number {
  const [mode, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      platform: { type: 'string' },
      apps: { type: 'string' },
      versions: { type: 'string' },
      profiles: { type: 'string' },
      'dist-secret': { type: 'string' },
      'installer-secret': { type: 'string' },
      identities: { type: 'string' },
      'app-profile': { type: 'string' },
      'extension-profile': { type: 'string' },
      event: { type: 'string' },
      'ref-type': { type: 'string' },
      'ref-name': { type: 'string' },
      marketing: { type: 'string' },
      build: { type: 'string' },
      'app-info': { type: 'string' },
      'appex-info': { type: 'string' },
      manifest: { type: 'string' },
      'github-output': { type: 'string' },
    },
  });
  const platform = values.platform as Platform | undefined;
  if (mode !== 'tag' && (platform === undefined || !(platform in PLATFORMS))) {
    console.error(`--platform must be ios or macos, got ${String(platform)}`);
    return 2;
  }
  switch (mode) {
    case 'tag': {
      const problems = tagProblems({
        event: values.event ?? '',
        refType: values['ref-type'] ?? '',
        refName: values['ref-name'] ?? '',
        marketing: values.marketing ?? '',
      });
      if (problems.length > 0) return fail(undefined, problems);
      console.log(
        `Releasing ${values.marketing ?? ''} from ${values['ref-type'] ?? ''} ${values['ref-name'] ?? ''}.`,
      );
      return 0;
    }
    case 'account': {
      const { problems, resolved } = accountProblems({
        platform: platform as Platform,
        apps: readJson(values.apps),
        versions: readJson(values.versions),
        profiles: readJson(values.profiles),
        distSecret: flag(values['dist-secret']),
        installerSecret: flag(values['installer-secret']),
      });
      if (problems.length > 0) return fail(platform, problems);
      writeOutputs(values['github-output'], resolved);
      console.log(
        'TestFlight prerequisites present: ' +
          Object.entries(resolved)
            .map(([k, v]) => `${k}=${v}`)
            .join(', '),
      );
      return 0;
    }
    case 'signing': {
      const { problems, installer } = signingProblems({
        platform: platform as Platform,
        identities: readFileSync(values.identities ?? '', 'utf8'),
        appProfile: parsePlist(readFileSync(values['app-profile'] ?? '', 'utf8')),
        extensionProfile: parsePlist(readFileSync(values['extension-profile'] ?? '', 'utf8')),
      });
      if (problems.length > 0) return fail(platform, problems);
      if (installer) writeOutputs(values['github-output'], { installer_identity: installer });
      console.log('Signing identities and both App Store profiles match.');
      return 0;
    }
    case 'archive': {
      const problems = archiveProblems({
        platform: platform as Platform,
        marketing: values.marketing ?? '',
        build: values.build ?? '',
        appInfo: (readJson(values['app-info']) ?? {}) as Record<string, unknown>,
        appexInfo: (readJson(values['appex-info']) ?? {}) as Record<string, unknown>,
        manifest: (readJson(values.manifest) ?? {}) as Record<string, unknown>,
      });
      if (problems.length > 0) return fail(platform, problems);
      console.log(
        `The archive carries ${values.marketing ?? ''} (build ${values.build ?? ''}) in the app, the appex ` +
          'and its manifest.json, and the AppIcon.',
      );
      return 0;
    }
    default:
      console.error('usage: testflight-preflight.ts <tag|account|signing|archive> [options]');
      return 2;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
