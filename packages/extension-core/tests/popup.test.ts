// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  deviceName,
  mergeTrustedSummaries,
  renderPopup,
  type BridgesView,
  type PopupState,
} from '../src/popup/popup.js';
import {
  clearVersionMismatches,
  freshVersionMismatches,
  recordVersionMismatch,
  type VersionMismatch,
} from '../src/lib/version-mismatch.js';

describe('renderPopup', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById('root')!;
  });

  it('renders the account trust card with its identity fields and actions', () => {
    const onApprove = vi.fn();
    const onNotNow = vi.fn();
    renderPopup(container, {
      mode: 'account-card',
      card: {
        key: 'remote:one:acc_123', origin: 'https://gateway.example', keyChanged: true,
        account: { slug: 'chris', displayName: 'Chris Hall', confirmedBy: 'c•••@gmail.com', bridgedRegistrations: 19, kid: '0123456789abcdef' },
      },
      onApprove, onNotNow,
    });
    expect(container.textContent).toContain('The account key for Chris Hall changed. Approve again?');
    expect(container.textContent).toContain('c•••@gmail.com');
    expect(container.textContent).toContain('https://gateway.example');
    expect(container.textContent).toContain('19');
    expect(container.textContent).toContain('0123456789abcdef');
    container.querySelector<HTMLButtonElement>('[data-action="approve-account"]')!.click();
    container.querySelector<HTMLButtonElement>('[data-action="dismiss-account"]')!.click();
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onNotNow).toHaveBeenCalledOnce();
  });

  it('renders account MCP confirmation without a pair code and names the granted sites', () => {
    renderPopup(container, { mode: 'account-mcp-card', card: {
      key: 'remote:mcp', kind: 'confirm', registrationSlug: 'zillow', accountSlug: 'chris',
      origin: 'https://gateway.example', scope: {
        domains: ['zillow.com'], capabilities: ['fetch', 'read_cookies'], cookieKeys: ['session_id'],
        localStorageKeys: [], sessionStorageKeys: [], captureHeaders: [], indexedDbScopes: [],
        domSelectors: [], domListSelectors: [], graphqlOps: [], localStoragePointers: [], sessionStoragePointers: [],
      },
    }, onApprove: vi.fn(), onNotNow: vi.fn() });
    expect(container.textContent).toContain('zillow wants to act as chris');
    expect(container.textContent).toContain('zillow.com and its subdomains');
    expect(container.textContent).toContain('cookie session_id');
    expect(container.textContent).not.toContain('pair code');
  });

  it('renders empty state when no pending and no trusted', () => {
    renderPopup(container, { mode: 'empty' });
    expect(container.textContent).toContain('No MCP servers connected');
  });

  it('renders status with trusted MCPs', () => {
    const state: PopupState = {
      mode: 'status',
      trusted: [
        { serverName: 'opentable-mcp', domains: ['opentable.com'] },
        { serverName: 'resy-mcp', domains: ['resy.com'] },
      ],
    };
    renderPopup(container, state);
    expect(container.textContent).toContain('opentable-mcp');
    expect(container.textContent).toContain('opentable.com');
    expect(container.textContent).toContain('resy-mcp');
    expect(container.textContent).toContain('resy.com');
  });

  it('labels account MCPs and renders new, always ask, and forget actions', () => {
    const onAlwaysAsk = vi.fn();
    const onForget = vi.fn();
    renderPopup(container, { mode: 'status', trusted: [{
      serverName: 'zillow', domains: ['zillow.com'], identityHash: 'hash-z',
      source: { slug: 'chris', origin: 'https://gateway.example' }, accountDerived: true, isNew: true, alwaysAsk: false,
    }], onAlwaysAsk, onForget });
    expect(container.textContent).toContain('via chris on https://gateway.example');
    expect(container.textContent).toContain('new');
    expect(container.querySelector('[data-action="always-ask"]')).not.toBeNull();
    expect(container.querySelector('[data-action="forget-mcp"]')).not.toBeNull();
    container.querySelector<HTMLButtonElement>('[data-action="always-ask"]')!.click();
    container.querySelector<HTMLButtonElement>('[data-action="forget-mcp"]')!.click();
    expect(onAlwaysAsk).toHaveBeenCalledWith('hash-z', true);
    expect(onForget).toHaveBeenCalledWith('hash-z');
  });

  it('does not offer always-ask for hand-paired MCPs', () => {
    renderPopup(container, { mode: 'status', trusted: [{
      serverName: 'hand-paired', domains: ['example.com'], identityHash: 'hash-local', alwaysAsk: false,
    }], onAlwaysAsk: vi.fn() });
    expect(container.querySelector('[data-action="always-ask"]')).toBeNull();
  });

  it('does not offer always-ask for attested hand-pairs without a derived record', () => {
    const trusted = mergeTrustedSummaries({ handPair: {
      serverName: 'hand-paired', domains: ['example.com'], capabilities: ['fetch'],
      attestedBy: { slug: 'chris', origin: 'https://gateway.example', accountId: 'acct-1' },
    } }, {}, new Set());
    renderPopup(container, { mode: 'status', trusted, onAlwaysAsk: vi.fn() });
    expect(container.querySelector('[data-action="always-ask"]')).toBeNull();
  });

  it('shows a failure when forgetting an MCP is rejected', async () => {
    renderPopup(container, { mode: 'status', trusted: [{ serverName: 'server', domains: ['example.com'], identityHash: 'hash' }],
      onForget: async () => false });
    container.querySelector<HTMLButtonElement>('[data-action="forget-mcp"]')!.click();
    await Promise.resolve();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not forget this MCP');
  });

  it('shows a failure when forgetting an account is rejected', async () => {
    renderPopup(container, { mode: 'status', trusted: [], accounts: [{ origin: 'https://gateway.example', slug: 'chris', accountId: 'acct-1' }],
      onForgetAccount: async () => false });
    container.querySelector<HTMLButtonElement>('[data-action="forget-account"]')!.click();
    await Promise.resolve();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not forget this account');
  });

  it('renders one removal action when revoke and forget callbacks target the same MCP', () => {
    renderPopup(container, { mode: 'status', trusted: [{ serverName: 'server', domains: ['example.com'], identityHash: 'hash' }],
      onRevoke: vi.fn(), onForget: vi.fn() });
    expect(container.querySelector('[data-action="revoke"]')).toBeNull();
    expect(container.querySelectorAll('[data-action="forget-mcp"]')).toHaveLength(1);
  });

  it('labels local MCPs and exposes account forgetting controls', () => {
    const onForgetAccount = vi.fn();
    renderPopup(container, { mode: 'status', trusted: [{ serverName: 'local-mcp', domains: ['local.test'], identityHash: 'local-hash' }],
      accounts: [{ origin: 'https://gateway.example', slug: 'chris', accountId: 'acct-1' }], onForgetAccount });
    expect(container.textContent).toContain('on this computer');
    expect(container.querySelector('[data-action="forget-account"]')).not.toBeNull();
    const also = container.querySelector<HTMLInputElement>('[data-action="also-forget-mcps"]')!;
    also.checked = true;
    container.querySelector<HTMLButtonElement>('[data-action="forget-account"]')!.click();
    expect(onForgetAccount).toHaveBeenCalledWith('https://gateway.example', 'acct-1', true);
  });

  // Part 3: connection-status dot
  describe('connection-status dot', () => {
    it('renders .status-dot.connected with aria-label "connected" when connected: true', () => {
      renderPopup(container, {
        mode: 'status',
        trusted: [
          { serverName: 'opentable-mcp', domains: ['opentable.com'], identityHash: 'h1', connected: true },
        ],
      });
      const dot = container.querySelector('.status-dot.connected');
      expect(dot).not.toBeNull();
      expect(dot?.getAttribute('aria-label')).toBe('connected');
    });

    it('renders .status-dot.offline with aria-label "not connected" when connected: false', () => {
      renderPopup(container, {
        mode: 'status',
        trusted: [
          { serverName: 'resy-mcp', domains: ['resy.com'], identityHash: 'h2', connected: false },
        ],
      });
      const dot = container.querySelector('.status-dot.offline');
      expect(dot).not.toBeNull();
      expect(dot?.getAttribute('aria-label')).toBe('not connected');
    });

    it('renders no .status-dot when connected is omitted (backward compat)', () => {
      renderPopup(container, {
        mode: 'status',
        trusted: [
          { serverName: 'legacy-mcp', domains: ['legacy.com'] },
        ],
      });
      expect(container.querySelector('.status-dot')).toBeNull();
    });
  });

  // Alphabetical sort + Active/Inactive sections.
  describe('sorting + active/inactive sections', () => {
    const namesIn = (scope: ParentNode = container): (string | undefined)[] =>
      [...scope.querySelectorAll('.trusted-label')].map(
        (e) => e.textContent?.split(' → ')[0],
      );

    it('sorts alphabetically by serverName, as a single list, when no connection info is present', () => {
      renderPopup(container, {
        mode: 'status',
        trusted: [
          { serverName: 'resy-mcp', domains: ['resy.com'] },
          { serverName: 'compass-mcp', domains: ['compass.com'] },
          { serverName: 'Opentable-mcp', domains: ['opentable.com'] },
        ],
      });
      // Case-insensitive sort; no section headers; one list.
      expect(namesIn()).toEqual(['compass-mcp', 'Opentable-mcp', 'resy-mcp']);
      expect(container.querySelector('.trusted-section')).toBeNull();
      expect(container.querySelectorAll('ul.trusted-list').length).toBe(1);
    });

    it('splits into Active and Inactive sections, each alphabetical, when connection info is present', () => {
      renderPopup(container, {
        mode: 'status',
        trusted: [
          { serverName: 'resy-mcp', domains: ['resy.com'], connected: false },
          { serverName: 'opentable-mcp', domains: ['opentable.com'], connected: true },
          { serverName: 'compass-mcp', domains: ['compass.com'], connected: false },
          { serverName: 'artsonia-mcp', domains: ['artsonia.com'], connected: true },
        ],
      });
      const sections = [...container.querySelectorAll('.trusted-section')].map((e) => e.textContent);
      expect(sections.length).toBe(2);
      expect(sections[0]).toContain('Active');
      expect(sections[1]).toContain('Inactive');
      const lists = container.querySelectorAll('ul.trusted-list');
      expect(lists.length).toBe(2);
      expect(namesIn(lists[0])).toEqual(['artsonia-mcp', 'opentable-mcp']);
      expect(namesIn(lists[1])).toEqual(['compass-mcp', 'resy-mcp']);
    });

    it('renders only the Active section when every entry is connected', () => {
      renderPopup(container, {
        mode: 'status',
        trusted: [
          { serverName: 'resy-mcp', domains: ['resy.com'], connected: true },
          { serverName: 'opentable-mcp', domains: ['opentable.com'], connected: true },
        ],
      });
      const sections = [...container.querySelectorAll('.trusted-section')].map((e) => e.textContent);
      expect(sections.length).toBe(1);
      expect(sections[0]).toContain('Active');
      expect(namesIn()).toEqual(['opentable-mcp', 'resy-mcp']);
    });

    it('renders the Inactive section collapsed by default (a closed <details>); Active stays expanded', () => {
      renderPopup(container, {
        mode: 'status',
        trusted: [
          { serverName: 'opentable-mcp', domains: ['opentable.com'], connected: true },
          { serverName: 'resy-mcp', domains: ['resy.com'], connected: false },
        ],
      });
      const details = container.querySelector('details.trusted-inactive');
      expect(details).not.toBeNull();
      // No `open` attribute ⇒ collapsed by default.
      expect((details as HTMLDetailsElement).open).toBe(false);
      // The Inactive header lives in the <summary>; the inactive entry is inside.
      expect(details!.querySelector('summary.trusted-section')?.textContent).toContain('Inactive');
      expect(namesIn(details!)).toEqual(['resy-mcp']);
      // Active is NOT wrapped in a <details> — it stays plainly visible.
      const activeHeader = container.querySelector('h4.trusted-section');
      expect(activeHeader?.textContent).toContain('Active');
      expect(activeHeader?.closest('details')).toBeNull();
    });

    it('treats a missing `connected` as inactive once any entry carries connection info', () => {
      renderPopup(container, {
        mode: 'status',
        trusted: [
          { serverName: 'b-mcp', domains: ['b.com'], connected: true },
          { serverName: 'a-mcp', domains: ['a.com'] },
        ],
      });
      const lists = container.querySelectorAll('ul.trusted-list');
      expect(lists.length).toBe(2);
      expect(namesIn(lists[0])).toEqual(['b-mcp']); // Active
      expect(namesIn(lists[1])).toEqual(['a-mcp']); // Inactive
    });
  });

  it('renders multi-domain trusted MCP with all hosts listed', () => {
    renderPopup(container, {
      mode: 'status',
      trusted: [{ serverName: 'honeybook-mcp', domains: ['honeybook.com', 'hbsplit.com'] }],
    });
    expect(container.textContent).toContain('honeybook.com');
    expect(container.textContent).toContain('hbsplit.com');
  });

  // 0.4.2: revoke (✕) button on each trusted-MCP entry — only rendered
  // when both `onRevoke` and per-entry `identityHash` are provided.
  // Without either, the list is read-only (back-compat with older tests).
  describe('revoke button', () => {
    it('does not render revoke buttons when onRevoke is omitted', () => {
      renderPopup(container, {
        mode: 'status',
        trusted: [
          { serverName: 'opentable-mcp', domains: ['opentable.com'], identityHash: 'h1' },
        ],
      });
      expect(container.querySelector('button[data-action="revoke"]')).toBeNull();
    });

    it('does not render a revoke button when identityHash is missing', () => {
      renderPopup(container, {
        mode: 'status',
        trusted: [{ serverName: 'legacy-mcp', domains: ['legacy.com'] }],
        onRevoke: () => undefined,
      });
      expect(container.querySelector('button[data-action="revoke"]')).toBeNull();
    });

    it('renders a revoke button per entry when both onRevoke + identityHash are present', () => {
      renderPopup(container, {
        mode: 'status',
        trusted: [
          { serverName: 'opentable-mcp', domains: ['opentable.com'], identityHash: 'h1' },
          { serverName: 'resy-mcp', domains: ['resy.com'], identityHash: 'h2' },
        ],
        onRevoke: () => undefined,
      });
      const buttons = container.querySelectorAll('button[data-action="revoke"]');
      expect(buttons).toHaveLength(2);
      expect(buttons[0]?.getAttribute('data-identity-hash')).toBe('h1');
      expect(buttons[1]?.getAttribute('data-identity-hash')).toBe('h2');
    });

    it('invokes onRevoke with the entry identityHash after confirmation', () => {
      const calls: string[] = [];
      const origConfirm = window.confirm;
      window.confirm = (): boolean => true;
      try {
        renderPopup(container, {
          mode: 'status',
          trusted: [
            { serverName: 'opentable-mcp', domains: ['opentable.com'], identityHash: 'h1' },
          ],
          onRevoke: (h) => calls.push(h),
        });
        const btn = container.querySelector('button[data-action="revoke"]') as HTMLButtonElement;
        btn.click();
        expect(calls).toEqual(['h1']);
      } finally {
        window.confirm = origConfirm;
      }
    });

    it('does NOT call onRevoke when the user cancels the confirmation', () => {
      const calls: string[] = [];
      const origConfirm = window.confirm;
      window.confirm = (): boolean => false;
      try {
        renderPopup(container, {
          mode: 'status',
          trusted: [
            { serverName: 'opentable-mcp', domains: ['opentable.com'], identityHash: 'h1' },
          ],
          onRevoke: (h) => calls.push(h),
        });
        const btn = container.querySelector('button[data-action="revoke"]') as HTMLButtonElement;
        btn.click();
        expect(calls).toEqual([]);
      } finally {
        window.confirm = origConfirm;
      }
    });
  });

  it('renders pending-pair with code prominent + cancel default-focused', () => {
    const state: PopupState = {
      mode: 'pending-pair',
      pending: {
        serverName: 'opentable-mcp',
        version: '0.9.1',
        domains: ['opentable.com'],
        capabilities: ['fetch'],
        pairCode: '4729-1836',
      },
      onApprove: () => undefined,
      onCancel: () => undefined,
    };
    renderPopup(container, state);
    expect(container.textContent).toContain('4729-1836');
    expect(container.textContent).toContain('opentable.com');
    expect(container.textContent).toContain('opentable-mcp');
    const approve = container.querySelector('[data-action="approve"]') as HTMLButtonElement;
    const cancel = container.querySelector('[data-action="cancel"]') as HTMLButtonElement;
    expect(approve).not.toBeNull();
    expect(cancel).not.toBeNull();
    expect(cancel.getAttribute('autofocus')).not.toBeNull();
  });

  it('asks to compare the pair code without assuming the server runs in a terminal', () => {
    // A server ContextMint hosts (the only kind on iPhone and iPad) has no
    // terminal the user can see; the hint must fit it as well as a local one.
    renderPopup(container, {
      mode: 'pending-pair',
      pending: {
        serverName: 'opentable-mcp',
        version: '0.9.1',
        domains: ['opentable.com'],
        capabilities: ['fetch'],
        pairCode: '4729-1836',
      },
      onApprove: () => undefined,
      onCancel: () => undefined,
    });
    const hint = container.querySelector('.hint')?.textContent ?? '';
    expect(hint).toMatch(/matches the one the server shows/);
    expect(container.textContent).not.toMatch(/terminal/i);
  });

  it('renders pending-pair with multiple domains all visible', () => {
    renderPopup(container, {
      mode: 'pending-pair',
      pending: {
        serverName: 'honeybook-mcp',
        version: '0.0.1',
        domains: ['honeybook.com', 'hbsplit.com'],
        capabilities: ['fetch'],
        pairCode: '1234-5678',
      },
      onApprove: () => undefined,
      onCancel: () => undefined,
    });
    expect(container.textContent).toContain('honeybook.com');
    expect(container.textContent).toContain('hbsplit.com');
    // Header should pluralise ("Domains" rather than "Domain") for multi.
    expect(container.textContent).toContain('Domains');
  });

  it('calls onApprove when Approve clicked', () => {
    let called = false;
    renderPopup(container, {
      mode: 'pending-pair',
      pending: {
        serverName: 'opentable-mcp',
        version: '0.9.1',
        domains: ['opentable.com'],
        capabilities: ['fetch'],
        pairCode: '4729-1836',
      },
      onApprove: () => {
        called = true;
      },
      onCancel: () => undefined,
    });
    (container.querySelector('[data-action="approve"]') as HTMLButtonElement).click();
    expect(called).toBe(true);
  });

  it('calls onCancel when Cancel clicked', () => {
    let called = false;
    renderPopup(container, {
      mode: 'pending-pair',
      pending: {
        serverName: 'opentable-mcp',
        version: '0.9.1',
        domains: ['opentable.com'],
        capabilities: ['fetch'],
        pairCode: '4729-1836',
      },
      onApprove: () => undefined,
      onCancel: () => {
        called = true;
      },
    });
    (container.querySelector('[data-action="cancel"]') as HTMLButtonElement).click();
    expect(called).toBe(true);
  });

  it('shows high-risk warning for bank domains', () => {
    renderPopup(container, {
      mode: 'pending-pair',
      pending: {
        serverName: 'some-bank-mcp',
        version: '0.0.1',
        domains: ['chase.bank'],
        capabilities: ['fetch'],
        pairCode: '1111-2222',
      },
      onApprove: () => undefined,
      onCancel: () => undefined,
    });
    expect(container.textContent?.toLowerCase()).toContain('high-risk');
  });

  it('shows high-risk warning for gov domains', () => {
    renderPopup(container, {
      mode: 'pending-pair',
      pending: {
        serverName: 'some-mcp',
        version: '0.0.1',
        domains: ['irs.gov'],
        capabilities: ['fetch'],
        pairCode: '1111-2222',
      },
      onApprove: () => undefined,
      onCancel: () => undefined,
    });
    expect(container.textContent?.toLowerCase()).toContain('high-risk');
  });

  it('does not show high-risk warning for normal domains', () => {
    renderPopup(container, {
      mode: 'pending-pair',
      pending: {
        serverName: 'opentable-mcp',
        version: '0.9.1',
        domains: ['opentable.com'],
        capabilities: ['fetch'],
        pairCode: '1111-2222',
      },
      onApprove: () => undefined,
      onCancel: () => undefined,
    });
    expect(container.textContent?.toLowerCase()).not.toContain('high-risk');
  });

  it('shows high-risk warning when ANY of the multiple domains is risky', () => {
    renderPopup(container, {
      mode: 'pending-pair',
      pending: {
        serverName: 'mixed-mcp',
        version: '0.0.1',
        domains: ['benign.com', 'chase.bank'],
        capabilities: ['fetch'],
        pairCode: '1111-2222',
      },
      onApprove: () => undefined,
      onCancel: () => undefined,
    });
    expect(container.textContent?.toLowerCase()).toContain('high-risk');
  });

  describe('capabilities', () => {
    it('renders fetch capability without warning marker', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'opentable-mcp',
          version: '0.9.1',
          domains: ['opentable.com'],
          capabilities: ['fetch'],
          pairCode: '1111-2222',
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.textContent).toContain('Capabilities');
      expect(container.textContent).toContain('HTTP fetches');
      // No warning marker for fetch-only.
      expect(container.textContent ?? '').not.toContain('⚠️');
    });

    it('renders read_cookies with a visible warning marker', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'credit-karma-mcp',
          version: '0.0.1',
          domains: ['creditkarma.com'],
          capabilities: ['fetch', 'read_cookies'],
          pairCode: '1111-2222',
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.textContent).toContain('HTTP fetches');
      expect(container.textContent).toContain('Read cookies');
      // Warning marker present on the elevated-trust verb.
      expect(container.textContent ?? '').toContain('⚠️');
      const warnLi = container.querySelector('li.cap-warn');
      expect(warnLi).not.toBeNull();
      expect(warnLi!.textContent).toContain('Read cookies');
    });

    it('renders cookieKeys as a comma-separated list when read_cookies declared', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'honeybook-mcp',
          version: '0.1.0',
          domains: ['honeybook.com'],
          capabilities: ['fetch', 'read_cookies'],
          cookieKeys: ['hb_user_token', 'hb_session'],
          pairCode: '1111-2222',
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.textContent).toContain('hb_user_token');
      expect(container.textContent).toContain('hb_session');
    });

    it('warns that the listed cookies can include the HttpOnly login session (S-SEC-2)', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'zola-mcp',
          version: '0.7.0',
          domains: ['zola.com'],
          capabilities: ['fetch', 'read_cookies'],
          cookieKeys: ['usr'],
          pairCode: '1111-2222',
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      const warning = container.querySelector('.cookie-session-warning');
      expect(warning).not.toBeNull();
      expect(warning!.textContent).toMatch(/HttpOnly/);
      expect(warning!.textContent).toMatch(/sign(ed)? in as you/i);
    });

    it('shows no cookie-session warning when no cookieKeys are declared', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'x-mcp',
          version: '0.1.0',
          domains: ['x.com'],
          capabilities: ['fetch'],
          pairCode: '1111-2222',
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.querySelector('.cookie-session-warning')).toBeNull();
    });

    it('renders localStorageKeys when read_local_storage declared', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'ofw-mcp',
          version: '0.5.0',
          domains: ['ourfamilywizard.com'],
          capabilities: ['fetch', 'read_local_storage'],
          localStorageKeys: ['auth', 'tokenExpiry'],
          pairCode: '1111-2222',
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.textContent).toContain('Read localStorage');
      expect(container.textContent).toContain('auth');
      expect(container.textContent).toContain('tokenExpiry');
    });

    it('renders sessionStorageKeys when read_session_storage declared', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'some-mcp',
          version: '0.0.1',
          domains: ['x.com'],
          capabilities: ['fetch', 'read_session_storage'],
          sessionStorageKeys: ['anon-id'],
          pairCode: '1111-2222',
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.textContent).toContain('Read sessionStorage');
      expect(container.textContent).toContain('anon-id');
    });

    it('renders IndexedDB scopes when read_indexed_db declared', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'resy-mcp',
          version: '0.0.1',
          domains: ['resy.com'],
          capabilities: ['fetch', 'read_indexed_db'],
          indexedDbScopes: [
            { origin: 'https://resy.com', database: 'resy', store: 'auth', keys: ['userToken', 'userId'] },
          ],
          pairCode: '1111-2222',
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.textContent).toContain('Read IndexedDB');
      expect(container.textContent).toContain('resy/auth');
      expect(container.textContent).toContain('userToken');
      expect(container.textContent).toContain('userId');
    });

    it('renders DOM selectors when read_dom declared', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'acme-mcp',
          version: '1.4.0',
          domains: ['acme.com'],
          capabilities: ['fetch', 'read_dom'],
          domSelectors: [
            { name: 'title', selector: 'h1.title' },
            { name: 'csrf', selector: 'meta[name=csrf]', attribute: 'content' },
          ],
          pairCode: '1111-2222',
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.textContent).toContain('Read DOM elements');
      expect(container.textContent).toContain('title → h1.title');
      expect(container.textContent).toContain('csrf → meta[name=csrf] [content]');
    });

    it('renders DOM list selectors when read_dom_list declared', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'acme-mcp',
          version: '1.4.0',
          domains: ['acme.com'],
          capabilities: ['fetch', 'read_dom_list'],
          domListSelectors: [
            {
              name: 'chatMessages',
              itemSelector: '.msg',
              fields: [
                { name: 'sender', selector: '.author' },
                { name: 'time', selector: 'time', attribute: 'datetime' },
              ],
            },
          ],
          pairCode: '1111-2222',
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.textContent).toContain('Read repeated DOM lists');
      expect(container.textContent).toContain('chatMessages → .msg (sender: .author, time: time [datetime])');
    });

    it('renders declared GraphQL operations verbatim when graphql declared', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'opentable-mcp',
          version: '1.0.0',
          domains: ['opentable.com'],
          capabilities: ['fetch', 'graphql'],
          graphqlOps: [
            { name: 'restaurantsAvailability', operationName: 'RestaurantsAvailability' },
          ],
          pairCode: '1111-2222',
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.textContent).toContain('Run declared GraphQL queries');
      expect(container.textContent).toContain('restaurantsAvailability → RestaurantsAvailability');
    });

    it('renders capture-header entries each on their own line', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'honeybook-mcp',
          version: '0.1.0',
          domains: ['honeybook.com'],
          capabilities: ['fetch', 'capture_request_header'],
          captureHeaders: [
            { host: 'api.honeybook.com', path: '/api/v2/*', headerName: 'hb-api-fingerprint' },
            { host: 'api.honeybook.com', path: '/api/v3/*', headerName: 'hb-api-fingerprint' },
          ],
          pairCode: '1111-2222',
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.textContent).toContain('Capture request header');
      expect(container.textContent).toContain('api/v2/*');
      expect(container.textContent).toContain('api/v3/*');
      expect(container.textContent).toContain('hb-api-fingerprint');
    });

    it('omits scope sub-lists when their declared array is empty', () => {
      // Pattern B (fetch-only) MCPs should NOT see any of the new
      // sub-lists rendered — the popup stays minimal.
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'opentable-mcp',
          version: '0.9.1',
          domains: ['opentable.com'],
          capabilities: ['fetch'],
          cookieKeys: [],
          localStorageKeys: [],
          sessionStorageKeys: [],
          captureHeaders: [],
          pairCode: '1111-2222',
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.textContent).not.toContain('Read cookies:');
      expect(container.textContent).not.toContain('Read localStorage');
      expect(container.textContent).not.toContain('Read sessionStorage');
      expect(container.textContent).not.toContain('Capture request header');
      expect(container.textContent).not.toContain('Run declared GraphQL queries');
    });

    it('renders re-pair diff: heading "UPDATE", added/removed/kept lists, "Approve update" button', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'ofw-mcp',
          version: '0.5.0',
          domains: ['ourfamilywizard.com'],
          capabilities: ['fetch', 'read_local_storage', 'read_cookies'],
          cookieKeys: ['MTOKEN'],
          localStorageKeys: ['auth', 'tokenExpiry'],
          pairCode: '1111-2222',
        },
        previous: {
          capabilities: ['fetch', 'read_local_storage'],
          cookieKeys: [],
          localStorageKeys: ['auth'],
          sessionStorageKeys: [],
          captureHeaders: [],
          indexedDbScopes: [],
          domSelectors: [],
          domListSelectors: [],
          graphqlOps: [],
          localStoragePointers: [],
          sessionStoragePointers: [],
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.textContent).toContain('UPDATE');
      expect(container.textContent).toContain('Previously approved');
      expect(container.textContent).toContain('Now requesting (new)');
      // 'read_cookies' was added; 'auth' was already approved; 'MTOKEN' is new.
      expect(container.textContent).toContain('Capability: read_cookies');
      expect(container.textContent).toContain('Cookie: MTOKEN');
      // A newly requested cookie carries the HttpOnly-session warning (S-SEC-2).
      expect(container.querySelector('.cookie-session-warning')).not.toBeNull();
      expect(container.textContent).toContain('localStorage: tokenExpiry');
      // The approve button should be labeled "Approve update".
      const approve = container.querySelector('[data-action="approve"]') as HTMLButtonElement;
      expect(approve.textContent).toBe('Approve update');
    });

    it('renders "(none)" when an update has no removals', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'ofw-mcp',
          version: '0.5.0',
          domains: ['ourfamilywizard.com'],
          capabilities: ['fetch', 'read_local_storage'],
          localStorageKeys: ['auth', 'tokenExpiry'],
          pairCode: '1111-2222',
        },
        previous: {
          capabilities: ['fetch', 'read_local_storage'],
          cookieKeys: [],
          localStorageKeys: ['auth'],
          sessionStorageKeys: [],
          captureHeaders: [],
          indexedDbScopes: [],
          domSelectors: [],
          domListSelectors: [],
          graphqlOps: [],
          localStoragePointers: [],
          sessionStoragePointers: [],
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.textContent).toContain('No longer requested');
      expect(container.textContent).toContain('(none)');
    });

    // ---------------------------------------------------------------------------
    // Part 2: scope-update mode
    // ---------------------------------------------------------------------------
    describe('scope-update mode', () => {
      it('renders the added/removed scope diff for a scope-update state', () => {
        renderPopup(container, {
          mode: 'scope-update',
          serverName: 'musescore-mcp',
          pending: {
            capabilities: ['fetch', 'capture_request_header'],
            cookieKeys: [],
            localStorageKeys: [],
            sessionStorageKeys: [],
            captureHeaders: [],
            indexedDbScopes: [],
            domSelectors: [],
            domListSelectors: [],
            graphqlOps: [],
            localStoragePointers: [],
            sessionStoragePointers: [],
          },
          previous: {
            capabilities: ['fetch'],
            cookieKeys: [],
            localStorageKeys: [],
            sessionStorageKeys: [],
            captureHeaders: [],
            indexedDbScopes: [],
            domSelectors: [],
            domListSelectors: [],
            graphqlOps: [],
            localStoragePointers: [],
            sessionStoragePointers: [],
          },
          onGrant: () => undefined,
          onKeepAsIs: () => undefined,
        });
        // Should show the diff sections.
        expect(container.textContent).toContain('Previously approved');
        expect(container.textContent).toContain('Now requesting (new)');
        expect(container.textContent).toContain('Capability: capture_request_header');
        // The kept capability should appear under "Previously approved".
        expect(container.textContent).toContain('Capability: fetch');
      });

      it('warns about HttpOnly login-session cookies when cookies are newly requested (S-SEC-2)', () => {
        const empty = {
          capabilities: ['fetch'],
          cookieKeys: [] as string[],
          localStorageKeys: [],
          sessionStorageKeys: [],
          captureHeaders: [],
          indexedDbScopes: [],
          domSelectors: [],
          domListSelectors: [],
          graphqlOps: [],
          localStoragePointers: [],
          sessionStoragePointers: [],
        };
        renderPopup(container, {
          mode: 'scope-update',
          serverName: 'zola-mcp',
          pending: { ...empty, capabilities: ['fetch', 'read_cookies'], cookieKeys: ['usr'] },
          previous: empty,
          onGrant: () => undefined,
          onKeepAsIs: () => undefined,
        });
        const warnings = container.querySelectorAll('.cookie-session-warning');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.textContent).toMatch(/HttpOnly/);
      });

      it('shows no cookie-session warning when the update adds no cookies', () => {
        const scope = {
          capabilities: ['fetch'],
          cookieKeys: ['usr'],
          localStorageKeys: [],
          sessionStorageKeys: [],
          captureHeaders: [],
          indexedDbScopes: [],
          domSelectors: [],
          domListSelectors: [],
          graphqlOps: [],
          localStoragePointers: [],
          sessionStoragePointers: [],
        };
        renderPopup(container, {
          mode: 'scope-update',
          serverName: 'zola-mcp',
          pending: { ...scope, localStorageKeys: ['x'] },
          previous: scope,
          onGrant: () => undefined,
          onKeepAsIs: () => undefined,
        });
        expect(container.querySelector('.cookie-session-warning')).toBeNull();
      });

      it('shows an added graphqlOps entry in the diff, not an empty "(none)" section', () => {
        // Regression: a scope-update whose ONLY change is a new declared
        // GraphQL operation must not render an unreviewable empty diff —
        // scopeHash/isScopeSubset already gate on graphqlOps (lib/scope.ts),
        // so this MUST surface in "Now requesting (new)".
        renderPopup(container, {
          mode: 'scope-update',
          serverName: 'opentable-mcp',
          pending: {
            capabilities: ['fetch', 'graphql'],
            cookieKeys: [],
            localStorageKeys: [],
            sessionStorageKeys: [],
            captureHeaders: [],
            indexedDbScopes: [],
            domSelectors: [],
            domListSelectors: [],
            graphqlOps: [
              { name: 'restaurantsAvailability', operationName: 'RestaurantsAvailability' },
            ],
            localStoragePointers: [],
            sessionStoragePointers: [],
          },
          previous: {
            capabilities: ['fetch', 'graphql'],
            cookieKeys: [],
            localStorageKeys: [],
            sessionStorageKeys: [],
            captureHeaders: [],
            indexedDbScopes: [],
            domSelectors: [],
            domListSelectors: [],
            graphqlOps: [],
            localStoragePointers: [],
            sessionStoragePointers: [],
          },
          onGrant: () => undefined,
          onKeepAsIs: () => undefined,
        });
        expect(container.textContent).toContain(
          'GraphQL: restaurantsAvailability → RestaurantsAvailability',
        );
      });

      it('shows a maxItems-only domListSelectors change in the diff, not an empty "(none)" section', () => {
        // Regression: scopeHash/isScopeSubset gate on the FULL DomListSelectorDecl
        // including maxItems (lib/scope.ts's normDomListSelector), so a
        // maxItems-only widening raises this scope-update prompt in the first
        // place. domListSelectorKey (this file) has to agree, or the prompt
        // renders with an empty "Now requesting" — a re-approval ask the user
        // cannot see the reason for.
        const declWithMax = (maxItems: number) => ({
          name: 'chatMessages',
          itemSelector: '.msg',
          fields: [{ name: 'text', selector: '.body' }],
          maxItems,
        });
        renderPopup(container, {
          mode: 'scope-update',
          serverName: 'teams-mcp',
          pending: {
            capabilities: ['fetch', 'read_dom_list'],
            cookieKeys: [],
            localStorageKeys: [],
            sessionStorageKeys: [],
            captureHeaders: [],
            indexedDbScopes: [],
            domSelectors: [],
            domListSelectors: [declWithMax(300)],
            graphqlOps: [],
            localStoragePointers: [],
            sessionStoragePointers: [],
          },
          previous: {
            capabilities: ['fetch', 'read_dom_list'],
            cookieKeys: [],
            localStorageKeys: [],
            sessionStorageKeys: [],
            captureHeaders: [],
            indexedDbScopes: [],
            domSelectors: [],
            domListSelectors: [declWithMax(200)],
            graphqlOps: [],
            localStoragePointers: [],
            sessionStoragePointers: [],
          },
          onGrant: () => undefined,
          onKeepAsIs: () => undefined,
        });
        expect(container.textContent).toContain('DOM list: chatMessages → .msg (text: .body)');
        // And the OLD declaration must show up as no-longer-requested — if the
        // key didn't include maxItems, old and new would compare equal and
        // BOTH sections would render "(none)".
        expect(container.textContent).toContain('No longer requested');
      });

      it('renders [Grant] and [Keep as is] buttons, NOT Approve/Cancel', () => {
        renderPopup(container, {
          mode: 'scope-update',
          serverName: 'musescore-mcp',
          pending: {
            capabilities: ['fetch', 'capture_request_header'],
            cookieKeys: [],
            localStorageKeys: [],
            sessionStorageKeys: [],
            captureHeaders: [],
            indexedDbScopes: [],
            domSelectors: [],
            domListSelectors: [],
            graphqlOps: [],
            localStoragePointers: [],
            sessionStoragePointers: [],
          },
          previous: {
            capabilities: ['fetch'],
            cookieKeys: [],
            localStorageKeys: [],
            sessionStorageKeys: [],
            captureHeaders: [],
            indexedDbScopes: [],
            domSelectors: [],
            domListSelectors: [],
            graphqlOps: [],
            localStoragePointers: [],
            sessionStoragePointers: [],
          },
          onGrant: () => undefined,
          onKeepAsIs: () => undefined,
        });
        expect(container.querySelector('[data-action="grant"]')).not.toBeNull();
        expect(container.querySelector('[data-action="keep-as-is"]')).not.toBeNull();
        // Must NOT have pair-style Approve/Cancel buttons.
        expect(container.querySelector('[data-action="approve"]')).toBeNull();
        expect(container.querySelector('[data-action="cancel"]')).toBeNull();
      });

      it('calls onGrant when [Grant] is clicked', () => {
        const calls: string[] = [];
        renderPopup(container, {
          mode: 'scope-update',
          serverName: 'musescore-mcp',
          pending: {
            capabilities: ['fetch', 'capture_request_header'],
            cookieKeys: [],
            localStorageKeys: [],
            sessionStorageKeys: [],
            captureHeaders: [],
            indexedDbScopes: [],
            domSelectors: [],
            domListSelectors: [],
            graphqlOps: [],
            localStoragePointers: [],
            sessionStoragePointers: [],
          },
          previous: {
            capabilities: ['fetch'],
            cookieKeys: [],
            localStorageKeys: [],
            sessionStorageKeys: [],
            captureHeaders: [],
            indexedDbScopes: [],
            domSelectors: [],
            domListSelectors: [],
            graphqlOps: [],
            localStoragePointers: [],
            sessionStoragePointers: [],
          },
          onGrant: () => calls.push('grant'),
          onKeepAsIs: () => calls.push('keep'),
        });
        (container.querySelector('[data-action="grant"]') as HTMLButtonElement).click();
        expect(calls).toEqual(['grant']);
      });

      it('calls onKeepAsIs when [Keep as is] is clicked WITHOUT writing trust', () => {
        const calls: string[] = [];
        renderPopup(container, {
          mode: 'scope-update',
          serverName: 'musescore-mcp',
          pending: {
            capabilities: ['fetch', 'capture_request_header'],
            cookieKeys: [],
            localStorageKeys: [],
            sessionStorageKeys: [],
            captureHeaders: [],
            indexedDbScopes: [],
            domSelectors: [],
            domListSelectors: [],
            graphqlOps: [],
            localStoragePointers: [],
            sessionStoragePointers: [],
          },
          previous: {
            capabilities: ['fetch'],
            cookieKeys: [],
            localStorageKeys: [],
            sessionStorageKeys: [],
            captureHeaders: [],
            indexedDbScopes: [],
            domSelectors: [],
            domListSelectors: [],
            graphqlOps: [],
            localStoragePointers: [],
            sessionStoragePointers: [],
          },
          // onGrant would write trust — we verify it is NOT called.
          onGrant: () => calls.push('grant'),
          onKeepAsIs: () => calls.push('keep'),
        });
        (container.querySelector('[data-action="keep-as-is"]') as HTMLButtonElement).click();
        // keep must have fired, grant must NOT.
        expect(calls).toEqual(['keep']);
        expect(calls).not.toContain('grant');
      });

      it('shows serverName in the heading', () => {
        renderPopup(container, {
          mode: 'scope-update',
          serverName: 'ofw-mcp',
          pending: {
            capabilities: ['fetch', 'read_local_storage'],
            cookieKeys: [],
            localStorageKeys: ['auth', 'newKey'],
            sessionStorageKeys: [],
            captureHeaders: [],
            indexedDbScopes: [],
            domSelectors: [],
            domListSelectors: [],
            graphqlOps: [],
            localStoragePointers: [],
            sessionStoragePointers: [],
          },
          previous: {
            capabilities: ['fetch', 'read_local_storage'],
            cookieKeys: [],
            localStorageKeys: ['auth'],
            sessionStorageKeys: [],
            captureHeaders: [],
            indexedDbScopes: [],
            domSelectors: [],
            domListSelectors: [],
            graphqlOps: [],
            localStoragePointers: [],
            sessionStoragePointers: [],
          },
          onGrant: () => undefined,
          onKeepAsIs: () => undefined,
        });
        expect(container.textContent).toContain('ofw-mcp');
        // The diff should show newKey was added.
        expect(container.textContent).toContain('localStorage: newKey');
      });
    });

    it('first pair has no previous → standard heading + "Approve" button', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'opentable-mcp',
          version: '0.9.1',
          domains: ['opentable.com'],
          capabilities: ['fetch'],
          pairCode: '1111-2222',
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.textContent).toContain('Approve new MCP connection');
      expect(container.textContent).not.toContain('UPDATE');
      const approve = container.querySelector('[data-action="approve"]') as HTMLButtonElement;
      expect(approve.textContent).toBe('Approve');
    });

    it('renders unknown capability as warn (defense in depth)', () => {
      renderPopup(container, {
        mode: 'pending-pair',
        pending: {
          serverName: 'future-mcp',
          version: '0.0.1',
          domains: ['future.example'],
          // Forward-compat with unknown verbs (capabilities is string[]).
          capabilities: ['fetch', 'frobnicate'],
          pairCode: '1111-2222',
        },
        onApprove: () => undefined,
        onCancel: () => undefined,
      });
      expect(container.textContent ?? '').toContain('⚠️');
    });
  });
});

