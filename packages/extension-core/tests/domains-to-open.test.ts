import { describe, it, expect } from 'vitest';
import { domainsToOpen } from '../src/ensure-domain-tab.js';

const granted = ['teams.cloud.microsoft', 'sharepoint.com', 'substrate.office.com'];

describe('domainsToOpen', () => {
  it('opens every granted domain when the MCP names none', () => {
    expect(domainsToOpen(granted)).toEqual(granted);
  });

  it('opens only the domains the MCP named', () => {
    expect(domainsToOpen(granted, ['teams.cloud.microsoft'])).toEqual(['teams.cloud.microsoft']);
  });

  it('never opens a domain that was not granted', () => {
    expect(domainsToOpen(['sharepoint.com'], ['teams.cloud.microsoft', 'sharepoint.com'])).toEqual(['sharepoint.com']);
    expect(domainsToOpen(['sharepoint.com'], ['evil.example'])).toEqual([]);
  });
});
