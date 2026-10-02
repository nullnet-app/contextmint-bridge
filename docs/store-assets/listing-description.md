> Paste this into the 'Detailed description' field in the CWS developer console.
> The images beside it (promo tile, screenshots) are in this folder; see README.md.

---

## ContextMint Bridge — Let your AI tools work in the tabs you're already signed into

ContextMint Bridge connects ContextMint, and the MCP servers you run on your own
machine, to your signed-in Chrome tabs. When an AI tool (Claude, Cursor,
Windsurf, or any MCP-compatible assistant) needs something from a web service
you use, the request runs inside your real tab — with your own session, cookies
and browser identity — instead of from a headless bot, and without you copying
a password, token or cookie anywhere.

**You don't need ContextMint to use it.** It works with ContextMint and with any
fetchproxy-based MCP server or the `fpx` command-line tool running on your
machine. The protocol and npm packages behind it are called fetchproxy.

### The problem it solves

Many web services protect their APIs with bot-detection layers (Akamai,
Cloudflare, DataDome and similar) that recognise requests made by scripts and
block them — even when the script has a valid session token.

MCP servers are local programs. They can fetch URLs, but they can't be a
signed-in Chrome tab. ContextMint Bridge closes that gap: the MCP server asks
the extension to make the request, the extension makes it from a tab you
already have open on that site, and the response goes back over an encrypted
WebSocket. The request leaves your machine from Chrome, with your session.

### How it works

1. **Install the extension.** It listens for MCP servers on your own machine at
   `127.0.0.1:37149` (loopback only — not reachable from the network).

2. **An MCP server connects and asks to pair.** The extension's badge lights
   up; open the popup to see the server's name and version, the exact domains
   it wants to reach, every capability it declares, and — by name — each
   cookie, storage key, request header, database, page element or GraphQL
   operation it would read. The popup also shows an 8-digit pair code
   (e.g. `4829-3176`); the same code appears in the MCP server's terminal.

3. **You compare the code and approve.** Matching codes prove the extension
   and the server are talking to each other, not to something in between.
   Approve once; the pairing is remembered.

4. **Requests flow through your tab.** When the server asks for a URL on an
   approved domain, ContextMint Bridge finds your open tab on that site (or
   opens one in the background, grouped under "fetchproxy"), makes the request
   from it, and returns the response.

### Connecting ContextMint

ContextMint can host MCP servers for you rather than on your machine. To let
them use this browser, open the extension popup and click **Connect to
mcp.nullnet.app** under "Connect this browser to your account". A tab opens to
ContextMint's Connect page; sign in if asked, then confirm the browser there. The extension saves the resulting credential
in its protected vault, so there is no access token to copy or paste. After
pairing, ContextMint's servers use this browser with the same per-domain
approval and revoke controls as local servers. Request and response contents
are end-to-end encrypted between the extension and each MCP server, so the
relay in between cannot read them.

### What an MCP server can do — only what you approved

Each server declares the capabilities it needs, and you approve exactly that
set, for exactly the domains and names listed:

- **HTTP requests** through your signed-in tab on an approved domain.
- **Read cookies** you approved by name (including HttpOnly session cookies,
  which the popup warns about before you approve).
- **Overwrite a cookie it can already read** — the one capability that changes
  something in your browser rather than reading it; it cannot create cookies.
- **Read localStorage / sessionStorage** keys you approved by name.
- **Read IndexedDB** databases and stores you approved by name.
- **Capture a request header** (such as a bearer token) that your tab sends to
  a declared host, or where such a request redirects to — one-shot, read-only,
  never modifying the request.
- **Read page elements or lists** matching selectors you approved.
- **Run declared GraphQL queries** through the site's own client.
- **Send some requests via the page itself** (the popup says plainly that the
  site can see and alter these).
- **Download a file** from an approved domain to your Downloads folder.

If a server later declares more than you approved, it keeps working with only
what you approved, and the popup offers the difference for you to **Grant** or
**Keep as is**. If a server declares something your browser can't provide, the
popup shows it greyed out and it is simply not granted — the rest still works.

### Security model

- **Pair before trust.** A new MCP server can do nothing until you confirm the
  8-digit pair code. The code is derived from both sides' public keys and fresh
  per-connection values, so it binds both identities and that one pairing
  attempt.

- **End-to-end encryption.** Every request and response is encrypted with
  AES-256-GCM under a per-session key derived via X25519 ECDH + HKDF-SHA-256.

- **Per-server domain allowlist.** Each server can only reach the domains you
  approved for it. Requests to any other host are refused before they reach a
  tab.

- **Secrets stay out of page reach.** Keys, pairings and bridge settings live
  in the extension's own storage, which websites and content scripts cannot
  read or write.

- **Revoke any time.** Open the popup and click ✕ next to a server. Its pairing
  and session keys are deleted immediately.

- **No telemetry.** No analytics, no crash reporting, no remote configuration.
  The extension reports nothing to its developer or anyone else.

### Who it's for

- People using ContextMint who want its tools to reach sites they're signed
  into.
- Anyone running AI assistants (Claude Desktop, Cursor, Windsurf) with MCP
  servers that need web services they're already logged into.
- Developers building MCP servers who want authenticated requests without
  handling session tokens themselves.

### Open source

ContextMint Bridge is MIT-licensed and fully open source.

- **Extension source:** github.com/nullnet-app/contextmint-bridge
- **Protocol, server and `fpx`:** github.com/chrischall/fetchproxy
- **npm packages:** `@fetchproxy/server`, `@fetchproxy/protocol`, `@fetchproxy/bootstrap`

The extension source, protocol specification and security threat model are all
available for review. Contributions and issue reports are welcome.
