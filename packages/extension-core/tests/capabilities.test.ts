import { describe, it, expect } from 'vitest';
import { unavailableCapabilities } from '../src/capabilities.js';

/**
 * The capability seam: what this browser cannot serve, found by looking for
 * the API rather than asking which browser this is. Safari 27 has no
 * `chrome.downloads`; a future Firefox build may lack something else. The
 * same detection has to be right for all of them without a platform switch.
 */

const fn = (): void => undefined;

/**
 * A method that throws unless it is called on its own namespace — the shape
 * of #7, where Safari's `tabs.query` returned `undefined` once detached. The
 * detection must only ever READ these, never call them, so a stub built from
 * them still counts as present.
 */
function receiverBound(owner: () => object): () => void {
  return function (this: unknown) {
    if (this !== owner()) throw new Error('called without its receiver');
  };
}

/** Every API a Chrome build has. Each test deletes the part it is about. */
function fullApi(): Record<string, Record<string, unknown>> {
  return {
    downloads: { download: fn, onChanged: { addListener: fn } },
    webRequest: {
      onBeforeSendHeaders: { addListener: fn },
      onBeforeRedirect: { addListener: fn },
    },
    scripting: {
      getRegisteredContentScripts: fn,
      registerContentScripts: fn,
      updateContentScripts: fn,
      unregisterContentScripts: fn,
      executeScript: fn,
    },
    cookies: { get: fn, set: fn },
  };
}

describe('unavailableCapabilities', () => {
  it('finds nothing unavailable when every API is present', () => {
    expect([...unavailableCapabilities(fullApi())]).toEqual([]);
  });

  it('finds download unavailable without chrome.downloads (Safari 27)', () => {
    const api = fullApi();
    delete api.downloads;
    expect([...unavailableCapabilities(api)]).toEqual(['download']);
  });

  it('finds download unavailable when downloads has no onChanged to wait on', () => {
    const api = fullApi();
    delete api.downloads!.onChanged;
    expect([...unavailableCapabilities(api)]).toEqual(['download']);
  });

  it('finds both capture capabilities unavailable without chrome.webRequest', () => {
    const api = fullApi();
    delete api.webRequest;
    expect([...unavailableCapabilities(api)].sort()).toEqual([
      'capture_redirect',
      'capture_request_header',
    ]);
  });

  it('finds only capture_redirect unavailable when onBeforeRedirect is missing', () => {
    const api = fullApi();
    delete api.webRequest!.onBeforeRedirect;
    expect([...unavailableCapabilities(api)]).toEqual(['capture_redirect']);
  });

  it('finds fetch_in_page and graphql unavailable without chrome.scripting', () => {
    const api = fullApi();
    delete api.scripting;
    expect([...unavailableCapabilities(api)].sort()).toEqual(['fetch_in_page', 'graphql']);
  });

  it.each([
    'getRegisteredContentScripts',
    'registerContentScripts',
    'updateContentScripts',
    'unregisterContentScripts',
    'executeScript',
  ])('finds fetch_in_page and graphql unavailable when scripting.%s is missing', (method) => {
    const api = fullApi();
    delete api.scripting![method];
    expect([...unavailableCapabilities(api)].sort()).toEqual(['fetch_in_page', 'graphql']);
  });

  it('finds write_cookies unavailable when cookies has no set', () => {
    const api = fullApi();
    delete api.cookies!.set;
    expect([...unavailableCapabilities(api)]).toEqual(['write_cookies']);
  });

  it('never refuses the capabilities that need no optional API', () => {
    // An API object with nothing optional on it at all.
    const none = unavailableCapabilities({});
    for (const cap of [
      'fetch',
      'read_cookies', // has a document.cookie path without chrome.cookies
      'read_local_storage',
      'read_session_storage',
      'read_indexed_db',
      'read_dom',
      'read_dom_list',
    ] as const) {
      expect(none.has(cap)).toBe(false);
    }
    expect([...none].sort()).toEqual([
      'capture_redirect',
      'capture_request_header',
      'download',
      'fetch_in_page',
      'graphql',
      'write_cookies',
    ]);
  });

  it('only reads methods, never calls them detached (#7)', () => {
    const api: Record<string, Record<string, unknown>> = {};
    api.downloads = {
      download: receiverBound(() => api.downloads!),
      onChanged: { addListener: fn },
    };
    const onBeforeSendHeaders: Record<string, unknown> = {};
    onBeforeSendHeaders.addListener = receiverBound(() => onBeforeSendHeaders);
    const onBeforeRedirect: Record<string, unknown> = {};
    onBeforeRedirect.addListener = receiverBound(() => onBeforeRedirect);
    api.webRequest = { onBeforeSendHeaders, onBeforeRedirect };
    api.scripting = {};
    for (const m of [
      'getRegisteredContentScripts',
      'registerContentScripts',
      'updateContentScripts',
      'unregisterContentScripts',
      'executeScript',
    ]) {
      api.scripting[m] = receiverBound(() => api.scripting!);
    }
    api.cookies = { get: fn, set: receiverBound(() => api.cookies!) };
    expect([...unavailableCapabilities(api)]).toEqual([]);
  });

  it('answers the same set for the same API object (computed once per wake)', () => {
    const api = fullApi();
    delete api.downloads;
    expect(unavailableCapabilities(api)).toBe(unavailableCapabilities(api));
  });
});
