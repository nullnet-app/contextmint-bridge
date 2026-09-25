import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The extension packages moved out of chrischall/fetchproxy. Comments that
 * cite a file from that repo must say where it lives, or a reader will look
 * for it here and not find it. A bare `server|protocol|cli/(src|tests)/` path is only acceptable on
 * a line that names chrischall/fetchproxy or an `@fetchproxy/` package.
 */
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pkgRoot, '..', '..');
const BARE = /(^|[^/a-zA-Z@-])(server|protocol|cli)\/(src|tests)\//;
const QUALIFIED = /chrischall\/fetchproxy|@fetchproxy\//;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|md|json)$/.test(name)) out.push(p);
  }
  return out;
}

describe('no unqualified chrischall/fetchproxy paths', () => {
  it('every server/protocol/cli source path says which repo it is in', () => {
    const offenders: string[] = [];
    for (const file of walk(join(repoRoot, 'packages'))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (BARE.test(line) && !QUALIFIED.test(line)) {
            offenders.push(`${relative(repoRoot, file)}:${i + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
