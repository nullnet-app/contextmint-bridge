/**
 * What `.github/workflows/deploy-safari-app.yml`'s "Submit for App Review"
 * step does with a platform's App Store versions, once this run's build has
 * been uploaded and processed. It DECIDES; the workflow runs asc.
 *
 * The rules, all of them non-destructive:
 *
 * - The submission is on unless the repo variable `APP_REVIEW_SUBMIT` is
 *   `false` (`submitSetting`, the one place that decides). Any other value
 *   but unset/`true` fails closed: nothing is submitted and a warning names it.
 * - This version already with Apple (in review, approved, live): a notice and
 *   nothing else, so a re-run is a no-op.
 * - ANOTHER version with Apple: Apple takes one submission per platform at a
 *   time. Nothing is cancelled, released or rejected; a warning names the
 *   version and the manual remedy.
 * - Otherwise the platform's editable version (Apple keeps at most one) is
 *   renamed to this release, or, with none, a version is created (MANUAL
 *   release, the live version's metadata copied), and this run's build is
 *   submitted. The release type of an existing version is never touched, and
 *   nothing is ever released: the owner releases by hand after approval.
 * - What's New comes only from the release's own CHANGELOG.md section
 *   (`whatsNewFromChangelog`), and only once the app has been released on the
 *   platform: App Store Connect refuses What's New on a first version.
 *
 * Run by the workflow with node's own TypeScript support:
 *
 *   app-review.ts enabled --asc-platform=MAC_OS --submit="$APP_REVIEW_SUBMIT" --github-output=<file>
 *   app-review.ts plan --asc-platform=MAC_OS --version=1.9.0 --app=ID --build-id=ID \
 *     --versions=<asc versions list --paginate json> --github-output=<file>
 *   app-review.ts whats-new --version=1.9.0 --changelog=../CHANGELOG.md --out=<file>
 *
 * Tested by tests/apple-app-review.test.ts.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export type AscPlatform = 'IOS' | 'MAC_OS';
const LABEL: Record<AscPlatform, string> = { IOS: 'iOS', MAC_OS: 'macOS' };

/** App Store Connect's limit on a localization's whatsNew. */
export const WHATS_NEW_MAX = 4000;

/**
 * Version states, by what they mean for a new submission. `appVersionState`
 * is read first; `appStoreState` (deprecated, still filled on old versions) is
 * the fallback. A state in none of these lists is treated as WITH_APPLE: an
 * unknown state blocks the submission with a warning rather than being guessed
 * at.
 */
const EDITABLE = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
  'READY_FOR_REVIEW',
]);
const LIVE = new Set([
  'READY_FOR_DISTRIBUTION',
  'READY_FOR_SALE',
  'PREORDER_READY_FOR_SALE',
  'REPLACED_WITH_NEW_VERSION',
  'DEVELOPER_REMOVED_FROM_SALE',
  'REMOVED_FROM_SALE',
]);

interface Version {
  id: string;
  versionString: string;
  state: string;
  createdDate: string;
}

export interface SubmitSetting {
  enabled: boolean;
  level?: 'notice' | 'warning';
  message: string;
}

/** `APP_REVIEW_SUBMIT`: on when unset or `true`, off when `false`, off (warned) otherwise. */
export function submitSetting(raw: string | undefined): SubmitSetting {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'true') {
    return {
      enabled: true,
      message: 'App Review submission is on (APP_REVIEW_SUBMIT unset or true).',
    };
  }
  if (value === 'false') {
    return {
      enabled: false,
      level: 'notice',
      message:
        'App Review submission is off (repo variable APP_REVIEW_SUBMIT=false); the build is on TestFlight only. ' +
        'Delete the variable or set it to true to submit each release.',
    };
  }
  return {
    enabled: false,
    level: 'warning',
    message:
      `The repo variable APP_REVIEW_SUBMIT is "${String(raw)}", which is neither true nor false; not submitting ` +
      'for App Review. Set it to true, false, or delete it (unset = submit).',
  };
}

export interface PlanInput {
  ascPlatform: AscPlatform;
  /** The release version, X.Y.Z. */
  version: string;
  appId: string;
  /** The build this run uploaded, for the manual remedy. */
  buildId: string;
  /** `asc versions list --app … --platform … --paginate --output json`. */
  versions: unknown;
}

