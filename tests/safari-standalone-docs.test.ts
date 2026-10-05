import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ContextMint Bridge for Safari ships as its own App Store app, built from
 * apple/ in this repo, and never talks to the ContextMint app
 * (docs/superpowers/plans/2026-10-05-safari-extension-standalone.md, Task 3).
 * The docs people and agents read must not describe the retired arrangement:
 * a Safari build embedded in mcp-host-app that asks it for a bridge target
 * over native messaging.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

describe('Safari is documented as its own App Store app', () => {
  it('the extension-safari README points at apple/, not mcp-host-app embedding', () => {
    const md = read('packages/extension-safari/README.md');
    expect(md).not.toMatch(/not distributed on its own/i);
    expect(md).not.toMatch(/BRIDGE_SAFARI_RESOURCES_DIR/);
    expect(md).toMatch(/`apple\/`/);
    expect(md).toMatch(/App Store/);
    // The signed development build: the only kind Safari runs.
    expect(md).toMatch(/MAC_APP_PROFILE=/);
    expect(md).toMatch(/MAC_EXTENSION_PROFILE=/);
  });

  it('CLAUDE.md has no ContextMint hand-off hot spot and has an apple/ one', () => {
    const md = read('CLAUDE.md');
    expect(md).not.toMatch(/Safari takes a bridge target from ContextMint/);
    expect(md).not.toMatch(/native-handoff\.ts/);
    expect(md).not.toMatch(/native ContextMint hand-off/i);
    expect(md).not.toMatch(/BRIDGE_SAFARI_RESOURCES_DIR/);
    expect(md).not.toMatch(/never distributed alone/);
    const apple = md.split('\n- **').find((hotSpot) => /^`apple\/`/.test(hotSpot));
    expect(apple, 'an `apple/` hot spot').toBeDefined();
    expect(apple).toMatch(/self-hosted/);
    expect(apple).toMatch(/Runner\.Worker/);
    expect(apple).toMatch(/profile name/i);
    expect(apple).toMatch(/x-release-please-version/);
  });

  it('PRIVACY.md drops the app hand-off and says the container app collects nothing', () => {
    const md = read('docs/PRIVACY.md');
    expect(md).not.toMatch(/temporary app hand-off/i);
    expect(md).not.toMatch(/native messaging/i);
    expect(md).toMatch(/Safari container app[^.]*collects nothing/i);
  });

  it('no store justification for nativeMessaging remains', () => {
    const md = read('docs/store-assets/permission-justifications.md');
    expect(md).not.toMatch(/### `nativeMessaging`/);
    expect(md).not.toMatch(/ships inside the ContextMint app/);
  });

  it('the root README no longer says Safari ships inside the ContextMint app', () => {
    expect(read('README.md')).not.toMatch(/inside the ContextMint app/);
  });
});
