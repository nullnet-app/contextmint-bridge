/**
 * Which browser this build of the extension is for.
 *
 * The value is fixed at BUILD time: each browser package's esbuild config
 * passes `define: { __FETCHPROXY_PLATFORM__: '"chrome"' }` (or `"safari"`),
 * and esbuild substitutes the literal. Nothing in extension-core may hardcode
 * a browser — the hello used to say `platform: 'chrome'` unconditionally,
 * which a Safari build would have sent too.
 *
 * There is deliberately no default. A build that forgets the define leaves the
 * identifier unresolved, and `currentPlatform()` throws naming it, rather than
 * quietly introducing a Safari extension as Chrome. Tests stub the global with
 * `vi.stubGlobal('__FETCHPROXY_PLATFORM__', …)`.
 */
import type { Platform } from '@fetchproxy/protocol';

declare const __FETCHPROXY_PLATFORM__: Platform | undefined;

const PLATFORMS: readonly Platform[] = ['chrome', 'safari', 'firefox'];

export function currentPlatform(): Platform {
  const p: unknown =
    typeof __FETCHPROXY_PLATFORM__ === 'undefined' ? undefined : __FETCHPROXY_PLATFORM__;
  if (p === undefined) {
    // The message names the define only indirectly: a built bundle must not
    // contain the identifier at all (extension-chrome's platform-define test).
    throw new Error(
      'the build-time platform is not defined: the extension build must pass the ' +
        'esbuild platform define for its browser (see extension-core src/platform.ts)',
    );
  }
  if (!PLATFORMS.includes(p as Platform)) {
    throw new Error(
      `the build-time platform is ${JSON.stringify(p)}; expected one of ${PLATFORMS.join(', ')}`,
    );
  }
  return p as Platform;
}

/**
 * Whether this browser is a desktop or a mobile one, as Connect declares it to
 * the gateway (mcp-host plan task X4, spec 2026-10-05 §5.9 "Form factor").
 *
 * The gateway ranks a desktop browser before a mobile one when it chooses
 * which of an account's browsers serves, and a mobile browser never preempts
 * (decision M10). It is an unsigned, unMACed hint (`platform` on
 * `/bridge/connect/finish`, outside the signed bytes): it orders confirmed
 * browsers and grants nothing.
 *
 * It cannot be a build-time define like {@link currentPlatform}: one Safari
 * build ships in both the macOS and the iOS appex (`apple/`). So it is read at
 * run time from `runtime.getPlatformInfo()`, whose `os` is `ios` for Safari on
 * iPhone and iPad (`ipados` is accepted too) and `android` for a Chromium on
 * Android. Anything else — and a browser that cannot say — is `desktop`,
 * which is also how the gateway ranks a browser that declared nothing.
 */
export type FormFactor = 'desktop' | 'mobile';

const MOBILE_OS: ReadonlySet<string> = new Set(['ios', 'ipados', 'android']);

export async function currentFormFactor(): Promise<FormFactor> {
  const runtime = (globalThis as { chrome?: { runtime?: { getPlatformInfo?: () => unknown } } }).chrome
    ?.runtime;
  try {
    const info = (await runtime?.getPlatformInfo?.()) as { os?: unknown } | undefined;
    return typeof info?.os === 'string' && MOBILE_OS.has(info.os) ? 'mobile' : 'desktop';
  } catch {
    return 'desktop';
  }
}
