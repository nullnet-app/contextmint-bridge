/**
 * The popup states the Chrome Web Store screenshots show, as the browser's
 * own storage would hold them. `generate.ts` seeds the trust store and the
 * remote bridges through the real vault code and answers everything else from
 * a `chrome.*` stub (`chrome-stub.ts`), so the popup that renders is the
 * shipped `dist/popup.html` + `popup.js`, reading these values the way it
 * reads a real profile's.
 *
 * Every name and domain here is illustrative (`example.com`), so the listing
 * shows no real service's name or mark. Dev-only; never bundled.
 */
import type { TrustInput } from '../../extension-core/src/trust-store.js';
import type { RemoteTarget } from '../../extension-core/src/remote-targets.js';
import type { LinkStatusMessage } from '../../extension-core/src/popup/popup.js';

export interface PopupScene {
  /** `chrome.storage.session.pendingPair` — the pairing queue. */
  pendingPair?: Record<string, unknown>;
  /** Trust records to seed into the vault, keyed by identity hash. */
  trusted: { identityHash: string; input: TrustInput }[];
  /** Remote bridge targets to seed into the vault. */
  remoteTargets: RemoteTarget[];
  /** The background's answer to `get-connected-identities`. */
  connectedHashes: string[];
  links: LinkStatusMessage[];
  /** Open the collapsed "Inactive" disclosure before the capture. */
  openInactive?: boolean;
}

export type SceneName = 'status' | 'pair' | 'scope-update';

/** 44 base64 characters, as a 32-byte key would be. Deterministic. */
const fakeKey = (seed: string): string => Buffer.from(seed.padEnd(32, '.')).toString('base64');
const fakeHash = (seed: string): string =>
  Buffer.from(seed.padEnd(32, '0')).toString('hex').slice(0, 64);

const EXT_X = fakeKey('extension-x25519');
const EXT_ED = fakeKey('extension-ed25519');

function trust(
  serverName: string,
  input: Partial<TrustInput> & Pick<TrustInput, 'domains' | 'capabilities'>,
) {
  return {
    identityHash: fakeHash(serverName),
    input: {
      serverName,
      identityX25519Pub: fakeKey(`${serverName}-x`),
      identityEd25519Pub: fakeKey(`${serverName}-ed`),
      extensionIdentityX25519Pub: EXT_X,
      extensionIdentityEd25519Pub: EXT_ED,
      ...input,
    },
  };
}

const CALENDAR = trust('calendar-mcp', {
  domains: ['calendar.example.com'],
  capabilities: ['fetch', 'read_cookies'],
  cookieKeys: ['session_id'],
});
const TICKETS = trust('tickets-mcp', {
  domains: ['tickets.example.com', 'api.tickets.example.com'],
  capabilities: ['fetch', 'capture_request_header'],
  captureHeaders: [{ host: 'api.tickets.example.com', headerName: 'authorization' }],
});
const NOTES = trust('notes-mcp', {
  domains: ['notes.example.com'],
  capabilities: ['fetch', 'read_local_storage'],
  localStorageKeys: ['auth'],
});
const FPX = trust('fpx', { domains: ['shop.example.com'], capabilities: ['fetch'] });

const CONTEXTMINT_BRIDGE: RemoteTarget = {
  id: 'bcontextmint',
  url: 'wss://contextmint.example.com/bridge',
  token: 'mcpb_illustrative-only',
  label: 'ContextMint',
  enabled: true,
};

const STATUS_LINKS: LinkStatusMessage[] = [
  { id: 'local', connected: true },
  {
    id: `remote:${CONTEXTMINT_BRIDGE.id}`,
    connected: true,
    label: 'ContextMint',
    url: CONTEXTMINT_BRIDGE.url,
  },
];

const EMPTY_SCOPE = {
  cookieKeys: [] as string[],
  localStorageKeys: [] as string[],
  sessionStorageKeys: [] as string[],
  captureHeaders: [] as { host: string; path?: string; headerName: string }[],
  indexedDbScopes: [] as { origin: string; database: string; store: string; keys: string[] }[],
  domSelectors: [] as { name: string; selector: string; attribute?: string }[],
  domListSelectors: [],
  graphqlOps: [] as { name: string; operationName: string }[],
  localStoragePointers: [],
  sessionStoragePointers: [],
};

