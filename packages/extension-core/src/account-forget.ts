import type { AccountTrustStore } from './account-trust-store.js';
import type { TrustStore } from './trust-store.js';

/** Forget an account and optionally the hosted hand-paired MCPs vouched by it. */
export async function forgetAccount(
  accounts: AccountTrustStore,
  mcps: TrustStore,
  origin: string,
  accountId: string,
  alsoForgetMcps: boolean,
): Promise<string[]> {
  const records = alsoForgetMcps ? await mcps.list() : {};
  const matching = Object.entries(records)
    .filter(
      ([, record]) =>
        record.attestedBy?.origin === origin && record.attestedBy.accountId === accountId,
    )
    .map(([identityHash]) => identityHash);
  await accounts.deleteByAccount(origin, accountId);
  await Promise.all(matching.map((identityHash) => mcps.remove(identityHash)));
  return matching;
}
