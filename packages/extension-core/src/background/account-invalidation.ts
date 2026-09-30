const accountEpochs = new Map<string, number>();

function key(origin: string, accountId: string): string {
  return `${origin}\u0000${accountId}`;
}

/** Snapshot an account's revocation epoch before beginning asynchronous hello work. */
export function accountInvalidationEpoch(origin: string, accountId: string): number {
  return accountEpochs.get(key(origin, accountId)) ?? 0;
}

/** Synchronously invalidate every in-flight hello for this account. */
export function invalidateAccountHellos(origin: string, accountId: string): void {
  const accountKey = key(origin, accountId);
  accountEpochs.set(accountKey, (accountEpochs.get(accountKey) ?? 0) + 1);
}
