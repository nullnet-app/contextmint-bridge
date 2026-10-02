import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * fleet-audit #1002: the vault (the extension's IndexedDB: identity keys and
 * every pairing) is otherwise best-effort, quota-managed storage that Chrome
 * may evict under storage pressure — and an evicted vault forces every MCP to
 * pair again. `unlimitedStorage` exempts the extension's IndexedDB from both
 * quota and eviction. It shows no permission warning, so adding it does not
 * disable the extension on update pending a re-consent.
 */
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../manifest.json', import.meta.url)), 'utf8'),
) as { permissions?: string[] };

describe('the Chrome manifest keeps the vault from eviction', () => {
  it('asks for unlimitedStorage', () => {
    expect(manifest.permissions).toContain('unlimitedStorage');
  });
});
