import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The privacy policy is read by people deciding whether to install the
 * extension, so a network path it leaves out is a claim the code contradicts.
 *
 * - Pairing now has an explicit Connect path; keep the signed requests and
 *   their gateway destination visible in this policy.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

function section(md: string, heading: RegExp): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

describe('PRIVACY.md §4 names every network path', () => {
  const s4 = section(read('docs/PRIVACY.md'), /^## 4\. /);

  it('lists outbound connections to user-configured remote bridge targets', () => {
    expect(s4).toMatch(/remote bridge target/i);
    expect(s4).toMatch(/wss:\/\//);
    expect(s4).toMatch(/only after you (start and )?approve Connect/i);
  });

  it('says what the relay operator can see', () => {
    expect(s4).toMatch(/pair code/i);
    expect(s4).toMatch(/mcpId|MCP identifier/i);
  });

  it('names the signed Connect start and finish requests, their data and destination', () => {
    expect(s4).toMatch(/POST \/bridge\/connect\/start/);
    expect(s4).toMatch(/POST \/bridge\/connect\/finish/);
    expect(s4).toMatch(/https:\/\/mcp\.nullnet\.app/);
    expect(s4).toMatch(/managed browser policy/i);
    expect(s4).toMatch(/credential directly to the extension/i);
  });

  it('does not describe the retired bind or confirm pairing routes', () => {
    expect(s4).not.toMatch(/\/bridge\/bind/);
    expect(s4).not.toMatch(/\/bridge\/account-confirm/);
    expect(s4).not.toMatch(/Confirm this browser/);
  });

  it('documents the sensitive storage.session Connect record', () => {
    const s3 = section(read('docs/PRIVACY.md'), /^## 3\. /);
    expect(s3).toMatch(/storage\.session/);
    expect(s3).toMatch(/bridgeConnectPending/);
    expect(s3).toMatch(/tab id, request id, gateway origin, one-time nonce/i);
  });

  it('no longer claims the extension makes no outbound connections at all', () => {
    expect(s4).not.toMatch(/makes no outbound network connections of its own\./);
  });
});
