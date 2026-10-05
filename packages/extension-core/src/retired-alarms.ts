/**
 * Alarms an older version registered and nothing listens for any more.
 *
 * An alarm outlives the code that created it: it stays registered across an
 * extension update and keeps waking the background for nothing. Boot clears
 * these by name on every wake (clearing an alarm that is not there is a
 * no-op), so the first wake after an upgrade removes them.
 *
 * - `contextmint-handoff`: up to 1.5.0 the Safari build asked the ContextMint
 *   app for a bridge target over native messaging every 5 minutes. The app
 *   retired that hand-off on 2026-09-29 and the extension stopped asking
 *   (docs/superpowers/plans/2026-10-05-safari-extension-standalone.md, T2);
 *   pairing is the popup's Connect.
 */
export const RETIRED_ALARM_NAMES: readonly string[] = ['contextmint-handoff'];

/** The slice of `chrome.alarms` this needs. */
export interface ClearableAlarms {
  clear?: (name: string) => unknown;
}

/** Clear every retired alarm. Best-effort: a failure is logged, never thrown. */
export async function clearRetiredAlarms(alarms: ClearableAlarms | undefined): Promise<void> {
  if (typeof alarms?.clear !== 'function') return;
  for (const name of RETIRED_ALARM_NAMES) {
    try {
      await alarms.clear(name);
    } catch (e) {
      console.error(`[fetchproxy] could not clear the retired ${name} alarm:`, e);
    }
  }
}