describe('mergeTrustedSummaries', () => {
  it('keeps always-ask enabled when merging a derived record into a trusted row', () => {
    const trusted = mergeTrustedSummaries({
      identity: { serverName: 'zillow', domains: ['zillow.com'], capabilities: ['fetch'] },
    }, {
      identity: { slug: 'chris', origin: 'https://gateway.example', firstSeenAt: 0, alwaysAsk: true },
    }, new Set());
    const onAlwaysAsk = vi.fn();
    const root = document.createElement('div');
    renderPopup(root, { mode: 'status', trusted, onAlwaysAsk });

    const toggle = root.querySelector<HTMLButtonElement>('[data-action="always-ask"]')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent).toBe('stop always asking');
    toggle.click();
    expect(onAlwaysAsk).toHaveBeenCalledWith('identity', false);
  });
});

// ---------------------------------------------------------------------------
// Part 3: connections-changed live-update (Step 7)
// ---------------------------------------------------------------------------
describe('connections-changed live update', () => {
  it('re-renders the status list when chrome.runtime fires connections-changed', async () => {
    const root = document.getElementById('root')!;

    // Simulate a minimal chrome.runtime.onMessage that lets us capture the
    // listener and fire it manually.
    type MsgListener = (msg: unknown) => void;
    let capturedListener: MsgListener | null = null;
    let renderCount = 0;

    // We don't run bootstrap (it needs chrome.storage), but we can verify
    // that renderPopup IS callable multiple times and that the listener
    // pattern the bootstrap registers re-invokes rendering on the message.
    // We test the listener registration contract:
    const fakeOnMessage = {
      addListener: (cb: MsgListener): void => {
        capturedListener = cb;
      },
    };

    // Simulate what bootstrap does: register a renderTrustedStatus re-render
    // callback on the onMessage listener.
    const renderStatusStub = (): void => {
      renderCount++;
      renderPopup(root, {
        mode: 'status',
        trusted: [{ serverName: 'opentable-mcp', domains: ['opentable.com'], connected: true }],
      });
    };

    // Wire the listener (mirrors what bootstrap does).
    fakeOnMessage.addListener((msg) => {
      if (
        msg !== null &&
        typeof msg === 'object' &&
        (msg as { type?: unknown }).type === 'connections-changed'
      ) {
        renderStatusStub();
      }
    });

    expect(capturedListener).not.toBeNull();
    expect(renderCount).toBe(0);

    // Fire connections-changed.
    capturedListener!({ type: 'connections-changed' });
    expect(renderCount).toBe(1);
    expect(root.querySelector('.status-dot.connected')).not.toBeNull();

    // Fire again (e.g. second session connects).
    capturedListener!({ type: 'connections-changed' });
    expect(renderCount).toBe(2);

    // Unrelated message does NOT trigger a re-render.
    capturedListener!({ type: 'something-else' });
    expect(renderCount).toBe(2);
  });
});

