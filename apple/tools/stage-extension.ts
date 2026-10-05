/**
 * Put the ContextMint Bridge Safari extension's web resources into the appex.
 *
 * Run by `stage-extension.sh` (the appex targets' pre-build phase in
 * `apple/project.yml`) after it has built `packages/extension-safari`, with
 * node's own TypeScript support — no tsx, no build step of its own. Tested by
 * `tests/apple-stage-extension.test.ts`.
 *
 * Safari loads `manifest.json`, and everything it names, from the appex's
 * resources folder: Xcode's `UNLOCALIZED_RESOURCES_FOLDER_PATH`, which has two
 * forms, the only two this writes into:
 *
 * - macOS: `<name>.appex/Contents/Resources/`, which holds resources only;
 * - iOS: `<name>.appex/` itself. An iOS bundle is FLAT, so the web resources sit
 *   beside the appex's executable, `Info.plist`, `_CodeSignature/` and
 *   `embedded.mobileprovision`; a resource of one of those names would replace
 *   the bundle's own, so it is refused by name.
 *
 * Either form refuses a `PrivacyInfo.xcprivacy` in `dist/`: the appex's privacy
 * manifest is its own (App Store review reads the appex as a binary of its own,
 * ITMS-91053).
 *
 * The rules are nullnet-app/mcp-host-app's `tools/fetch_bridge_resources.py`,
 * which staged this extension into ContextMint's embedded appex, without its
 * release download (the extension and this container are the same commit) and
 * without its `nativeMessaging` requirement (this extension talks to no app).
 * They are what Safari 27 was seen to do: a manifest that breaks one is an
 * extension whose toolbar icon may appear and which never runs, or an upload
 * App Store Connect refuses after the archive. One rule is new: the manifest's
 * `version` must be `MARKETING_VERSION`, because App Store validation requires
 * the container, the appex and the extension to carry one version.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';

/** Absent in Safari 27: a manifest asking for either is the Chrome build. */
const ABSENT_IN_SAFARI = ['downloads', 'tabGroups'];
/** The Safari every rule here was proven on; also the apps' OS floor. */
const SAFARI_FLOOR: [number, number] = [27, 0];
/** App Store Connect's limit on a Safari web extension's description (error 90849). */
const APP_STORE_DESCRIPTION_LIMIT = 112;

/** Names `dist/` may never bring to the top of the resources folder, compared case-insensitively. */
const RESERVED_EVERYWHERE = ['PrivacyInfo.xcprivacy'];
const RESERVED_IN_FLAT_APPEX = [
  ...RESERVED_EVERYWHERE,
  'Info.plist',
  '_CodeSignature',
  'embedded.mobileprovision',
  'SC_Info', // FairPlay, added to an App Store-distributed bundle
];

/** The files the previous run put into the resources folder, relative to it. */
const LEDGER = 'staged-extension-files.json';

class StageError extends Error {}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The top-level names `dist/` may not bring into `dest`, or a refusal when `dest` is no form of an appex. */
function reservedNames(dest: string, executable: string | undefined): string[] {
  const parent = dirname(dest);
  if (
    basename(dest) === 'Resources' &&
    basename(parent) === 'Contents' &&
    extname(dirname(parent)) === '.appex'
  ) {
    return RESERVED_EVERYWHERE;
  }
  if (extname(dest) === '.appex') {
    // Xcode's EXECUTABLE_NAME is the product name, which is the bundle's stem
    // by default; reserve both in case the two ever differ.
    const stem = basename(dest, '.appex');
    return [...new Set([...RESERVED_IN_FLAT_APPEX, ...(executable ? [executable] : []), stem])];
  }
  throw new StageError(
    `${dest}: refusing to stage into a folder that is not an appex's Contents/Resources (macOS) or a flat .appex (iOS)`,
  );
}

