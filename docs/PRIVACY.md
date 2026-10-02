# Privacy Policy — ContextMint Bridge (fetchproxy)

**Last updated: 2026-09-29**

ContextMint Bridge is a Chrome and Safari extension that bridges MCP (Model Context Protocol) servers to your signed-in browser tabs, either locally or through a remote bridge you connect. This policy describes what data ContextMint Bridge processes, stores, and shares.

---

## 1. What ContextMint Bridge Does

ContextMint Bridge acts as a relay between Node.js MCP servers running on your computer and web pages you have open in Chrome. When an MCP server makes a request, ContextMint Bridge executes that request inside the browser tab you have open — carrying your existing session cookies and authentication — and returns the result to the MCP server over a local WebSocket connection.

Local bridge traffic stays on your machine. When you connect to a remote bridge or approve an account pairing, the extension sends the pairing data described in §4 to that gateway.

---

## 2. Data Processed

### 2.1 HTTP Requests and Responses

When an MCP server calls `fetch()` through ContextMint Bridge, the extension makes the HTTP request from inside your browser tab. The request and response are passed over a local, encrypted WebSocket to the MCP server. ContextMint Bridge does not log, cache, or retain request or response content after it is forwarded.

### 2.2 Session Data (Cookies, Storage, IndexedDB)

Depending on the capabilities an MCP server declares and you approve at pair time, ContextMint Bridge may read — and, for one capability, modify:

| Capability | What it reads or changes |
|---|---|
| `read_cookies` | Cookies for declared domains |
| `read_local_storage` | `localStorage` contents for declared domains |
| `read_session_storage` | `sessionStorage` contents for declared domains |
| `read_indexed_db` | IndexedDB contents for declared domains |
| `capture_request_header` | Specific HTTP request headers on declared domains |
| `write_cookies` | **Changes** the value of cookies on declared domains. The only capability that modifies browser state rather than reading it. It can only overwrite a cookie that already exists and whose name the MCP already declared readable — it cannot create cookies, and it reaches nothing the MCP could not already read. |

**All session data reads — and the one write — are:**
- Scoped to the domains the MCP server explicitly declared in its hello frame.
- Gated on your explicit approval at pair time — you see the requested capabilities and domains before any access is granted.
- Passed directly to the requesting MCP server over the local encrypted WebSocket. ContextMint Bridge does not store, forward, or log the content of cookies or storage values.

---

## 3. Data Stored

All persistent data is stored on your device, in the extension's `chrome.storage.local` and its own IndexedDB. It is **never synced** to `chrome.storage.sync`, never uploaded to any server, and never leaves your machine through the extension.

### 3.1 Extension Identity

ContextMint Bridge generates a long-term Ed25519 signing keypair and an X25519 public key the first time it starts. These keys are used to authenticate the extension to MCP servers; the X25519 public key is only an identifier, and its private half is discarded as soon as it is made, because nothing uses it. They are stored in the extension's own IndexedDB, which websites and the extension's content scripts cannot access, and the signing key is held as a non-extractable key: the browser can sign with it, but will not hand its bytes to anyone, including the extension itself. This is the same in every browser the extension runs in, Safari included. (Earlier versions kept them in `chrome.storage.local`; the first start after upgrading moves them and deletes the old copy. Every earlier version also kept the X25519 private key; the first start after upgrading deletes it and keeps the public key, so existing pairings are unaffected.)

The extension asks the browser to keep this storage persistent, so it is not cleared to free up disk space. If the browser clears it anyway, the extension creates a new identity and the popup says that every MCP must be paired again. To notice that, it keeps one timestamp in `chrome.storage.local` recording when its storage was first set up; the timestamp contains no key, identity or browsing data.

### 3.2 Trust Records

When you approve an MCP server at pair time, ContextMint Bridge stores a trust record containing:
- The MCP server's public keys.
- The server name.
- The approved capability set and domain list.
- A timestamp.

Trust records are stored in the extension's own IndexedDB, which websites and the extension's content scripts cannot read or change. (Earlier versions kept them in `chrome.storage.local`; the first start after upgrading moves them.) You can revoke any trust record from the extension popup at any time.

### 3.3 Bridge Credentials

After you approve Connect, the extension stores the returned bridge credential with its bridge URL and name in the extension's own IndexedDB vault. Websites and content scripts cannot read that vault. The credential is sent only to the configured gateway's bridge connection; it is never placed in `chrome.storage.local` or `chrome.storage.session`.

