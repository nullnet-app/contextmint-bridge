/**
 * Keeps an open popup's bridge rows in step with the background.
 *
 * The background broadcasts `connections-changed` when a link opens or drops
 * and when an MCP session comes or goes, and the popup re-renders on it. That
 * alone was not enough on Safari (macOS 27): the background there is an event
 * page that is unloaded when idle, and the popup's own status query is what
 * wakes it. The woken page answers at once, while the remote link it just
 * re-read from the vault is still dialling, so the popup's first paint says
 * "Offline" — and keeps saying it, with the Connect card offered beside a
 * bridge the room shows attached, if the broadcast that follows never reaches
 * the popup. So the popup also re-asks on a short interval while it is open,
 * and re-renders only when the answer differs from the one it last drew:
 * a status that did not change never repaints under the person's cursor.
 */

/** One entry of the background's link-status answer (background/links.ts). */
export interface LinkStatusMessage {
  id: string;
  connected: boolean;
  label?: string;
  url?: string;
  /** Why the bridge refused this browser for good (`4004`), when it did. */
  refusal?: string;
  /** Why the account's room turned this browser away for now (`4001`). */
  notice?: string;
}

/** The background's answer to `get-connected-identities` (background/boot.ts). */
export interface StatusAnswer {
  connectedHashes?: string[];
  links?: LinkStatusMessage[];
}

/** How often an open popup re-asks. Cheap: one in-process message. */
export const LINK_STATUS_POLL_MS = 1500;

/**
 * What the popup draws from an answer, as a comparable string: the connected
 * MCP identities and each link's state, refusal and notice, order-insensitive.
 * `undefined` (nobody answered) has its own signature, so a popup whose first
 * query went unanswered still re-renders once one is.
 */
export function statusSignature(answer: StatusAnswer | undefined): string {
  if (answer === undefined) return 'none';
  const hashes = [...(answer.connectedHashes ?? [])].sort();
  const links = (answer.links ?? [])
    .map(
      (l) =>
        [
          l.id,
          l.connected === true,
          typeof l.refusal === 'string' ? l.refusal : null,
          typeof l.notice === 'string' ? l.notice : null,
        ] as const,
    )
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify({ hashes, links });
}

export class LinkStatusWatch {
  #rendered = statusSignature(undefined);
  #timer: ReturnType<typeof setInterval> | undefined;
  #checking = false;

  constructor(
    private readonly query: () => Promise<StatusAnswer | undefined>,
    private readonly rerender: () => void,
  ) {}

  /** Record the answer the popup just rendered from. */
  noteRendered(answer: StatusAnswer | undefined): void {
    this.#rendered = statusSignature(answer);
  }

  /**
   * Ask once; re-render if the answer changed. A failed or unanswered query
   * is no news — the popup keeps what it shows rather than blanking it.
   * Returns whether it asked for a re-render.
   */
  async check(): Promise<boolean> {
    if (this.#checking) return false;
    this.#checking = true;
    try {
      let answer: StatusAnswer | undefined;
      try {
        answer = await this.query();
      } catch {
        return false;
      }
      if (answer === undefined || answer === null || typeof answer !== 'object') return false;
      const signature = statusSignature(answer);
      if (signature === this.#rendered) return false;
      this.#rendered = signature;
      this.rerender();
      return true;
    } finally {
      this.#checking = false;
    }
  }

  start(intervalMs: number = LINK_STATUS_POLL_MS): void {
    this.stop();
    this.#timer = setInterval(() => void this.check(), intervalMs);
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
