/**
 * Browser entry, loaded by the generator's seeding page BEFORE the popup: it
 * writes a scene's trust records and remote bridges through the extension's
 * own vault code, so the popup reads them exactly as it reads a real
 * profile's. Bundled by `generate.ts` at run time; never part of the
 * extension.
 */
import { TrustStore, type TrustInput } from '../../extension-core/src/trust-store.js';
import { saveRemoteTargets } from '../../extension-core/src/vault-records.js';
import type { RemoteTarget } from '../../extension-core/src/remote-targets.js';

interface SeedWindow {
  __SEED__: {
    version: string;
    trusted: { identityHash: string; input: TrustInput }[];
    remoteTargets: RemoteTarget[];
  };
  __seeded?: true;
  __seedError?: string;
}

const w = window as unknown as SeedWindow;

void (async () => {
  try {
    const { version, trusted, remoteTargets } = w.__SEED__;
    const store = new TrustStore(version);
    for (const t of trusted) await store.put(t.identityHash, t.input);
    await saveRemoteTargets(remoteTargets);
    w.__seeded = true;
  } catch (e) {
    w.__seedError = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  }
})();