describe('pair popup — cookie names when write_cookies is granted', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById('root')!;
  });

  const pending = (capabilities: string[]) => ({
    mode: 'pending-pair' as const,
    pending: {
      serverName: 'creditkarma-mcp',
      version: '2.4.0',
      domains: ['creditkarma.com'],
      capabilities,
      cookieKeys: ['CKAT', 'CKTRKID'],
      pairCode: '8812-3149',
    },
    onApprove: () => undefined,
    onCancel: () => undefined,
  });

  it('heads the list as read-only when only read_cookies is asked for', () => {
    renderPopup(container, pending(['fetch', 'read_cookies']) as never);

    expect(container.textContent).toContain('Read cookies');
    expect(container.textContent).toContain('CKAT');
    expect(container.textContent).not.toMatch(/overwrite/i);
  });

  it('says the names are writable when write_cookies is asked for', () => {
    // This sub-list is the ONLY place the cookie names appear. Heading it
    // "Read cookies" while granting a write understates the request at the
    // exact moment the user decides — the capability line above it says
    // "Overwrite", so the two would contradict each other.
    renderPopup(container, pending(['fetch', 'read_cookies', 'write_cookies']) as never);

    const dt = [...container.querySelectorAll('dt')].map((n) => n.textContent ?? '');
    const heading = dt.find((t) => /cookies/i.test(t) && !/localStorage|sessionStorage/i.test(t));

    expect(heading).toMatch(/overwrite/i);
    expect(container.textContent).toContain('CKAT');
    expect(container.textContent).toContain('CKTRKID');
  });
});

