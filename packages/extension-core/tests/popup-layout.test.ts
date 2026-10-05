// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderPopup, type BridgesView } from '../src/popup/popup.js';

/**
 * The popup's row anatomy, from the design system's ExtensionPopup spec
 * (nullnet-design-system, system/ui_kits/contextmint/components/ExtensionPopup.md).
 *
 * The old row was three columns — `name → domains`, "on this computer", and a
 * full-width "forget this MCP" button — and at a 380px popup every one of
 * them wrapped. The spec's row is a status dot, the MCP's name on line 1, its
 * origins and scope as one muted caption on line 2, and one quiet action. These
 * tests hold the DOM to that, so the stylesheet has something stable to style.
 */
describe('popup layout — the ExtensionPopup anatomy', () => {
  let container: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById('root')!;
  });

  describe('a trusted-MCP row', () => {
    const row = (): HTMLElement => container.querySelector('li.trusted-entry')!;

    beforeEach(() => {
      renderPopup(container, {
        mode: 'status',
        trusted: [
          {
            serverName: 'office-outlook-mcp',
            domains: ['outlook.cloud.microsoft', 'outlook.office.com'],
            identityHash: 'h1',
            connected: true,
          },
        ],
        onForget: async () => true,
      });
    });

    it('puts the name alone on line 1', () => {
      expect(row().querySelector('.trusted-body .trusted-label')?.textContent).toBe('office-outlook-mcp');
    });

    it('puts the origins and the scope on line 2, as one caption', () => {
      const meta = row().querySelector('.trusted-body .trusted-meta')!;
      expect(meta.querySelector('.trusted-domains')?.textContent).toBe(
        'outlook.cloud.microsoft, outlook.office.com',
      );
      expect(meta.querySelector('.trusted-source')?.textContent).toBe('on this computer');
    });

    it('keeps the dot first and the action last', () => {
      const kids = [...row().children];
      expect(kids[0]!.classList.contains('status-dot')).toBe(true);
      expect(kids[1]!.classList.contains('trusted-body')).toBe(true);
      expect(kids.at(-1)!.classList.contains('row-actions')).toBe(true);
    });

    it('has a quiet Forget action that names the MCP for assistive tech', () => {
      const forget = row().querySelector<HTMLButtonElement>('.row-actions [data-action="forget-mcp"]')!;
      expect(forget.textContent).toBe('Forget');
      expect(forget.getAttribute('aria-label')).toBe('Forget office-outlook-mcp');
      expect(forget.classList.contains('btn-ghost')).toBe(true);
    });

    it('still reports a failed forget under the row', async () => {
      renderPopup(container, {
        mode: 'status',
        trusted: [{ serverName: 'a-mcp', domains: ['a.com'], identityHash: 'h1' }],
        onForget: async () => false,
      });
      row().querySelector<HTMLButtonElement>('[data-action="forget-mcp"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(row().querySelector('[role="alert"]')?.textContent).toBe('Could not forget this MCP. Try again.');
    });

    it('marks a new MCP with a pill on line 1', () => {
      renderPopup(container, {
        mode: 'status',
        trusted: [{ serverName: 'a-mcp', domains: ['a.com'], isNew: true }],
      });
      expect(row().querySelector('.trusted-line .trusted-new')?.textContent).toBe('new');
    });
  });

  it('titles the status sections as sections, not as the screen', () => {
    renderPopup(container, {
      mode: 'status',
      trusted: [{ serverName: 'a-mcp', domains: ['a.com'] }],
      accounts: [{ origin: 'https://gateway.example', slug: 'chris', accountId: 'a1' }],
      bridges: { targets: [] },
    });
    const titles = [...container.querySelectorAll('h3.section-title')].map((h) => h.textContent);
    expect(titles).toEqual(['Trusted MCPs', 'Accounts', 'Bridges']);
  });

  it('titles a decision view as the screen', () => {
    renderPopup(container, {
      mode: 'pending-pair',
      pending: { serverName: 'x', version: '1', domains: ['x.com'], capabilities: ['fetch'], pairCode: '1234-5678' },
      onApprove: () => {},
      onCancel: () => {},
    });
    expect(container.querySelector('h3.screen-title')?.textContent).toBe('Approve new MCP connection?');
  });

  it('gives each decision view one primary and one secondary button', () => {
    renderPopup(container, {
      mode: 'pending-pair',
      pending: { serverName: 'x', version: '1', domains: ['x.com'], capabilities: ['fetch'], pairCode: '1234-5678' },
      onApprove: () => {},
      onCancel: () => {},
    });
    expect(container.querySelector('[data-action="approve"]')!.classList.contains('btn-primary')).toBe(true);
    expect(container.querySelector('[data-action="cancel"]')!.classList.contains('btn-secondary')).toBe(true);
  });

  it('marks the empty state so it can be drawn as one', () => {
    renderPopup(container, { mode: 'empty' });
    expect(container.querySelector('p.empty-state')?.textContent).toBe(
      'No MCP servers connected. Start an MCP server, then refresh.',
    );
  });

  it('sets the account card identifiers in mono', () => {
    renderPopup(container, {
      mode: 'account-card',
      card: {
        key: 'k',
        origin: 'https://gateway.example',
        keyChanged: false,
        account: { slug: 'chris', displayName: 'Chris', confirmedBy: 'c', bridgedRegistrations: 3, kid: 'ab12 cd34' },
      },
      onApprove: () => {},
      onNotNow: () => {},
    });
    const mono = [...container.querySelectorAll('dd.mono')].map((d) => d.textContent);
    expect(mono).toEqual(['https://gateway.example', 'ab12 cd34']);
  });

  describe('the bridges section', () => {
    const bridges = (b: Partial<BridgesView>): void =>
      renderPopup(container, { mode: 'status', trusted: [], bridges: { targets: [], ...b } });

    it('labels the browser-name field visibly', () => {
      bridges({ connectOrigins: ['https://mcp.nullnet.app'], connectName: 'Chrome on Mac', onConnect: async () => null });
      const label = container.querySelector('label.field')!;
      expect(label.textContent).toContain('Browser name');
      expect(label.querySelector('input.bridge-connect-name')).not.toBeNull();
      expect(container.querySelector('.bridge-connect-start')!.classList.contains('btn-primary')).toBe(true);
    });

    it('puts a remote bridge name on line 1 and its URL on line 2', () => {
      bridges({ targets: [{ id: 'b1', url: 'wss://mcp.nullnet.app/bridge', label: 'Chrome (personal)', enabled: true, connected: true }] });
      const row = container.querySelector('[data-target-id="b1"]')!;
      expect(row.querySelector('.bridge-body .bridge-name')?.textContent).toBe('Chrome (personal)');
      expect(row.querySelector('.bridge-body .bridge-url')?.textContent).toBe('wss://mcp.nullnet.app/bridge');
    });

    it('lets a long URL wrap at its path, never mid-host, without changing its text', () => {
      bridges({ targets: [{ id: 'b1', url: 'wss://contextmint.example.com/a/bridge', label: 'Mine', enabled: true }] });
      const url = container.querySelector('[data-target-id="b1"] .bridge-url')!;
      expect(url.textContent).toBe('wss://contextmint.example.com/a/bridge');
      expect(url.innerHTML).toBe('wss://contextmint.example.com<wbr>/a<wbr>/bridge');
    });

    it('names an unlabelled bridge by its URL, once', () => {
      bridges({ targets: [{ id: 'b1', url: 'wss://h/b', enabled: true }] });
      const row = container.querySelector('[data-target-id="b1"]')!;
      expect(row.querySelector('.bridge-name')?.textContent).toBe('wss://h/b');
      expect(row.querySelector('.bridge-url')).toBeNull();
    });

    it('says each link state in words beside the dot', () => {
      bridges({
        localConnected: false,
        targets: [{ id: 'b1', url: 'wss://h/b', enabled: true, connected: true }],
      });
      expect(container.querySelector('.bridge.local .bridge-state')?.textContent).toBe('Offline');
      expect(container.querySelector('.bridge.remote .bridge-state')?.textContent).toBe('Connected');
    });

    it('says nothing about a state nobody reported', () => {
      bridges({ targets: [{ id: 'b1', url: 'wss://h/b', enabled: true }] });
      expect(container.querySelector('.bridge-state')).toBeNull();
    });

    it('draws the enable box as a switch that names its bridge', () => {
      bridges({ targets: [{ id: 'b1', url: 'wss://h/b', label: 'Mine', enabled: true }], onToggle: vi.fn() });
      const box = container.querySelector<HTMLInputElement>('input.bridge-enabled')!;
      expect(box.getAttribute('role')).toBe('switch');
      expect(box.getAttribute('aria-label')).toBe('Use Mine');
    });

    it('has a quiet icon Remove action that still names the URL', () => {
      bridges({ targets: [{ id: 'b1', url: 'wss://h/b', enabled: true }], onRemove: vi.fn() });
      const rm = container.querySelector<HTMLButtonElement>('.bridge-remove')!;
      expect(rm.textContent).toBe('Remove');
      expect(rm.querySelector('.visually-hidden')?.textContent).toBe('Remove');
      expect(rm.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(rm.getAttribute('aria-label')).toBe('remove wss://h/b');
      expect(rm.classList.contains('btn-ghost')).toBe(true);
    });
  });
});
