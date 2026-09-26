> CWS review form: paste each justification into the corresponding permission field.

---

## Permission Justifications — ContextMint Bridge

### `storage`

Used for non-secret extension state: the pairing queue and the popup's
approve/cancel decisions (in `chrome.storage.session`, which content scripts
cannot read), and a note of recent protocol-version mismatches the popup explains
(in `chrome.storage.local`). The extension's identity keypair and the trust
records for paired MCP servers are kept in the extension's own IndexedDB, not in
`chrome.storage`. No data is ever sent off the machine; everything stays on the
user's device.

---

### `tabs`

Required to locate the user's signed-in tab on the MCP server's declared domain
when routing a fetch request. ContextMint Bridge iterates open tabs and selects one whose
hostname is the declared domain or a subdomain of it (host-or-subdomain matching).
Tab URLs are checked only at request time and are not stored or transmitted.
The only tab the extension ever opens is a background tab on a domain the user
approved for a paired MCP server, when no tab on that domain is open; it never
closes or navigates the user's tabs.

---

### `scripting`

Required to inject the content script that executes a `fetch()` call (or a
targeted storage read) inside the page's own context. Running inside the page
context is what gives the request the page's session cookies, TLS session, and
browser identity — the core capability ContextMint Bridge provides. The injected script
performs only the single operation requested (fetch, localStorage read, etc.) and
returns the result; it does not manipulate the DOM or execute arbitrary code.

---

### `cookies`

Used only when the MCP server has declared the `read_cookies` capability and the
user approved it at pair time. The `chrome.cookies` API is the only way to read
HttpOnly cookies, which cannot be accessed from page-context JavaScript. Cookies
are read for the specific declared origin and returned over the encrypted localhost
WebSocket to the MCP server. No cookies are stored by the extension beyond what
`chrome.storage` already holds for trust records.

---

### `webRequest`

Used only when the MCP server has declared the `capture_request_header` capability
and the user approved it at pair time. A one-shot `onBeforeSendHeaders` listener
captures the value of a specific named request header (e.g. a bearer token the
tab sends automatically) and returns it to the MCP server. The listener is
registered for one request and then removed. ContextMint Bridge **never modifies**
requests; it is a read-only observer.

---

### `alarms`

Used exclusively for MV3 service-worker keepalive. Chrome may terminate idle
service workers after approximately 30 seconds. A `chrome.alarms` alarm fires
every 24 seconds and triggers an idempotent `connect()` call that re-establishes
the WebSocket listener if it was torn down. Without this alarm, the bridge would
silently die between bursts of MCP traffic. No alarms are used for any other
purpose.

---

### `downloads`

Used only when the MCP server has declared the `download` capability and the
user approved it at pair time. `chrome.downloads.download` lets the browser
itself fetch a file from an approved domain with the user's own session, which
clears bot-challenges that a page-level `fetch()` cannot. The file is saved to
the Downloads folder without a prompt, the saved local path is returned to the
MCP server on the same machine, and the download's history entry (not the file)
is then erased. The URL must be on one of the MCP server's approved domains, and
the capability is refused for MCP servers reached through a remote bridge, so
only a server on the user's own machine can save a file.

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

### `nativeMessaging`

**Safari only** — the Chrome Web Store build does not request it. ContextMint
Bridge for Safari ships inside the ContextMint app, and uses native messaging
only to ask that containing app for the bridge target the user set up there
(the bridge address and its access credential, which it keeps in memory
only), so the extension can connect without the user typing them in again.
The only thing it sends back is whether that connection is up. It exchanges
messages with no other application and sends no browsing data to the app.

---

### `host_permissions: <all_urls>`

The domains that ContextMint Bridge needs to reach are declared dynamically by each MCP
server at pair time and approved by the user during the pairing flow. Because the
set of possible domains is open-ended (any service a developer might build an MCP
for), the manifest must declare broad host permissions. However, runtime
enforcement is strict: every fetch URL, cookie origin, storage read, and tab
selection is checked against the specific `domains[]` allowlist the user approved
for that MCP server. Requests to any host outside that allowlist are blocked by
the extension before reaching a tab. The broad manifest declaration enables the
mechanism; the per-MCP allowlist is what actually governs access.

---

## Single-Purpose Statement

Relay HTTP fetches and read user-declared session data (cookies, localStorage,
request headers) between a local MCP server and the user's signed-in browser tab
on a domain the user has explicitly approved at pair time.
