# App Store listing — ContextMint Bridge

Paste each fenced block into the App Store Connect field its heading names
(app record 6819349214, iOS and macOS share it). `tests/app-store-listing.test.ts`
holds the length limits and keeps other browsers' and platforms' names out of
the pasted text (App Review Guideline 2.3.10).

The copy is `../listing-description.md` (the Chrome Web Store listing) with the
Chrome lines swapped for Safari, and one addition: what iPhone and iPad can and
cannot do (plan Q5).

## Name

```text
ContextMint Bridge
```

## Subtitle

```text
Your signed-in tabs, for AI
```

## Promotional text

```text
Let ContextMint and your MCP servers use the Safari tabs you're already signed into: your own sessions, no copied passwords or cookies, nothing shared until you approve.
```

## Description

```text
ContextMint Bridge is a Safari extension that connects ContextMint, and the MCP servers you run on your own Mac, to your signed-in Safari tabs. When an AI tool (Claude, Cursor, Windsurf, or any MCP-compatible assistant) needs something from a web service you use, the request runs inside your real tab, with your own session, instead of from a headless bot, and without you copying a password, token or cookie anywhere.

You don't need the ContextMint app to use it. It works with ContextMint and with any fetchproxy-based MCP server or the fpx command-line tool on your Mac.

TURN IT ON
Open ContextMint Bridge once, then turn the extension on in Safari's Extensions settings and allow it on the websites you want your tools to reach. The app shows you where, and whether Safari has it on.

HOW IT WORKS
1. An MCP server asks to pair. The extension's toolbar icon shows a badge; open it to see the server's name, the exact domains it wants to reach, every capability it declares, and, by name, each cookie, storage key or request header it would read. It also shows an 8-digit pair code, and the server shows the same code (in its terminal, for one on your Mac).
2. You compare the code and approve. Matching codes prove the extension and the server are talking to each other, not to something in between. Approve once; the pairing is remembered.
3. Requests flow through your tab. When the server asks for a page on an approved domain, ContextMint Bridge makes the request from your open tab on that site and returns the response.

CONNECT CONTEXTMINT
ContextMint can host MCP servers for you. To let them use Safari, open the extension and choose Connect, then confirm the browser on ContextMint's page. There is no access token to copy or paste. Request and response contents are end-to-end encrypted between the extension and each MCP server, so the relay in between cannot read them.

ON IPHONE AND IPAD
On iPhone and iPad there are no local MCP servers, so use Connect: the MCP servers ContextMint hosts for you reach your signed-in sites through Safari. iOS pauses extensions when Safari leaves the screen, so requests are served while Safari is open.

ONLY WHAT YOU APPROVED
Each server declares what it needs, and you approve exactly that, for exactly the domains and names listed: requests through your signed-in tab, named cookies (including HttpOnly session cookies, which the extension warns about before you approve), named local or session storage keys, named IndexedDB stores, a named request header your tab sends, and page elements matching approved selectors. If a server later asks for more, it keeps working with what you approved, and the extension offers the difference for you to grant or keep as is.

SECURITY
- Pair before trust: a new MCP server can do nothing until you confirm its 8-digit code.
- End-to-end encryption: every request and response is encrypted with AES-256-GCM under a per-session key.
- Per-server domain allowlist: requests to any host you did not approve are refused before they reach a tab.
- Secrets stay out of page reach: keys and pairings live in the extension's own storage, which websites cannot read.
- Revoke any time from the extension.
- No analytics, no tracking, no crash reporting, no remote configuration. The app itself makes no network connections; only Connect, when you choose it, stores this browser with your ContextMint account.

OPEN SOURCE
ContextMint Bridge is MIT-licensed. The extension, the protocol specification and the security threat model are public:
github.com/nullnet-app/contextmint-bridge
github.com/chrischall/fetchproxy
```

## Keywords

```text
mcp,llm,model context protocol,safari extension,cookies,login,fetchproxy,fpx,agent,session,browser
```

## Category

Primary **Productivity** (set in App Store Connect on 2026-10-05; it is what
`LSApplicationCategoryType` in `apple/project.yml` declares, and
`tests/apple-project.test.ts` pins the two together), which settles plan Q3.
Change both together if the category ever moves.

## Privacy Policy URL

```text
https://github.com/nullnet-app/contextmint-bridge/blob/main/docs/PRIVACY.md
```

## Support URL

```text
https://github.com/nullnet-app/contextmint-bridge/issues
```

## Marketing URL

Optional; leave empty, or use the repository:
`https://github.com/nullnet-app/contextmint-bridge`.

## Copyright

```text
2026 Chris Hall
```
