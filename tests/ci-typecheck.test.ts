import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * Typecheck guard. vitest transpiles with esbuild and never runs `tsc`, so a
 * type error in a test file passes the whole suite. CI must therefore run
 * `npm run typecheck`, and that script must actually reach the test files —
 * extension-core's own tsconfig (the one `tsc -b` builds) includes only `src/`.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

interface CiWorkflow {
  jobs: Record<string, { uses?: string; with?: Record<string, unknown> }>;
}

describe('CI typechecks', () => {
  const ci = parse(read('.github/workflows/ci.yml')) as CiWorkflow;
  const gated = ci.jobs['ci'];

  it('the gated ci job runs npm run typecheck before npm test', () => {
    expect(gated?.uses).toBe('chrischall/workflows/.github/workflows/reusable-mcp-ci.yml@main');
    const cmd = String(gated?.with?.['test-command'] ?? '');
    const typecheck = cmd.indexOf('npm run typecheck');
    const test = cmd.indexOf('npm test');
    expect(typecheck).toBeGreaterThanOrEqual(0);
    expect(test).toBeGreaterThan(typecheck);
    // `&&`, not `;` — a failed typecheck must fail the step.
    expect(cmd.slice(typecheck, test)).toContain('&&');
  });
});

describe('npm run typecheck', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const script = pkg.scripts['typecheck'] ?? '';

  it('still builds extension-core source', () => {
    expect(script).toContain('tsc -b packages/extension-core');
  });

  it('also checks a tests project that covers every test directory', () => {
    expect(script).toContain('tsc -p tsconfig.tests.json');
    expect(existsSync(join(ROOT, 'tsconfig.tests.json'))).toBe(true);
    const tsconfig = JSON.parse(read('tsconfig.tests.json')) as {
      compilerOptions?: { noEmit?: boolean };
      include?: string[];
    };
    expect(tsconfig.compilerOptions?.noEmit).toBe(true);
    expect(tsconfig.include).toEqual(
      expect.arrayContaining(['tests/**/*', 'packages/*/tests/**/*']),
    );
  });
});