### 3.4 Pending-Pair State

While an MCP pair confirmation is in progress (the 8-digit code dialog is showing), its transient pending-pair entry is held in `chrome.storage.session`, not `chrome.storage.local`. It is removed as soon as the pair is approved, rejected, or times out.

### 3.5 Pending Connect Request (`bridgeConnectPending`)

While Connect is waiting for you to approve it on the gateway page, the extension holds the tab id, request id, gateway origin, one-time nonce and ten-minute expiry under `bridgeConnectPending` in `chrome.storage.session`. This store is cleared when the browser closes and is inaccessible to web pages. The approval is accepted once, only from the recorded top-level tab on the matching gateway page. The bridge credential is not stored in this record.

---

## 4. Data Shared Externally

ContextMint Bridge contains no telemetry, analytics, crash reporting, feature flags or A/B testing. The extension's network connections are:

- The local WebSocket connection to `127.0.0.1:37149` (MCP server connections on your own machine).
- HTTP requests made inside your browser tabs at the explicit direction of an approved MCP server.
- **Connect pairing with a gateway.** When you click a Connect button, the extension sends `POST /bridge/connect/start` to that configured HTTPS origin. It includes this browser's public identity keys, your editable browser name, a timestamp and a signature made with the extension's non-extractable identity key. The gateway returns a request id, one-time nonce and same-origin Connect page URL. After you approve on that page, the page relays only the approval value to the extension; the extension sends `POST /bridge/connect/finish` with the request id, nonce, approval and another signature. The gateway returns the bridge credential directly to the extension, which stores it in the vault described in §3.3. The credential and nonce are never sent to the page or put in a URL. The default origin is `https://mcp.nullnet.app`; any additional origins must be supplied by a managed browser policy. No browsing data, cookies or request content are sent in these pairing requests.
- **Outbound WebSocket connections to remote bridge targets.** These begin only after you start and approve Connect. The extension stores the resulting `wss://` bridge URL and credential in its vault and uses the credential as a WebSocket subprotocol. Removing or disabling a target closes its connection. Request and response contents are end-to-end encrypted between the extension and each MCP server. The relay operator can see handshake metadata: the extension's ID, version and public identity keys; MCP server names, versions, `mcpId`, declared domains, capabilities and key names; each MCP's pair code and other pairing frames; and timing and frame sizes. See [SECURITY.md §T-remote-bridge](https://github.com/chrischall/fetchproxy/blob/main/docs/SECURITY.md#t-remote-bridge--a-configured-remote-bridge-target).
- **Safari only — the temporary app hand-off.** In Safari, ContextMint Bridge still asks the containing ContextMint app over native messaging for a bridge target the app already holds. The extension keeps that address and credential in memory only, never writes them to browser storage or logs, and asks for them again after Safari restarts the extension. It reports only whether the handed-off connection is up. Connect pairing itself uses the extension popup and the gateway flow above; it does not use native messaging. The Chrome build does not use the app hand-off.

---

## 5. Permissions

ContextMint Bridge requests several Chrome permissions. Each is required for core functionality — none is used for data collection. See [permission justifications](store-assets/permission-justifications.md) for the full per-permission justification.

---

## 6. Revoking Access

You can revoke an MCP server's trust at any time:

1. Click the ContextMint Bridge icon in the Chrome toolbar to open the popup.
2. Find the MCP server entry.
3. Click **Revoke**.

After revocation, the MCP server must complete a new pair flow (including user approval) before it can make any requests through the extension.

---

## 7. Uninstalling

Uninstalling the ContextMint Bridge extension removes all data stored in `chrome.storage.local` and in the extension's IndexedDB, including the extension's identity keypair and all trust records. Chrome handles this automatically on uninstall.

**Note:** MCP-side identity files (stored at `~/.fetchproxy/identity/<server-name>.json` on your computer) are not part of the extension and are not removed when you uninstall. You can delete them manually if desired.

---

## 8. Children's Privacy

ContextMint Bridge is a developer tool. It is not directed at children and does not knowingly collect any information from anyone.

---

## 9. Changes to This Policy

If this policy changes materially, the updated policy will be published at this URL with a revised **Last updated** date. Because ContextMint Bridge stores no account information, no individual notifications are sent.

---

## 10. Contact

Questions, concerns, or requests related to this privacy policy:

- **Email:** chris.c.hall@gmail.com
- **Issue tracker:** [github.com/chrischall/fetchproxy/issues](https://github.com/chrischall/fetchproxy/issues)