export type Plan =
  | { action: 'skip'; level: 'notice' | 'warning'; message: string }
  | {
      action: 'submit';
      /** The existing version to submit; absent when it must be created. */
      versionId?: string;
      rename: boolean;
      create: boolean;
      /** For a created version: the version string whose metadata is copied. */
      copyFrom?: string;
      /** Some version on this platform has been released (What's New is allowed). */
      releasedBefore: boolean;
      message: string;
    };

function readVersions(doc: unknown, platform: AscPlatform): Version[] {
  const data = (doc as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new Error('asc versions list returned no data array; cannot tell which versions exist');
  }
  return data
    .map((row: { id?: unknown; attributes?: Record<string, unknown> }) => {
      const a = row.attributes ?? {};
      return {
        id: String(row.id ?? ''),
        platform: a['platform'],
        versionString: String(a['versionString'] ?? ''),
        state: String(a['appVersionState'] ?? a['appStoreState'] ?? 'UNKNOWN'),
        createdDate: String(a['createdDate'] ?? ''),
      };
    })
    .filter((v) => v.platform === undefined || v.platform === platform)
    .map(({ id, versionString, state, createdDate }) => ({
      id,
      versionString,
      state,
      createdDate,
    }));
}

const newestFirst = (a: Version, b: Version): number => b.createdDate.localeCompare(a.createdDate);

export function reviewPlan(input: PlanInput): Plan {
  if (!/^\d+\.\d+\.\d+$/.test(input.version)) {
    throw new Error(`The release version "${input.version}" is not X.Y.Z`);
  }
  const label = LABEL[input.ascPlatform];
  const all = readVersions(input.versions, input.ascPlatform).sort(newestFirst);
  const live = all.filter((v) => LIVE.has(v.state));
  const withApple = all.filter((v) => !LIVE.has(v.state) && !EDITABLE.has(v.state));
  const editable = all.filter((v) => EDITABLE.has(v.state));
  const name = `${label} ${input.version}`;

  const mine = all.find((v) => v.versionString === input.version && !EDITABLE.has(v.state));
  if (mine) {
    if (LIVE.has(mine.state)) {
      return {
        action: 'skip',
        level: 'notice',
        message: `${name} is already ${mine.state} on the App Store (version ${mine.id}); nothing to submit.`,
      };
    }
    const known = [
      'WAITING_FOR_REVIEW',
      'IN_REVIEW',
      'PENDING_DEVELOPER_RELEASE',
      'PENDING_APPLE_RELEASE',
      'ACCEPTED',
      'PROCESSING_FOR_DISTRIBUTION',
      'WAITING_FOR_EXPORT_COMPLIANCE',
      'PENDING_CONTRACT',
    ];
    if (known.includes(mine.state)) {
      return {
        action: 'skip',
        level: 'notice',
        message: `${name} was already submitted: it is ${mine.state} (version ${mine.id}). Nothing to do; this job never resubmits.`,
      };
    }
    return {
      action: 'skip',
      level: 'warning',
      message:
        `${name} is in a state this job does not know (${mine.state}, version ${mine.id}); not submitting. ` +
        'Check it in App Store Connect.',
    };
  }

  const blocker = withApple[0];
  if (blocker) {
    const remedy =
      blocker.state === 'PENDING_DEVELOPER_RELEASE'
        ? `release ${blocker.versionString} in App Store Connect (it is approved and waiting for you) or remove it from review`
        : `wait for Apple's decision on ${blocker.versionString}`;
    return {
      action: 'skip',
      level: 'warning',
      message:
        `${name} was not submitted for App Review: ${blocker.versionString} is ${blocker.state} (version ` +
        `${blocker.id}), and Apple takes one submission per platform at a time. This job never cancels a ` +
        `submission. To ship ${input.version}: ${remedy}, then re-run this job (it uploads a fresh build and ` +
        `submits it), or submit this run's build by hand once ${input.version} exists as an editable version: ` +
        `asc review submit --app ${input.appId} --version ${input.version} --platform ${input.ascPlatform} ` +
        `--build-id ${input.buildId} --confirm`,
    };
  }

  const releasedBefore = live.length > 0;
  const target = editable.find((v) => v.versionString === input.version) ?? editable[0];
  if (target) {
    const rename = target.versionString !== input.version;
    return {
      action: 'submit',
      versionId: target.id,
      rename,
      create: false,
      releasedBefore,
      message: rename
        ? `${name}: renaming the editable version ${target.versionString} (${target.state}, ${target.id}) to ${input.version}, then submitting.`
        : `${name}: submitting the editable version ${target.id} (${target.state}).`,
    };
  }
  const copyFrom = live[0]?.versionString;
  return {
    action: 'submit',
    rename: false,
    create: true,
    ...(copyFrom ? { copyFrom } : {}),
    releasedBefore,
    message: `${name}: no editable version, creating one (MANUAL release${copyFrom ? `, metadata copied from ${copyFrom}` : ''}), then submitting.`,
  };
}

