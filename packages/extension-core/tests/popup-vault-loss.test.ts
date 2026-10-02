// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderPopup } from '../src/popup/popup.js';

/**
 * fleet-audit #1002: when the browser lost the vault, the background mints a
 * new identity and records the loss. The popup says so — first, before "no
 * MCP servers connected", which is exactly the misleading conclusion — and
 * tells the person what to do, until they dismiss it.
 */
describe('popup — a lost vault is shown, not hidden', () => {
  let container: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById('root')!;
  });

  it('renders the notice FIRST in the empty view, with what to do', () => {
    renderPopup(container, {
      mode: 'empty',
      vaultLoss: { detectedAt: 1_700_000_000_000, onDismiss: () => {} },
    });
    const notice = container.querySelector('.vault-loss');
    expect(notice).not.toBeNull();
    expect(container.firstElementChild).toBe(notice);
    expect(notice!.textContent).toMatch(/pair .*again/i);
  });

  it('renders in the status view too', () => {
    renderPopup(container, {
      mode: 'status',
      trusted: [],
      vaultLoss: { detectedAt: 1_700_000_000_000, onDismiss: () => {} },
    });
    expect(container.querySelector('.vault-loss')).not.toBeNull();
  });

  it('the dismiss button calls back', () => {
    const onDismiss = vi.fn();
    renderPopup(container, { mode: 'empty', vaultLoss: { detectedAt: 1, onDismiss } });
    (container.querySelector('[data-action="dismiss-vault-loss"]') as HTMLButtonElement).click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('nothing is shown without a recorded loss', () => {
    renderPopup(container, { mode: 'empty' });
    expect(container.querySelector('.vault-loss')).toBeNull();
  });
});
