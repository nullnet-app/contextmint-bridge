/** Gateway close codes whose remote-link retries have special handling. */
export const ACCOUNT_CONFIRMED_CLOSE = 4005;
export const FACTS_CHANGED_CLOSE = 4006;
export const CREDENTIAL_REVOKED_CLOSE = 4003;
/**
 * `4001 BROWSER_TAKEN`: the account's bridge room has no place for this
 * browser. Either it is at its cap of distinct browsers (mcp-host
 * `MAX_ROOM_BROWSERS`, several browsers under managed pins), or it admits one
 * browser and another holds it (no managed pins, the multi-browser flag off,
 * or a gateway that predates several browsers).
 */
export const BROWSER_TAKEN_CLOSE = 4001;
/** mcp-host's `MAX_ROOM_BROWSERS`, said when the close reason does not name it. */
export const DEFAULT_ROOM_BROWSER_LIMIT = 4;

/** The gateway's cap reason, `ROOM_FULL_REASON`: "this account already has 4 browsers attached". */
const ROOM_FULL_REASON = /^this account already has (\d{1,2}) browsers attached$/;
/** The gateway's single-slot reason, `BROWSER_TAKEN_REASON`. */
const SINGLE_SLOT_REASON = 'another browser is attached to this account';

/**
 * The popup line for a `4001` close, from its reason.
 *
 * The count comes from the cap reason when it parses, else
 * {@link DEFAULT_ROOM_BROWSER_LIMIT}. The single-slot reason gets its own
 * line: a room that admits one browser is not "4 browsers", and that is what
 * today's gateway (and any account without managed pins) sends. The reason is
 * only ever read for a number and matched exactly, never shown.
 */
export function browserTakenMessage(reason: string | undefined): string {
  if (reason === SINGLE_SLOT_REASON) {
    return 'Another browser is connected to this account; disconnect it in Settings';
  }
  const parsed = ROOM_FULL_REASON.exec(reason ?? '');
  const n = parsed ? Number(parsed[1]) : NaN;
  const count = n >= 2 && n <= 64 ? n : DEFAULT_ROOM_BROWSER_LIMIT;
  return `This account already has ${count} browsers connected; disconnect one in Settings`;
}