/**
 * The release's own CHANGELOG.md section as plain text: its `###` headings and
 * bullets, with markdown links reduced to their text and release-please's
 * issue / commit references dropped. Nothing is added; a release with no
 * section yields ''. Cut on a line boundary to fit App Store Connect's limit.
 */
export function whatsNewFromChangelog(changelog: string, version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return '';
  const lines = changelog.split('\n');
  const escaped = version.replace(/\./g, '\\.');
  const heading = new RegExp(`^##\\s+\\[?${escaped}\\]?(?:\\s|\\(|$)`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return '';
  const out: string[] = [];
  for (const raw of lines.slice(start + 1)) {
    if (/^##\s/.test(raw)) break;
    const line = raw
      // release-please's references: ([#123](url)) and ([abc1234](url))
      .replace(/\s*\(\[[#0-9a-f]+\]\([^)]*\)\)/gi, '')
      // remaining links keep their text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .trimEnd();
    const h = /^###\s+(.*)$/.exec(line);
    const b = /^\s*[*-]\s+(.*)$/.exec(line);
    if (h) {
      if (out.length > 0) out.push('');
      out.push((h[1] ?? '').trim());
    } else if (b) {
      out.push(`- ${(b[1] ?? '').trim()}`);
    } else if (line.trim() !== '') {
      out.push(line.trim());
    }
  }
  let text = out.join('\n').trim();
  if (text.length > WHATS_NEW_MAX) {
    const cut = text.slice(0, WHATS_NEW_MAX);
    text = cut.slice(0, cut.lastIndexOf('\n')).trimEnd();
  }
  return text;
}

// ---------------------------------------------------------------------------
// CLI

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
      'asc-platform': { type: 'string' },
      version: { type: 'string' },
      app: { type: 'string' },
      'build-id': { type: 'string' },
      versions: { type: 'string' },
      submit: { type: 'string' },
      'github-output': { type: 'string' },
      changelog: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const platform = values['asc-platform'] as AscPlatform | undefined;
  if (mode !== 'whats-new' && (platform === undefined || !(platform in LABEL))) {
    console.error(`--asc-platform must be IOS or MAC_OS, got ${String(platform)}`);
    return 2;
  }
  switch (mode) {
    case 'enabled': {
      const setting = submitSetting(values.submit);
      if (setting.level)
        console.log(`::${setting.level}::${LABEL[platform as AscPlatform]}: ${setting.message}`);
      else console.log(`${LABEL[platform as AscPlatform]}: ${setting.message}`);
      writeOutputs(values['github-output'], { enabled: String(setting.enabled) });
      return 0;
    }
    case 'plan': {
      let plan: Plan;
      try {
        plan = reviewPlan({
          ascPlatform: platform as AscPlatform,
          version: values.version ?? '',
          appId: values.app ?? '',
          buildId: values['build-id'] ?? '',
          versions: JSON.parse(readFileSync(values.versions ?? '', 'utf8')) as unknown,
        });
      } catch (err) {
        console.log(
          `::error::${LABEL[platform as AscPlatform]} App Review: ${(err as Error).message}`,
        );
        return 1;
      }
      if (plan.action === 'skip') {
        console.log(`::${plan.level}::${plan.message}`);
        writeOutputs(values['github-output'], { action: 'skip' });
        return 0;
      }
      console.log(plan.message);
      writeOutputs(values['github-output'], {
        action: 'submit',
        version_id: plan.versionId ?? '',
        rename: String(plan.rename),
        create: String(plan.create),
        copy_from: plan.copyFrom ?? '',
        released_before: String(plan.releasedBefore),
      });
      return 0;
    }
    case 'whats-new': {
      const version = values.version ?? '';
      const text = whatsNewFromChangelog(readFileSync(values.changelog ?? '', 'utf8'), version);
      writeFileSync(values.out ?? '', text);
      if (text === '') {
        console.log(
          `::notice::CHANGELOG.md has no section for ${version}; What's New is left as it is.`,
        );
      } else {
        console.log(
          `What's New for ${version} (${text.length} characters), from CHANGELOG.md:\n${text}`,
        );
      }
      return 0;
    }
    default:
      console.error('usage: app-review.ts <enabled|plan|whats-new> [options]');
      return 2;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