const RECIPES_HASH = fakeHash('recipes-mcp');
const RECIPES_KEY = `${RECIPES_HASH}:${fakeHash('recipes-scope')}`;

const PAIR_RECORD = {
  key: RECIPES_KEY,
  kind: 'pair',
  identityHash: RECIPES_HASH,
  mcpIds: ['mcp-recipes-1'],
  sessionNonces: { 'mcp-recipes-1': fakeKey('nonce') },
  serverName: 'recipes-mcp',
  version: '2.4.0',
  domains: ['recipes.example.com'],
  capabilities: ['fetch', 'capture_request_header', 'read_local_storage'],
  ...EMPTY_SCOPE,
  captureHeaders: [{ host: 'api.recipes.example.com', headerName: 'authorization' }],
  localStorageKeys: ['recipes.user'],
  pairCode: '4829-3176',
  identityX25519Pub: fakeKey('recipes-mcp-x'),
  identityEd25519Pub: fakeKey('recipes-mcp-ed'),
};

const SCOPE_UPDATE_RECORD = {
  key: `${CALENDAR.identityHash}:${fakeHash('calendar-wider')}`,
  kind: 'scope-update',
  identityHash: CALENDAR.identityHash,
  mcpIds: ['mcp-calendar-1'],
  serverName: 'calendar-mcp',
  version: '1.8.0',
  domains: ['calendar.example.com'],
  capabilities: ['fetch', 'read_cookies', 'graphql'],
  ...EMPTY_SCOPE,
  cookieKeys: ['session_id'],
  graphqlOps: [{ name: 'upcoming', operationName: 'UpcomingEvents' }],
  previousScope: {
    ...EMPTY_SCOPE,
    capabilities: ['fetch', 'read_cookies'],
    cookieKeys: ['session_id'],
  },
  identityX25519Pub: CALENDAR.input.identityX25519Pub,
  identityEd25519Pub: CALENDAR.input.identityEd25519Pub,
};

export const SCENES: Record<SceneName, PopupScene> = {
  status: {
    trusted: [CALENDAR, TICKETS, NOTES, FPX],
    remoteTargets: [CONTEXTMINT_BRIDGE],
    connectedHashes: [CALENDAR.identityHash, TICKETS.identityHash, NOTES.identityHash],
    links: STATUS_LINKS,
  },
  pair: {
    pendingPair: { [PAIR_RECORD.key]: PAIR_RECORD },
    trusted: [],
    remoteTargets: [],
    connectedHashes: [],
    links: [{ id: 'local', connected: true }],
  },
  'scope-update': {
    pendingPair: { [SCOPE_UPDATE_RECORD.key]: SCOPE_UPDATE_RECORD },
    trusted: [CALENDAR],
    remoteTargets: [],
    connectedHashes: [CALENDAR.identityHash],
    links: [{ id: 'local', connected: true }],
  },
};

export interface ScreenshotSpec {
  /** Path under docs/store-assets/. */
  file: string;
  scene: SceneName;
  headline: string;
  sub: string;
}

export const SCREENSHOTS: ScreenshotSpec[] = [
  {
    file: 'screenshots/1-trusted-mcps-1280x800.png',
    scene: 'status',
    headline: 'Your AI tools, in the tabs you’re already signed into',
    sub: 'ContextMint and the MCP servers on your machine use your own browser sessions — no copied passwords, no pasted cookies.',
  },
  {
    file: 'screenshots/2-pair-prompt-1280x800.png',
    scene: 'pair',
    headline: 'Nothing connects until you match the code',
    sub: 'Every server shows an 8-digit pair code and lists exactly which domains, capabilities, storage keys and headers it wants. You approve once.',
  },
  {
    file: 'screenshots/3-scope-update-1280x800.png',
    scene: 'scope-update',
    headline: 'Wider access is an offer, never a surprise',
    sub: 'A server that asks for more keeps working with what you already approved, until you grant the rest.',
  },
];