/** Every reason Safari or App Store Connect would refuse `dir`'s manifest; empty when there is none. */
function manifestProblems(dir: string, marketingVersion: string): string[] {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) {
    return [
      `no manifest.json at the root of ${dir} — Safari finds a web extension only by a manifest.json at the root of the appex's resources`,
    ];
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return [`${path} is not valid JSON (${(err as Error).message})`];
  }
  if (!isObject(manifest)) return [`${path} is not a JSON object`];

  const problems: string[] = [];

  if (manifest['version'] !== marketingVersion) {
    problems.push(
      `manifest.json says version ${JSON.stringify(manifest['version'])} and the project's MARKETING_VERSION is ` +
        `${marketingVersion} — App Store validation requires the container, the appex and the extension to carry ` +
        `one version (release-please moves both; was one edited by hand?)`,
    );
  }

  const background = manifest['background'];
  if (!isObject(background)) {
    problems.push(
      'has no "background" object; Safari needs {"scripts": ["background.js"], "persistent": false}',
    );
  } else {
    if ('service_worker' in background) {
      problems.push(
        'background declares "service_worker" — Safari 27 never runs a service-worker background; it must be ' +
          '{"scripts": [...], "persistent": false} (is this the Chrome build?)',
      );
    }
    if (background['type'] === 'module') {
      problems.push(
        'background declares "type": "module" — Safari runs only a CLASSIC (IIFE) event-page script (is this the Chrome build?)',
      );
    }
    const scripts = background['scripts'];
    if (
      !Array.isArray(scripts) ||
      scripts.length === 0 ||
      !scripts.every((s) => typeof s === 'string')
    ) {
      problems.push(
        'background has no "scripts" list — Safari runs the background only as an event page',
      );
    } else {
      for (const script of scripts as string[]) {
        if (!isFile(join(dir, script)))
          problems.push(`background script ${script} is named by the manifest and is not there`);
      }
    }
    if (background['persistent'] !== false) {
      problems.push(
        'background must say "persistent": false — Safari runs it only as a NON-PERSISTENT event page',
      );
    }
    const extra = Object.keys(background)
      .filter((k) => !['scripts', 'persistent', 'service_worker', 'type'].includes(k))
      .sort();
    if (extra.length)
      problems.push(
        `background carries keys Safari's event page does not take: ${extra.join(', ')}`,
      );
  }

  const permissions = Array.isArray(manifest['permissions'])
    ? (manifest['permissions'] as unknown[])
    : [];
  for (const absent of ABSENT_IN_SAFARI) {
    if (permissions.includes(absent)) {
      problems.push(
        `permissions asks for "${absent}", an API Safari does not have (is this the Chrome build?)`,
      );
    }
  }

  problems.push(
    ...iconProblems(manifest, dir),
    ...floorProblems(manifest),
    ...descriptionProblems(manifest),
  );
  return problems;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function iconProblems(manifest: Json, dir: string): string[] {
  const named: [string, unknown][] = [];
  const icons = manifest['icons'];
  if (isObject(icons))
    named.push(...Object.values(icons).map((p): [string, unknown] => ['icons', p]));
  const action = manifest['action'];
  const defaultIcon = isObject(action) ? action['default_icon'] : undefined;
  if (isObject(defaultIcon)) {
    named.push(
      ...Object.values(defaultIcon).map((p): [string, unknown] => ['action.default_icon', p]),
    );
  } else if (defaultIcon !== undefined) {
    named.push(['action.default_icon', defaultIcon]);
  }
  const problems: string[] = [];
  for (const [where, path] of named) {
    if (typeof path !== 'string' || !path.toLowerCase().endsWith('.png')) {
      problems.push(
        `${where} names ${JSON.stringify(path)}, which is not a PNG — Safari 27 silently drops the whole extension ` +
          'for an SVG toolbar icon (no longer in Settings → Extensions, no log line; contextmint-bridge#28)',
      );
    } else if (!isFile(join(dir, path))) {
      problems.push(`${where} names ${path}, and it is not there`);
    }
  }
  return problems;
}

function floorProblems(manifest: Json): string[] {
  const settings = manifest['browser_specific_settings'];
  const safari = isObject(settings) ? settings['safari'] : undefined;
  const floor = isObject(safari) ? safari['strict_min_version'] : undefined;
  const wanted = SAFARI_FLOOR.join('.');
  const refusal = (said: string): string[] => [
    `browser_specific_settings.safari.strict_min_version is ${said} — it must be "${wanted}" or later, the Safari this form was proven on`,
  ];
  if (typeof floor !== 'string') return refusal('missing');
  const match = /^(\d+)(?:\.(\d+))?(?:\.\d+)?$/.exec(floor);
  if (!match) return refusal(JSON.stringify(floor));
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  if (major < SAFARI_FLOOR[0] || (major === SAFARI_FLOOR[0] && minor < SAFARI_FLOOR[1])) {
    return refusal(JSON.stringify(floor));
  }
  return [];
}

function descriptionProblems(manifest: Json): string[] {
  const description = manifest['description'];
  const limit = APP_STORE_DESCRIPTION_LIMIT;
  if (typeof description !== 'string') {
    return [
      `"description" is missing or not a string — App Store Connect rejects the upload (error 90849) unless it is a string of ${limit} or fewer characters`,
    ];
  }
  if (description.length > limit) {
    return [
      `"description" is ${description.length} characters — App Store Connect rejects the upload (error 90849) over ${limit}; ` +
        'shorten it in packages/extension-chrome/manifest.json',
    ];
  }
  return [];
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)).split(sep).join('/'))
    .sort();
}

