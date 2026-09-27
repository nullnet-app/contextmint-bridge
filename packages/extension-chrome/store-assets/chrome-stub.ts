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
    session: scene.pendingPair ? { pendingPair: scene.pendingPair } : {},
    version: extensionVersion,
    connected: { connectedHashes: scene.connectedHashes, links: scene.links },
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
  globalThis.chrome = {
    runtime: {
      id: 'store-assets',
      getManifest: () => ({ version: init.version }),
      async sendMessage(msg) {
        if (msg && msg.type === 'get-connected-identities') return clone(init.connected);
        return undefined;
      },
      onMessage: { addListener() {} },
    },
    storage: { local: area({}), session: area(init.session) },
  };
})();
`;
}