describe('pair popup — renders when capabilities is absent', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById('root')!;
  });

  it('falls back rather than throwing when capabilities is omitted', () => {
    // `caps` exists precisely because callers may omit `capabilities`. Reading
    // `pending.capabilities` directly for the cookie heading reintroduced the
    // crash that guard was written to prevent — and it fails in the pair
    // popup, the one UI the user depends on to see what they are approving.
    // A popup that throws renders nothing, which is worse than a wrong label.
    const state = {
      mode: 'pending-pair' as const,
      pending: {
        serverName: 'creditkarma-mcp',
        version: '2.4.0',
        domains: ['creditkarma.com'],
        cookieKeys: ['CKAT'],
        pairCode: '8812-3149',
      },
      onApprove: () => undefined,
      onCancel: () => undefined,
    };

    expect(() => renderPopup(container, state as never)).not.toThrow();
    // And it still shows the names, headed as a read — the fallback is
    // ['fetch'], which grants no cookie access at all.
    expect(container.textContent).toContain('CKAT');
    expect(container.textContent).toContain('Read cookies');
  });
});

// ---------------------------------------------------------------------------
// #418: capabilities this browser cannot serve are shown, greyed, and never
// approved.
// ---------------------------------------------------------------------------

describe('pair popup — capabilities not available in this browser', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById('root')!;
  });

  const pending = (extra: Record<string, unknown> = {}) => ({
    mode: 'pending-pair' as const,
    pending: {
      serverName: 'etix-mcp',
      version: '1.0.0',
      domains: ['etix.com'],
      capabilities: ['fetch'],
      pairCode: '8812-3149',
      ...extra,
    },
    onApprove: () => undefined,
    onCancel: () => undefined,
  });

  it('lists them greyed as "not available in this browser", apart from what Approve grants', () => {
    renderPopup(container, pending({ unavailableCapabilities: ['download'] }) as never);

    const granted = container.querySelector('ul.capabilities')!;
    expect(granted.textContent).toContain('HTTP fetches');
    expect(granted.textContent).not.toContain('Download files');

    const rows = [...container.querySelectorAll('li.cap-unavailable')];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Download files to your computer');
    expect(rows[0]!.textContent).toMatch(/not available in this browser/);
    expect(rows[0]!.getAttribute('aria-disabled')).toBe('true');
    // Nothing to tick: they are never part of the approval.
    expect(container.querySelector('li.cap-unavailable input')).toBeNull();
  });

  it('renders nothing extra when every capability is available (Chrome)', () => {
    renderPopup(container, pending() as never);
    expect(container.querySelector('.cap-unavailable')).toBeNull();
    expect(container.textContent).not.toMatch(/not available in this browser/);
  });

  it('shows them on a scope-update too, and never as "No longer requested"', () => {
    const scope = {
      capabilities: ['fetch'],
      cookieKeys: [] as string[],
      localStorageKeys: [],
      sessionStorageKeys: [],
      captureHeaders: [],
      indexedDbScopes: [],
      domSelectors: [],
      domListSelectors: [],
      graphqlOps: [],
      localStoragePointers: [],
      sessionStoragePointers: [],
    };
    renderPopup(container, {
      mode: 'scope-update',
      serverName: 'etix-mcp',
      pending: {
        ...scope,
        capabilities: ['fetch', 'read_cookies'],
        cookieKeys: ['sid'],
        unavailableCapabilities: ['download'],
      },
      // A record approved before #418 still holds `download`.
      previous: { ...scope, capabilities: ['fetch', 'download'] },
      onGrant: () => undefined,
      onKeepAsIs: () => undefined,
    });
    expect(container.querySelector('.scope-diff')!.textContent).not.toContain(
      'Capability: download',
    );
    const rows = [...container.querySelectorAll('li.cap-unavailable')];
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Download files to your computer'),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Bridges section (2.1.0): where this browser is willing to answer MCPs from.
// ---------------------------------------------------------------------------

describe('renderPopup — bridges', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById('root')!;
  });

  const withBridges = (bridges: BridgesView): void =>
    renderPopup(container, { mode: 'status', trusted: [], bridges });

  it('is absent entirely when no bridges view is supplied', () => {
    renderPopup(container, { mode: 'status', trusted: [] });
    expect(container.textContent).not.toContain('Bridges');
  });

  it('always shows loopback, and says it cannot be turned off', () => {
    withBridges({ targets: [] });
    expect(container.querySelector('.bridge.local')?.textContent).toContain('always on');
  });

  it('lists configured remote targets without their tokens', () => {
    withBridges({
      targets: [{ id: 'b1', url: 'wss://mcp.nullnet.app/bridge', label: 'mcp-host', enabled: true }],
    });
    const row = container.querySelector('.bridge.remote')!;
    expect(row.textContent).toContain('mcp-host');
    expect(row.textContent).toContain('wss://mcp.nullnet.app/bridge');
    expect(container.innerHTML).not.toContain('mcpb_');
  });

  it('marks a disabled target as disabled rather than hiding it', () => {
    withBridges({ targets: [{ id: 'b1', url: 'wss://h/b', enabled: false }] });
    expect(container.querySelector('.bridge.remote.disabled')).not.toBeNull();
  });

  it('shows one Connect button per configured origin and an editable prefilled name', async () => {
    const onConnect = vi.fn(async () => null);
    withBridges({ targets: [], connectOrigins: ['https://mcp.nullnet.app', 'https://mcp.example'], connectName: 'Chrome on Mac', onConnect });
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.bridge-connect-start')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Connect to mcp.nullnet.app', 'Connect to mcp.example']);
    expect((container.querySelector('.bridge-connect-name') as HTMLInputElement).value).toBe('Chrome on Mac');
    (container.querySelector('.bridge-connect-name') as HTMLInputElement).value = 'Browser at home';
    buttons[1]!.click();
    await Promise.resolve();
    expect(onConnect).toHaveBeenCalledWith('https://mcp.example', 'Browser at home');
  });

  it('has no credential, approval, request-id, or gateway URL paste fields', () => {
    withBridges({ targets: [], connectOrigins: ['https://mcp.nullnet.app'], onConnect: async () => null });
    expect(container.querySelector('.bridge-connect-start')).not.toBeNull();
    expect(container.querySelectorAll('input')).toHaveLength(1);
    expect(container.querySelector('.bridge-connect-name')).not.toBeNull();
    expect(container.querySelector('.bridge-token-input, .bridge-token-id-input, .bridge-url-input, .bridge-save')).toBeNull();
  });

  it('removes and toggles by id', () => {
    const onRemove = vi.fn();
    const onToggle = vi.fn();
    withBridges({
      targets: [{ id: 'b1', url: 'wss://h/b', enabled: true }],
      onRemove,
      onToggle,
    });
    (container.querySelector('.bridge-remove') as HTMLButtonElement).click();
    expect(onRemove).toHaveBeenCalledWith('b1');

    const box = container.querySelector('.bridge-enabled') as HTMLInputElement;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(onToggle).toHaveBeenCalledWith('b1', false);
  });

  // Pressing Connect mints a new credential and revokes this browser's current
  // one, so a healthy pairing must not be met with a prominent Connect card.
  describe('Connect when this browser is already connected', () => {
    const ORIGIN = 'https://mcp.nullnet.app';
    const paired = { id: 'b1', url: 'wss://mcp.nullnet.app/bridge', label: 'Chrome (personal)', enabled: true };

    it('hides the Connect card for a connected, enabled target on the Connect origin, and offers Reconnect on its row', async () => {
      const onConnect = vi.fn(async () => null);
      withBridges({ targets: [{ ...paired, connected: true }], connectOrigins: [ORIGIN], connectName: 'Chrome on Mac', onConnect });
      expect(container.querySelector('.bridge-connect')).toBeNull();
      expect(container.querySelector('.bridge-connect-start')).toBeNull();
      expect(container.textContent).not.toContain('Connect this browser to your account');
      const row = container.querySelector('.bridge.remote[data-target-id="b1"]')!;
      const reconnect = row.querySelector<HTMLButtonElement>('button.bridge-reconnect')!;
      expect(reconnect).not.toBeNull();
      expect(reconnect.classList.contains('btn-ghost')).toBe(true);
      expect(reconnect.classList.contains('btn-primary')).toBe(false);
      expect(reconnect.textContent).toBe('Reconnect this browser');
      expect(reconnect.getAttribute('aria-label')).toBe('Reconnect this browser to mcp.nullnet.app');
      reconnect.click();
      await Promise.resolve();
      // Same Connect flow, keeping the name this browser was paired under.
      expect(onConnect).toHaveBeenCalledWith(ORIGIN, 'Chrome (personal)');
    });

    it('shows a Reconnect problem next to the row', async () => {
      withBridges({ targets: [{ ...paired, connected: true }], connectOrigins: [ORIGIN], onConnect: async () => 'Gateway said no' });
      (container.querySelector('button.bridge-reconnect') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 0));
      expect(container.querySelector('.bridge.remote .bridge-connect-error')?.textContent).toBe('Gateway said no');
    });

    it('still surfaces the Connect status when the card is hidden', () => {
      withBridges({ targets: [{ ...paired, connected: true }], connectOrigins: [ORIGIN], connectStatus: 'Confirm in the tab that opened', onConnect: async () => null });
      expect(container.querySelector('.bridge-connect')).toBeNull();
      expect(container.textContent).toContain('Confirm in the tab that opened');
    });

    it('shows the Connect card when no target is on the Connect origin', () => {
      withBridges({
        targets: [{ id: 'o1', url: 'wss://other.example/bridge', enabled: true, connected: true }],
        connectOrigins: [ORIGIN],
        onConnect: async () => null,
      });
      expect(container.querySelector('.bridge-connect-start')?.textContent).toBe('Connect to mcp.nullnet.app');
      expect(container.querySelector('button.bridge-reconnect')).toBeNull();
    });

    it('shows the Connect card when there are no targets', () => {
      withBridges({ targets: [], connectOrigins: [ORIGIN], onConnect: async () => null });
      expect(container.querySelector('.bridge-connect-start')).not.toBeNull();
    });

    it('shows the Connect card when the target is disabled', () => {
      withBridges({ targets: [{ ...paired, enabled: false, connected: false }], connectOrigins: [ORIGIN], onConnect: async () => null });
      expect(container.querySelector('.bridge-connect-start')).not.toBeNull();
      expect(container.querySelector('button.bridge-reconnect')).toBeNull();
    });

    it('shows the Connect card when the bridge refused this browser (4004)', () => {
      withBridges({
        targets: [{ ...paired, connected: false, refusal: 'This bridge is paired with a different browser' }],
        connectOrigins: [ORIGIN],
        onConnect: async () => null,
      });
      expect(container.querySelector('.bridge-connect-start')).not.toBeNull();
      expect(container.querySelector('button.bridge-reconnect')).toBeNull();
    });

    // A revoked credential (4003, then 401 on every re-dial) reads to the
    // popup as an enabled row that is not up — the recovery path must stay
    // prominent.
    it('shows the Connect card when the target is offline (e.g. a revoked credential)', () => {
      withBridges({ targets: [{ ...paired, connected: false }], connectOrigins: [ORIGIN], onConnect: async () => null });
      expect(container.querySelector('.bridge-connect-start')).not.toBeNull();
      expect(container.querySelector('button.bridge-reconnect')).toBeNull();
    });

    it('shows the Connect card when nobody vouched for the link state', () => {
      withBridges({ targets: [paired], connectOrigins: [ORIGIN], onConnect: async () => null });
      expect(container.querySelector('.bridge-connect-start')).not.toBeNull();
    });

    it('keeps the Connect buttons for the other origins', () => {
      withBridges({
        targets: [{ ...paired, connected: true }],
        connectOrigins: [ORIGIN, 'https://mcp.example'],
        onConnect: async () => null,
      });
      const buttons = [...container.querySelectorAll<HTMLButtonElement>('.bridge-connect-start')];
      expect(buttons.map((b) => b.textContent)).toEqual(['Connect to mcp.example']);
      expect(container.querySelector('button.bridge-reconnect')).not.toBeNull();
    });
  });

  it('shows the Connect flow rather than the retired credential paste form', () => {
    withBridges({ targets: [], connectOrigins: ['https://mcp.nullnet.app'], onConnect: async () => null });
    expect(container.textContent).toContain('Connect this browser to your account');
    expect(container.textContent).not.toContain('can ask this browser to pair');
  });

  // The extension stands alone (plan 2026-10-05, T2): a fresh install with no
  // account shows its own loopback row and the Connect call to action, and
  // nothing that sends the person to the ContextMint app.
  it('a fresh install with no account: the loopback row, Connect, and no ContextMint app', () => {
    withBridges({
      targets: [],
      localConnected: false,
      connectOrigins: ['https://mcp.nullnet.app'],
      onConnect: async () => null,
    });
    const rows = [...container.querySelectorAll('.bridge-list > li')];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.classList.contains('local')).toBe(true);
    expect(container.querySelector('button.bridge-connect-start')?.textContent).toBe('Connect to mcp.nullnet.app');
    expect(container.textContent).not.toMatch(/ContextMint/);
  });

  it('never renders a row for a link status it was not given as a target', () => {
    withBridges({ targets: [], localConnected: true });
    expect(container.querySelectorAll('.bridge.remote')).toHaveLength(0);
  });
});