/**
 * Swap the previous run's files for this run's, touching nothing else.
 *
 * Not an emptying of the folder: the appex has a resource of its own (its
 * PrivacyInfo.xcprivacy), which Xcode's resources phase copies AFTER this one
 * and, on an incremental build, does not copy again — so emptying the folder
 * would ship the appex without it. The ledger is what still stops a file the
 * previous build staged from outliving it.
 */
function replaceStaged(scratch: string, dest: string, ledger: string, reserved: string[]): void {
  let previous: unknown = [];
  try {
    previous = existsSync(ledger) ? JSON.parse(readFileSync(ledger, 'utf8')) : [];
  } catch {
    previous = [];
  }
  const folded = new Set(reserved.map((n) => n.toLowerCase()));
  const removedDirs = new Set<string>();
  for (const rel of Array.isArray(previous) ? previous : []) {
    if (typeof rel !== 'string') continue;
    const parts = rel.split('/');
    if (
      rel.startsWith('/') ||
      parts.includes('..') ||
      !parts[0] ||
      folded.has(parts[0].toLowerCase())
    )
      continue;
    rmSync(join(dest, rel), { force: true });
    removedDirs.add(dirname(join(dest, rel)));
  }
  // Directories the removals emptied, deepest first.
  for (const start of [...removedDirs].sort((a, b) => b.length - a.length)) {
    let d = start;
    while (d !== dest && d.startsWith(dest + sep) && existsSync(d) && readdirSync(d).length === 0) {
      rmdirSync(d);
      d = dirname(d);
    }
  }
  mkdirSync(dest, { recursive: true });
  cpSync(scratch, dest, { recursive: true });
  mkdirSync(dirname(ledger), { recursive: true });
  writeFileSync(ledger, JSON.stringify(filesUnder(scratch), null, 0));
}

interface StageOptions {
  /** The built `packages/extension-safari/dist`. */
  dist: string;
  /** `$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH`. */
  dest: string;
  /** `$EXECUTABLE_NAME`, which a flat appex holds beside the resources. */
  executable: string | undefined;
  /** `$MARKETING_VERSION`. */
  marketingVersion: string;
  /** Where the ledger and the scratch copy live (`$DERIVED_FILE_DIR`). */
  work: string;
}

/**
 * Fill `dest` from `dist`, validated. Copied to a scratch folder and checked
 * there first, so a refused build leaves the previous good staging untouched.
 */
function stage({ dist, dest, executable, marketingVersion, work }: StageOptions): void {
  if (!marketingVersion) {
    throw new StageError(
      'MARKETING_VERSION is not set — this phase checks the extension against the project version and will not skip that check',
    );
  }
  const reserved = reservedNames(dest, executable);
  if (!existsSync(dist) || !statSync(dist).isDirectory()) {
    throw new StageError(`${dist} is not a directory — build packages/extension-safari first`);
  }
  mkdirSync(work, { recursive: true });
  const tmp = mkdtempSync(join(work, 'stage-'));
  try {
    const scratch = join(tmp, 'Resources');
    cpSync(dist, scratch, { recursive: true });

    const folded = new Set(reserved.map((n) => n.toLowerCase()));
    const clashes = readdirSync(scratch)
      .filter((n) => folded.has(n.toLowerCase()))
      .sort();
    const problems: string[] = [];
    if (clashes.length) {
      problems.push(
        `the extension's resources carry ${clashes.join(', ')} at their root, which would overwrite the appex's own ` +
          'file of that name (its executable, Info.plist, signature, profile or privacy manifest)',
      );
    }
    problems.push(...manifestProblems(scratch, marketingVersion));
    if (problems.length) {
      throw new StageError(
        `${join(dist, 'manifest.json')} is not a Safari build of ContextMint Bridge this appex can ship:\n  - ${problems.join('\n  - ')}`,
      );
    }
    replaceStaged(scratch, dest, join(work, LEDGER), reserved);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main(): number {
  const env = process.env;
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new StageError(`${name} is not set — this runs as an Xcode build phase`);
    return value;
  };
  try {
    const dist = need('STAGE_DIST');
    const dest = join(need('TARGET_BUILD_DIR'), need('UNLOCALIZED_RESOURCES_FOLDER_PATH'));
    stage({
      dist,
      dest,
      executable: env['EXECUTABLE_NAME'] || undefined,
      marketingVersion: env['MARKETING_VERSION'] ?? '',
      work: join(need('DERIVED_FILE_DIR'), 'contextmint-bridge-extension'),
    });
    console.log(`ContextMint Bridge web resources ${dist} -> ${dest}`);
    return 0;
  } catch (err) {
    if (!(err instanceof StageError)) throw err;
    // `error: ` at the start of a line is what Xcode lists as a build error.
    String(err.message)
      .split('\n')
      .forEach((line, i) => console.error((i === 0 ? 'error: ' : '') + line));
    return 1;
  }
}

// Only ever run as a script (stage-extension.sh); nothing imports it.
process.exitCode = main();
