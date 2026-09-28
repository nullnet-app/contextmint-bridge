> CWS review form: paste each justification into the corresponding permission field.
> Only the sections above "Not requested by the Chrome build" apply to the Chrome listing.

---

## Permission Justifications — ContextMint Bridge

### `storage`

Used for non-secret extension state: the pairing queue and the popup's
approve / cancel / grant decisions (in `chrome.storage.session`, which content
scripts cannot read), and a short-lived note of MCP servers refused for running
an out-of-date protocol, which the popup explains (in `chrome.storage.local`).
The extension's identity keys, the pairings the user approved and any bridge
the user configured are kept in the extension's own IndexedDB, not in
`chrome.storage`. Nothing is sent to the developer or any third party.

---

### `tabs`

Required to locate the user's signed-in tab on a paired MCP server's approved
domain when routing a request. ContextMint Bridge looks through open tabs for
one whose hostname is the approved domain or a subdomain of it. Tab URLs are
checked only at request time and are never stored or transmitted. The only tab
the extension ever opens is a background tab on an approved domain, when no
tab on that domain is open; it never closes or navigates the user's own tabs.

---

### `scripting`

Required to run a request (or a targeted read the user approved) inside the
page's own context. Running there is what gives the request the page's session
cookies, TLS session and browser identity — the core capability ContextMint
Bridge provides. The extension also uses it to register a small page-world
helper (for approved GraphQL queries and in-page requests) on the hosts of
approved MCP servers only — never on every site — plus, on those same hosts
only, a tiny script that tells the extension a page finished loading so it can
reconnect promptly, and, after an extension
update, to put the extension's own declared content scripts back into tabs that
were already open. The injected code performs only the operation requested and
returns the result; it does not modify the page.

---

### `cookies`

Used only when a paired MCP server declared a cookie capability and the user
approved it, for the cookie names shown by name in the pair prompt.
`chrome.cookies` is the only way to read HttpOnly cookies, which page
JavaScript cannot reach; the popup warns the user about this before they
approve. The `write_cookies` capability additionally lets an approved server
overwrite the value of a cookie that already exists, on an approved domain,
whose name it was already approved to read — it cannot create cookies or reach
any other. Cookie values are returned over the encrypted connection to the MCP
server; the extension does not store them.

---

### `webRequest`

Used only when a paired MCP server declared `capture_request_header` (or
`capture_redirect`) and the user approved it. A one-shot `onBeforeSendHeaders`
listener reads the value of one named request header (e.g. a bearer token the
tab sends to a declared host), or a one-shot `onBeforeRedirect` listener reads
where a request to a declared host redirects to, and returns it to the MCP
server. Each listener is removed after one request. ContextMint Bridge **never
modifies or blocks** requests; it is a read-only observer.

---

### `alarms`

Used for MV3 service-worker keepalive. Chrome may stop an idle service worker
after about 30 seconds; a `chrome.alarms` alarm fires every 24 seconds and
re-establishes the connection to local MCP servers (and any bridge the user
configured) if it was torn down. Without it, the extension would silently stop
answering between bursts of MCP traffic. No alarm carries data.

---

### `downloads`

Used only when a paired MCP server declared the `download` capability and the
user approved it. `chrome.downloads.download` lets the browser itself fetch a
file from an approved domain with the user's own session, which clears
bot-challenges that a page-level request cannot. The file is saved to the
Downloads folder without a prompt, the saved local path is returned to the MCP
server on the same machine, and the download's history entry (not the file) is
then erased. The URL must be on one of the server's approved domains, and the
capability is refused for MCP servers reached through a remote bridge, so only
a server on the user's own machine can save a file.

---

### `tabGroups`

Used to keep the relay tabs the extension opens in one place. When a paired MCP
server needs a tab on an approved domain and none is open, the extension opens
one in the background (without stealing focus) and files it into a single tab
group titled "fetchproxy", so the user can see which tabs the extension created
and that they are safe to close. `chrome.tabGroups` is used only to find that
group and set its title and colour. It never reads page content, never moves a
tab the user opened themselves, and grouping is best-effort: without the
permission the relay tab still opens, ungrouped.

---

### `host_permissions: <all_urls>`

The domains ContextMint Bridge needs to reach are declared by each MCP server
at pair time and approved by the user in the pairing prompt. Because that set
is open-ended (any service someone might build an MCP server for), the
manifest must declare broad host permissions. Runtime enforcement is strict:
every request URL, cookie, storage read and tab selection is checked against
the specific domains the user approved for that server, and anything outside
them is refused before it reaches a tab. The broad declaration enables the
mechanism; the per-server allowlist governs access.

---

## Single-Purpose Statement

Let ContextMint and MCP servers the user runs make requests through, and read
only the session data the user approved from, the user's own signed-in browser
tabs — on domains the user explicitly approved for each server at pair time.

---

## Not requested by the Chrome build

Kept here so every permission any ContextMint Bridge build asks for has one
justification. Do not paste these into the Chrome Web Store form.

### `nativeMessaging`

**Safari only** — the Chrome Web Store build does not request it. ContextMint
Bridge for Safari ships inside the ContextMint app, and uses native messaging
only to ask that containing app for the bridge target the user set up there
(the bridge address and its access credential, which it keeps in memory
only), so the extension can connect without the user typing them in again.
The only thing it sends back is whether that connection is up. It exchanges
messages with no other application and sends no browsing data to the app.
