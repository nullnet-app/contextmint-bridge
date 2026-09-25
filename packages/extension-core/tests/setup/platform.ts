/**
 * The test stand-in for the extension build's esbuild define.
 *
 * In a real bundle `__FETCHPROXY_PLATFORM__` is replaced by a string literal
 * (see `src/platform.ts`). Under vitest there is no esbuild define, so every
 * suite that opens a socket would otherwise hit `currentPlatform()`'s
 * deliberate "not defined" throw. It is set as a plain global — not as a
 * vitest `define`, which would substitute the literal into `platform.ts` at
 * transform time and make `vi.stubGlobal` unable to change it — so
 * `tests/platform.test.ts` can still stub other platforms, and `undefined`.
 */
(globalThis as { __FETCHPROXY_PLATFORM__?: string }).__FETCHPROXY_PLATFORM__ = 'chrome';
