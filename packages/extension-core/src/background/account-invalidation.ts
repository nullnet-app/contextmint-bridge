const accountEpochs = new Map<string, number>();
const accountsBeingForgotten = new Map<string, number>();
let forgetActivityVersion = 0;

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

/** Start a forget barrier before its first asynchronous storage operation. */
export function beginAccountForget(origin: string, accountId: string): void {
  const accountKey = key(origin, accountId);
  accountsBeingForgotten.set(accountKey, (accountsBeingForgotten.get(accountKey) ?? 0) + 1);
  forgetActivityVersion++;
  invalidateAccountHellos(origin, accountId);
}

/** Release the barrier only after durable and live authority cleanup finishes. */
export function endAccountForget(origin: string, accountId: string): void {
  const accountKey = key(origin, accountId);
  const active = accountsBeingForgotten.get(accountKey) ?? 0;
  if (active <= 1) accountsBeingForgotten.delete(accountKey);
  else accountsBeingForgotten.set(accountKey, active - 1);
  forgetActivityVersion++;
}

export function isAccountForgetInProgress(origin: string, accountId: string): boolean {
  return (accountsBeingForgotten.get(key(origin, accountId)) ?? 0) > 0;
}

/** Detect forgets that overlap an async operation before its account is known. */
export function accountForgetActivityVersion(): number {
  return forgetActivityVersion;
}
