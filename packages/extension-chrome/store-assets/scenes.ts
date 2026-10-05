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
import type { AccountDerivedMcp, TrustedAccount } from '../../extension-core/src/account-trust-store.js';
import type { VersionMismatch } from '../../extension-core/src/lib/version-mismatch.js';

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
  /** The background's Connect status line (`bridge-connect-origins` → `status`). */
  connectStatus?: string;
  /** Account trust records to seed into the vault (the popup's Accounts section). */
  accounts?: TrustedAccount[];
  /** Account-derived MCPs to seed; the seed stamps them first seen just now ("new"). */
  derived?: { identityHash: string; mcp: Omit<AccountDerivedMcp, 'firstSeenAt' | 'lastSeenAt'> }[];
  /** A vault-loss record to seed (fleet-audit #1002's "Pairings were reset"). */
  vaultLoss?: { detectedAt: number };
  /** Protocol refusals in `storage.local`; the stub stamps `at` as just now. */
  versionMismatches?: Omit<VersionMismatch, 'at'>[];
  /** `chrome.storage.session.pendingAccountCards` — the account card queue. */
  pendingAccountCards?: Record<string, unknown>;
  /** `chrome.storage.session.pendingAccountMcpCards` — the vouched-card queue. */
  pendingAccountMcpCards?: Record<string, unknown>;
}

export type SceneName =
  | 'status'
  | 'pair'
  | 'scope-update'
  | 'status-long'
  | 'connect'
  | 'connected'
  | 'warnings'
  | 'account-key-changed'
  | 'vouched';

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

// Long names on purpose: the old popup wrapped a name like these across three
// lines and a column. Still illustrative (example.com), like every fixture here.
const LONG_ACTIVE = [
  trust('office-mail-calendar-mcp', {
    domains: ['mail.cloud.example.com', 'outlook.office.example.com'],
    capabilities: ['fetch', 'read_cookies'],
    cookieKeys: ['session_id'],
  }),
  trust('credit-report-mcp', { domains: ['credit.example.com'], capabilities: ['fetch'] }),
  trust('event-planner-mcp', {
    domains: ['planner.example.com', 'portal.planner.example.com'],
    capabilities: ['fetch'],
  }),
  trust('school-reminders-mcp', { domains: ['reminders.example.com'], capabilities: ['fetch'] }),
  TICKETS,
];
const LONG_INACTIVE = [
  trust('gallery-mcp', { domains: ['gallery.example.com'], capabilities: ['fetch'] }),
  trust('neighbourhood-compost-collection-mcp', {
    domains: ['compost.example.com'],
    capabilities: ['fetch'],
  }),
  trust('reservations-mcp', { domains: ['reservations.example.com'], capabilities: ['fetch'] }),
  NOTES,
];

const PERSONAL_BRIDGE: RemoteTarget = {
  id: 'bpersonal',
  url: 'wss://contextmint.example.com/bridge',
  token: 'mcpb_illustrative-only',
  label: 'Chrome (personal)',
  enabled: true,
};

const ACCOUNT: TrustedAccount = {
  origin: 'https://contextmint.example.com',
  accountId: 'acct_illustrative',
  slug: 'household',
  displayName: 'Household',
  tokenId: 'brt_illustrative',
  kid: 'kid',
  publicKey: 'pk',
  generation: 1,
  generationHighWater: 1,
  approvedAt: 1_790_000_000_000,
};

const DERIVED_HASH = fakeHash('reservations-mcp');
const DERIVED = {
  identityHash: DERIVED_HASH,
  mcp: {
    origin: ACCOUNT.origin,
    accountId: ACCOUNT.accountId,
    generation: 1,
    registrationId: 'reg_illustrative',
    slug: 'reservations-mcp',
    scope: {
      domains: ['reservations.example.com'],
      capabilities: ['fetch'],
      ...EMPTY_SCOPE,
    },
  },
};