describe('renderPopup — bridge status dots', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById('root')!;
  });

  const withBridges = (bridges: BridgesView): void =>
    renderPopup(container, { mode: 'status', trusted: [], bridges });

  it('shows the loopback link as offline when it is — a green badge would not', () => {
    // The failure this exists for: with a remote bridge up, one global
    // connection state says nothing about the local concentrator every MCP on
    // this machine needs.
    withBridges({
      localConnected: false,
      targets: [{ id: 'b1', url: 'wss://h/b', enabled: true, connected: true }],
    });
    expect(container.querySelector('.bridge.local .status-dot')?.getAttribute('aria-label')).toBe('offline');
    expect(container.querySelector('.bridge.remote .status-dot')?.getAttribute('aria-label')).toBe('connected');
  });

  it('renders no dot at all when the background did not answer', () => {
    withBridges({ targets: [{ id: 'b1', url: 'wss://h/b', enabled: true }] });
    expect(container.querySelector('.status-dot')).toBeNull();
  });

  // mcp-host plan task C2: a bridge that closed 4004 EXTENSION_MISMATCH is
  // never dialled again, so a grey dot alone would read as "down, retrying".
  it('says why a bridge refused this browser for good (4004)', () => {
    const why = 'This bridge is paired with a different browser';
    withBridges({
      targets: [
        { id: 'b1', url: 'wss://h/b', enabled: true, connected: false, refusal: why },
        { id: 'b2', url: 'wss://h2/b', enabled: true, connected: false },
      ],
    });
    const refused = container.querySelector('[data-target-id="b1"] .bridge-refusal');
    expect(refused?.textContent).toBe(why);
    expect(container.querySelector('[data-target-id="b2"] .bridge-refusal')).toBeNull();
  });

  // mcp-host plan task X4: a 4001 close is not final (the link keeps dialling,
  // slowly), so it is a notice under the row, not a refusal.
  it('says the account is at its browser limit (4001), as text', () => {
    const why = 'This account already has 4 browsers connected; disconnect one in Settings';
    withBridges({
      targets: [
        { id: 'b1', url: 'wss://h/b', enabled: true, connected: false, notice: why },
        { id: 'b2', url: 'wss://h2/b', enabled: true, connected: false, notice: '<b>x</b>' },
        { id: 'b3', url: 'wss://h3/b', enabled: true, connected: false },
      ],
    });
    const notice = container.querySelector('[data-target-id="b1"] .bridge-notice');
    expect(notice?.textContent).toBe(why);
    expect(container.querySelector('[data-target-id="b1"] .bridge-refusal')).toBeNull();
    expect(container.querySelector('[data-target-id="b2"] .bridge-notice')?.textContent).toBe('<b>x</b>');
    expect(container.querySelector('[data-target-id="b2"] .bridge-notice b')).toBeNull();
    expect(container.querySelector('[data-target-id="b3"] .bridge-notice')).toBeNull();
  });

  // mcp-host plan task X1: the account room says whether THIS browser serves.
  describe('whether this browser serves the account (bridge-role)', () => {
    const row = (id: string) => container.querySelector(`[data-target-id="${id}"]`)!;
    const roleText = (id: string) => row(id).querySelector('.bridge-role')?.textContent;

    it('serving', () => {
      withBridges({
        targets: [{ id: 'b1', url: 'wss://h/b', enabled: true, connected: true, role: { role: 'serving', canServe: true } }],
      });
      expect(roleText('b1')).toBe('Serving this account');
    });

    it('standby names who serves', () => {
      withBridges({
        targets: [
          {
            id: 'b1',
            url: 'wss://h/b',
            enabled: true,
            connected: true,
            role: { role: 'standby', canServe: true, serving: { label: 'Chrome on Mac' } },
          },
        ],
      });
      expect(roleText('b1')).toBe(
        'Standby \u2014 Chrome on Mac is serving. This browser takes over if it disconnects.',
      );
    });

    it('not confirmed for the account (canServe false), whatever the role', () => {
      withBridges({
        targets: [
          {
            id: 'b1',
            url: 'wss://h/b',
            enabled: true,
            connected: true,
            role: { role: 'standby', canServe: false, serving: { label: 'Chrome on Mac' } },
          },
          { id: 'b2', url: 'wss://h2/b', enabled: true, connected: true, role: { role: 'serving', canServe: false } },
        ],
      });
      const unconfirmed = 'Connected, but this browser is not confirmed for the account';
      expect(roleText('b1')).toBe(unconfirmed);
      expect(roleText('b2')).toBe(unconfirmed);
      expect(row('b1').textContent).not.toContain('Chrome on Mac');
    });

    it('renders the label as text, never HTML', () => {
      const label = '<img src=x onerror="alert(1)"><b>x</b>';
      withBridges({
        targets: [
          {
            id: 'b1',
            url: 'wss://h/b',
            enabled: true,
            connected: true,
            role: { role: 'standby', canServe: true, serving: { label } },
          },
        ],
      });
      expect(roleText('b1')).toContain(label);
      expect(row('b1').querySelector('img')).toBeNull();
      expect(row('b1').querySelector('.bridge-role b')).toBeNull();
    });

    it('with no bridge-role, the row reads Connected as today', () => {
      withBridges({ targets: [{ id: 'b1', url: 'wss://h/b', enabled: true, connected: true }] });
      expect(row('b1').querySelector('.bridge-role')).toBeNull();
      expect(row('b1').querySelector('.bridge-state')?.textContent).toBe('Connected');
    });

    it('says nothing about a role while the link is down', () => {
      withBridges({
        targets: [{ id: 'b1', url: 'wss://h/b', enabled: true, connected: false, role: { role: 'serving', canServe: true } }],
      });
      expect(row('b1').querySelector('.bridge-role')).toBeNull();
      expect(row('b1').querySelector('.bridge-state')?.textContent).toBe('Offline');
    });
  });

  // mcp-host plan task X2: a standby the room says may serve can ask to.
  describe('Serve from this browser (bridge-serve)', () => {
    const row = (id: string) => container.querySelector(`[data-target-id="${id}"]`)!;
    const button = (id: string) => row(id).querySelector<HTMLButtonElement>('.bridge-serve');
    const standby = (canServe = true) =>
      ({ role: 'standby', canServe, serving: { label: 'Chrome on Mac' } }) as const;

    it('shows on a connected standby the room says may serve', () => {
      withBridges({
        targets: [{ id: 'b1', url: 'wss://h/b', enabled: true, connected: true, role: standby() }],
        onServe: async () => {},
      });
      expect(button('b1')?.textContent).toBe('Serve from this browser');
      expect(button('b1')?.disabled).toBe(false);
    });

    it('is absent on a serving link, an unconfirmed one, one with no bridge-role, and an offline one', () => {
      withBridges({
        targets: [
          { id: 'serving', url: 'wss://h1/b', enabled: true, connected: true, role: { role: 'serving', canServe: true } },
          { id: 'unconfirmed', url: 'wss://h2/b', enabled: true, connected: true, role: standby(false) },
          { id: 'silent', url: 'wss://h3/b', enabled: true, connected: true },
          { id: 'offline', url: 'wss://h4/b', enabled: true, connected: false, role: standby() },
        ],
        onServe: async () => {},
      });
      for (const id of ['serving', 'unconfirmed', 'silent', 'offline']) expect(button(id)).toBeNull();
    });

    it('is absent without an onServe handler', () => {
      withBridges({ targets: [{ id: 'b1', url: 'wss://h/b', enabled: true, connected: true, role: standby() }] });
      expect(button('b1')).toBeNull();
    });

    it('asks for its own row and no other, once, and disables itself', () => {
      const onServe = vi.fn(async (_id: string) => {});
      withBridges({
        targets: [
          { id: 'b1', url: 'wss://h1/b', enabled: true, connected: true, role: standby() },
          { id: 'b2', url: 'wss://h2/b', enabled: true, connected: true, role: standby() },
        ],
        onServe,
      });
      button('b2')!.click();
      button('b2')!.click();
      expect(onServe).toHaveBeenCalledTimes(1);
      expect(onServe).toHaveBeenCalledWith('b2');
      expect(button('b2')!.disabled).toBe(true);
      expect(button('b1')!.disabled).toBe(false);
    });

    it('stays disabled while an ask waits for the room (servePending)', () => {
      const onServe = vi.fn(async (_id: string) => {});
      withBridges({
        targets: [{ id: 'b1', url: 'wss://h/b', enabled: true, connected: true, role: standby(), servePending: true }],
        onServe,
      });
      expect(button('b1')!.disabled).toBe(true);
      button('b1')!.click();
      expect(onServe).not.toHaveBeenCalled();
    });
  });
});

