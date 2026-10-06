/**
 * The popup → background message behind "Serve from this browser" (mcp-host
 * plan task X2): `{ type: SERVE_FROM_THIS_BROWSER, linkId }`. The background
 * hears it only from an extension page (no `sender.tab`) and sends the room
 * frame on that one link, if and only if the room offered it there
 * (`background/socket.ts` `serveFromLink`). Answered `{ ok }`.
 *
 * Its own module so the popup can name it without importing the background.
 */
export const SERVE_FROM_THIS_BROWSER = 'serve-from-this-browser';
