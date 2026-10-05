/**
 * The `chrome.*` the popup (and the seeding page) see when the store
 * screenshots are rendered: an in-memory `storage.session` holding the scene's
 * pairing queue, an empty `storage.local`, and a `runtime` that answers the
 * background's `get-connected-identities` query with the scene's links.
 *
 * Emitted as the SOURCE of a classic script so it runs before the popup's
 * module does. Dev-only; never bundled into the extension.
 */
import type { PopupScene } from './scenes.js';

export function chromeStubSource(scene: PopupScene, extensionVersion: string): string {
  const init = {
    session: {
      ...(scene.pendingPair ? { pendingPair: scene.pendingPair } : {}),
      ...(scene.pendingAccountCards ? { pendingAccountCards: scene.pendingAccountCards } : {}),
      ...(scene.pendingAccountMcpCards ? { pendingAccountMcpCards: scene.pendingAccountMcpCards } : {}),
    },
    version: extensionVersion,
    connected: { connectedHashes: scene.connectedHashes, links: scene.links },
    connectStatus: scene.connectStatus ?? null,
    versionMismatches: scene.versionMismatches ?? [],
  };
  return `(() => {
  const init = ${JSON.stringify(init)};
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const area = (data) => ({
    async get(keys) {
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = clone(data[k]);
      return out;
    },
    async set(kv) { Object.assign(data, clone(kv)); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; },
    onChanged: { addListener() {} },
  });
  // A refusal is shown only while fresh, so it is stamped at load time.
  const local = {};
  if (init.versionMismatches.length) {
    local.versionMismatch = {};
    init.versionMismatches.forEach((m, i) => {
      local.versionMismatch[m.linkId + ':' + m.serverName] = { ...m, at: Date.now() - i };
    });
  }
  globalThis.chrome = {
    runtime: {
      id: 'store-assets',
      getManifest: () => ({ version: init.version }),
      async sendMessage(msg) {
        if (msg && msg.type === 'get-connected-identities') return clone(init.connected);
        if (msg && msg.type === 'bridge-connect-origins' && init.connectStatus !== null) {
          return { origins: ['https://mcp.nullnet.app'], status: init.connectStatus };
        }
        return undefined;
      },
      onMessage: { addListener() {} },
    },
    storage: { local: area(local), session: area(init.session) },
  };
})();
`;
}