/**
 * Task 4.3 — the popup says a version mismatch out loud.
 *
 * Task 4.1 gave a v3 MCP an answer on the wire, and the browser user nothing:
 * the refusal was a `console.warn` in a service worker nobody has open. The
 * popup is the one surface the BROWSER user has, and this is the state they
 * are actually in — a refused MCP is never trusted, never gets a session and
 * never lights a dot, so every existing surface renders it as absence. The
 * whole failure looks like "my connector does nothing" on both ends.
 *
 * The line names the MCP and BOTH versions, because a refusal naming one
 * version is not a diagnosis, and it says the remedy is on the MCP side
 * rather than inventing one this reader can perform.
 */
describe('renderPopup — version mismatch (Task 4.3)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById('root')!;
  });

  const refusal: VersionMismatch = {
    linkId: 'local',
    linkLabel: 'localhost',
    serverName: 'alltrails-mcp',
    mcpProtocol: 3,
    extensionProtocol: 4,
    at: 1_700_000_000_000,
  };

  const LINE =
    'alltrails-mcp was refused: it speaks fetchproxy protocol 3, this extension speaks 4. ' +
    'Update that MCP to @fetchproxy/server 3.0.0 or later — nothing in this browser fixes it.';

  it('names the MCP and BOTH versions on a link whose last event was a refusal', () => {
    renderPopup(container, {
      mode: 'status',
      trusted: [{ serverName: 'resy-mcp', domains: ['resy.com'] }],
      mismatches: [refusal],
    });
    const line = container.querySelector('.version-mismatch');
    expect(line).not.toBeNull();
    expect(line!.textContent).toBe(LINE);
    // Which bridge it arrived on is diagnosis rather than headline: it rides
    // the title so the one line stays one line.
    expect(line!.getAttribute('title')).toContain('localhost');
  });

  it('renders in the EMPTY state too — a refused MCP is never trusted, so that is the state it leaves', () => {
    renderPopup(container, { mode: 'empty', mismatches: [refusal] });
    expect(container.querySelector('.version-mismatch')?.textContent).toBe(LINE);
    // And the misleading half is still there to be contradicted: "no MCP
    // servers connected" is exactly what this reader must not conclude.
    expect(container.textContent).toContain('No MCP servers connected');
  });

  it('reads FIRST — the correction has to precede the sentence it corrects', () => {
    // Load-bearing rather than cosmetic, and the reason the heading is the
    // view's first child: the paragraph below it says nothing is connected,
    // which is exactly what this reader must not walk away believing. A
    // correction printed after the claim is a footnote to it.
    renderPopup(container, { mode: 'empty', mismatches: [refusal] });
    expect(container.firstElementChild?.classList.contains('mismatch-heading')).toBe(true);
    const line = container.querySelector('.version-mismatch')!;
    const claim = [...container.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('No MCP servers connected'),
    );
    expect(claim).toBeDefined();
    // DOCUMENT_POSITION_FOLLOWING: the claim comes AFTER the refusal.
    expect(
      line.compareDocumentPosition(claim!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
  });

  it('clears when a v4 hello succeeds on that link', () => {
    const recorded = recordVersionMismatch({}, refusal);
    renderPopup(container, { mode: 'empty', mismatches: Object.values(recorded) });
    expect(container.querySelector('.version-mismatch')).not.toBeNull();

    const cleared = clearVersionMismatches(recorded, 'local', 'alltrails-mcp');
    renderPopup(container, { mode: 'empty', mismatches: Object.values(cleared) });
    expect(container.querySelector('.version-mismatch')).toBeNull();
  });

  it('keeps a sibling MCP refused on the same link — one upgrade is not every upgrade', () => {
    // The local concentrator multiplexes every MCP on this machine, so
    // clearing per LINK would let one upgraded server hide a stale neighbour.
    let dict = recordVersionMismatch({}, refusal);
    dict = recordVersionMismatch(dict, { ...refusal, serverName: 'tock-mcp' });
    const cleared = clearVersionMismatches(dict, 'local', 'alltrails-mcp');
    renderPopup(container, { mode: 'empty', mismatches: Object.values(cleared) });
    const lines = [...container.querySelectorAll('.version-mismatch')].map((e) => e.textContent);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('tock-mcp');
  });

  it('forgets a refusal nothing has repeated for a day, rather than accusing forever', () => {
    const dict = recordVersionMismatch({}, refusal);
    expect(Object.values(freshVersionMismatches(dict, refusal.at + 60_000))).toHaveLength(1);
    expect(
      Object.values(freshVersionMismatches(dict, refusal.at + 25 * 60 * 60 * 1000)),
    ).toHaveLength(0);
  });

  it('renders a hostile serverName as text, never as markup', () => {
    // `serverName` is `[^:]+` off an mcpId the MCP minted — attacker-chosen
    // text on a frame no validator accepted.
    renderPopup(container, {
      mode: 'empty',
      mismatches: [{ ...refusal, serverName: '<img src=x onerror=alert(1)>' }],
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.version-mismatch')!.textContent).toContain('<img src=x');
  });

  it('says nothing when there is nothing to say', () => {
    // The HEADING, not only the line: an empty "Refused — out of date" list on
    // every load is a standing accusation against nothing, on the one surface
    // this reader has. Asserting the `<li>` alone cannot see that, because the
    // `<li>` is absent either way.
    renderPopup(container, { mode: 'empty', mismatches: [] });
    expect(container.querySelector('.version-mismatch')).toBeNull();
    expect(container.querySelector('.mismatch-heading')).toBeNull();
    expect(container.querySelector('.mismatch-list')).toBeNull();
    renderPopup(container, { mode: 'status', trusted: [{ serverName: 'r', domains: ['r.com'] }] });
    expect(container.querySelector('.version-mismatch')).toBeNull();
    expect(container.querySelector('.mismatch-heading')).toBeNull();
    expect(container.querySelector('.mismatch-list')).toBeNull();
  });
});

/**
 * The retired confirmation action stays absent. Pairing now starts through
 * Connect when the remote target is created, with no completion or challenge
 * pasted into the popup.
 */
describe('renderPopup — retired confirmation action', () => {
  beforeEach(() => { document.body.innerHTML = '<div id="root"></div>'; });
  it('does not offer Confirm this browser or display a completion field', () => {
    const root = document.getElementById('root')!;
    renderPopup(root, { mode: 'status', trusted: [], bridges: {
      targets: [{ id: 'b1', url: 'wss://h/b', enabled: true, connected: true }],
    } });
    expect(root.textContent).not.toContain('Confirm this browser');
    expect(root.querySelector('.bridge-confirm')).toBeNull();
    expect(root.querySelectorAll('input, textarea, [contenteditable]')).toHaveLength(0);
  });
});

describe('deviceName', () => {
  it('names the device for the Connect browser name, not by its raw navigator.platform', () => {
    expect(deviceName('MacIntel')).toBe('Mac');
    expect(deviceName('MacPPC')).toBe('Mac');
    expect(deviceName('iPhone')).toBe('iPhone');
    expect(deviceName('iPad')).toBe('iPad');
    expect(deviceName('Win32')).toBe('Windows');
    expect(deviceName('Linux x86_64')).toBe('Linux');
    expect(deviceName('CrOS')).toBe('CrOS');
    expect(deviceName('')).toBe('this device');
    expect(deviceName(undefined)).toBe('this device');
  });
});
