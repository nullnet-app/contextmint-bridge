> Paste this into the 'Detailed description' field in the CWS developer console.

---

## ContextMint Bridge — Route MCP Requests Through Your Signed-In Browser

ContextMint Bridge is the browser bridge for ContextMint and for developers and
power users running AI tools (Claude, Cursor, Windsurf, or any MCP-compatible
assistant). It lets an MCP server on your machine make authenticated HTTP
requests through your real, already-signed-in browser tab — so the same session
cookies, TLS fingerprint, and browser identity you use every day carry the
request, not a headless bot.

**You don't need ContextMint to use it.** It works with ContextMint and with any
fetchproxy-based MCP server or the `fpx` command-line tool running on your
machine. The protocol and npm packages behind it are called fetchproxy.

### The problem it solves

Many web services protect their APIs with bot-detection layers: Akamai, Cloudflare,
DataDome, and similar systems recognise requests made by Node.js HTTP clients and
block them. Even when you have a valid session token, these defences can reject
automated requests that don't look like a real browser.

MCP servers run as local Node.js processes. They can fetch URLs, but they can't
impersonate a signed-in Chrome tab. ContextMint Bridge closes that gap: the MCP
server asks the extension to make the fetch, the extension relays it through the
page's own `fetch()` call, and the response comes back over a localhost
WebSocket. The network request leaves the machine from Chrome, with your
session — not from Node.

### How it works

1. **Install the extension.** ContextMint Bridge connects to a local WebSocket on
   `127.0.0.1:37149`, where MCP servers on your machine listen.

2. **An MCP server connects.** On first contact, ContextMint Bridge shows a pair prompt
   in the extension popup displaying an 8-digit code (e.g. `4829-3176`). The same code
   appears in the MCP server's logs.

3. **You confirm the code.** Matching codes prove both sides are talking to each
   other — not a relay in between. Approve once; the trust record is saved.

4. **The MCP server declares its domain allowlist.** At pair time, the server
   presents the specific domains it needs to reach (for example `app.example.com`).
   You see them in the approval UI.

5. **Fetches flow through your tab.** The MCP server calls `fetchproxy.fetch(url)`.
   ContextMint Bridge finds the matching signed-in tab, runs a content-script `fetch()`
   inside that page's context, and returns the response — with cookies, HttpOnly
   headers, and the full TLS session intact.

All traffic stays on your machine. Nothing is sent to any external server. The
WebSocket port is bound to loopback only (`127.0.0.1`), not accessible from the
network.

### What ContextMint Bridge can do (with explicit user approval)

- **Fetch URLs** through a signed-in tab on an approved domain.
- **Read cookies** for declared origins via the `chrome.cookies` API (including
  HttpOnly cookies the page itself cannot read).
- **Read localStorage / sessionStorage** from an open tab on the declared domain.
- **Read IndexedDB** data from an open tab on the declared domain.
- **Capture request headers** (e.g. bearer tokens sent by the tab) via the
  `webRequest` API — one-shot, never modifies requests.

Each capability is declared by the MCP server at pair time. If the server later
asks for a capability it didn't declare, ContextMint Bridge forces a re-pair with a
visible diff so you can decide whether to approve the change.

### Security model

- **Pair-before-trust.** A new MCP server can't do anything until you confirm the
  8-digit pair code. The code is derived from a SHA-256 hash of both parties'
  public keys together with fresh per-connection values from each side, so it
  binds both identities AND that one pairing attempt.

- **End-to-end encryption.** Every frame on the localhost WebSocket is encrypted
  with AES-256-GCM using a session key derived via X25519 ECDH + HKDF-SHA-256.
  Even if another process on the machine could sniff loopback traffic, the frames
  are ciphertext.

- **Per-MCP domain allowlist.** Each MCP server can only reach the specific domains
  it declared and you approved. Requests to any other host are blocked by the
  extension before they reach a tab.

- **No eval, no arbitrary DOM access, no general storage exfiltration.** The
  content script runs a single `fetch()` call (or a targeted storage read) and
  returns the result. It does not inject scripts, manipulate the page, or read
  storage outside the declared scope.

- **Revoke any time.** Open the extension popup, select a paired server, and click
  Revoke. The trust record and session keys are deleted immediately.

### Who it's for

ContextMint Bridge is a developer tool. It is most useful if you:

- Run AI coding assistants (Claude Desktop, Cursor, Windsurf) with MCP servers
  that need to talk to web services you're already logged into.
- Build or maintain MCP servers and need a reliable way to proxy authenticated
  requests without managing session tokens manually.
- Work with services that use modern bot-detection and need requests to originate
  from a real browser session.

### Open source

ContextMint Bridge is MIT-licensed and fully open source.

- **Extension source:** github.com/nullnet-app/contextmint-bridge
- **Protocol, server and `fpx`:** github.com/chrischall/fetchproxy
- **npm packages:** `@fetchproxy/server`, `@fetchproxy/protocol`, `@fetchproxy/bootstrap`

The extension source, protocol specification, and security threat model are all
available for review. Contributions and issue reports are welcome.
