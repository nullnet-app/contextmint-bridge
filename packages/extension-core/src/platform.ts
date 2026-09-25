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