const ACCOUNT_CARD = {
  key: 'card-1',
  origin: 'https://contextmint.example.com',
  keyChanged: true,
  account: {
    slug: 'household',
    displayName: 'Household',
    confirmedBy: 'a•••@example.com',
    bridgedRegistrations: 12,
    kid: '7f3a 91c2 0be4 5d18',
  },
};

const VOUCHED_CARD = {
  key: 'mcp-card-1',
  kind: 'confirm',
  registrationSlug: 'reservations-mcp',
  accountSlug: 'household',
  origin: 'https://contextmint.example.com',
  scope: {
    domains: ['reservations.example.com'],
    capabilities: ['fetch', 'read_cookies'],
    ...EMPTY_SCOPE,
    cookieKeys: ['session_id'],
  },
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
  'status-long': {
    trusted: [...LONG_ACTIVE, ...LONG_INACTIVE],
    remoteTargets: [PERSONAL_BRIDGE],
    connectedHashes: LONG_ACTIVE.map((t) => t.identityHash),
    links: [
      { id: 'local', connected: true },
      { id: `remote:${PERSONAL_BRIDGE.id}`, connected: true, label: PERSONAL_BRIDGE.label!, url: PERSONAL_BRIDGE.url },
    ],
    openInactive: true,
  },
  connect: {
    trusted: [],
    remoteTargets: [],
    connectedHashes: [],
    links: [{ id: 'local', connected: true }],
    connectStatus: 'Confirm in the tab that opened',
  },
  connected: {
    trusted: [CALENDAR],
    accounts: [ACCOUNT],
    derived: [DERIVED],
    remoteTargets: [PERSONAL_BRIDGE],
    connectedHashes: [CALENDAR.identityHash, DERIVED_HASH],
    links: [
      { id: 'local', connected: false },
      { id: `remote:${PERSONAL_BRIDGE.id}`, connected: true, label: PERSONAL_BRIDGE.label!, url: PERSONAL_BRIDGE.url },
    ],
    connectStatus: 'Connected to Household',
  },
  warnings: {
    trusted: [],
    remoteTargets: [{ ...PERSONAL_BRIDGE, enabled: false }],
    connectedHashes: [],
    links: [
      { id: 'local', connected: true },
      {
        id: `remote:${PERSONAL_BRIDGE.id}`,
        connected: false,
        label: PERSONAL_BRIDGE.label!,
        url: PERSONAL_BRIDGE.url,
        refusal: 'This bridge is paired with a different browser.',
      },
    ],
    vaultLoss: { detectedAt: 1_790_000_000_000 },
    versionMismatches: [
      {
        linkId: 'local',
        linkLabel: 'localhost',
        serverName: 'legacy-recipes-mcp',
        mcpProtocol: 3,
        extensionProtocol: 4,
      },
    ],
  },
  'account-key-changed': {
    trusted: [],
    remoteTargets: [],
    connectedHashes: [],
    links: [{ id: 'local', connected: true }],
    pendingAccountCards: { [ACCOUNT_CARD.key]: ACCOUNT_CARD },
  },
  vouched: {
    trusted: [],
    remoteTargets: [],
    connectedHashes: [],
    links: [{ id: 'local', connected: true }],
    pendingAccountMcpCards: { [VOUCHED_CARD.key]: VOUCHED_CARD },
  },
};

/**
 * The bare popup, every state worth reviewing, in both themes, at 2x — not
 * store images (those are `SCREENSHOTS`) but the reference for a popup change:
 * `docs/store-assets/popup/<scene>-<scheme>.png`.
 */
export const POPUP_SHOT_SCENES: SceneName[] = [
  'status-long',
  'connect',
  'connected',
  'pair',
  'scope-update',
  'account-key-changed',
  'vouched',
  'warnings',
];
export const POPUP_SHOTS = POPUP_SHOT_SCENES.flatMap((scene) =>
  (['light', 'dark'] as const).map((scheme) => ({
    file: `popup/${scene}-${scheme}.png`,
    scene,
    scheme,
  })),
);

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
