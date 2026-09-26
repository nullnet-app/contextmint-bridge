# Privacy Policy — ContextMint Bridge (fetchproxy)

**Last updated: 2026-09-26**

ContextMint Bridge is a Chrome extension that bridges local MCP (Model Context Protocol) servers to your signed-in browser tabs. All communication is confined to your local machine. This policy describes exactly what data ContextMint Bridge processes, stores, and shares.

---

## 1. What ContextMint Bridge Does

ContextMint Bridge acts as a relay between Node.js MCP servers running on your computer and web pages you have open in Chrome. When an MCP server makes a request, ContextMint Bridge executes that request inside the browser tab you have open — carrying your existing session cookies and authentication — and returns the result to the MCP server over a local WebSocket connection.

No data leaves your machine through ContextMint Bridge. Every connection is `127.0.0.1` only.

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

ContextMint Bridge generates a long-term Ed25519 signing keypair and an X25519 public key the first time it starts. These keys are used to authenticate the extension to MCP servers; the X25519 public key is only an identifier, and its private half is discarded as soon as it is made, because nothing uses it. They are stored in the extension's own IndexedDB, which websites and the extension's content scripts cannot access, and the signing key is held as a non-extractable key: the browser can sign with it, but will not hand its bytes to anyone, including the extension itself. This is the same in every browser the extension runs in, Safari included. (Earlier versions kept them in `chrome.storage.local`; the first start after upgrading moves them and deletes the old copy. Some earlier versions also kept the X25519 private key; the first start after upgrading deletes it and keeps the public key, so existing pairings are unaffected.)

### 3.2 Trust Records

When you approve an MCP server at pair time, ContextMint Bridge stores a trust record containing:
- The MCP server's public keys.
- The server name.
- The approved capability set and domain list.
- A timestamp.

Trust records are stored in the extension's own IndexedDB, which websites and the extension's content scripts cannot read or change. (Earlier versions kept them in `chrome.storage.local`; the first start after upgrading moves them.) You can revoke any trust record from the extension popup at any time.

### 3.3 Pending-Pair State

While a pair confirmation is in progress (the 8-digit code dialog is showing), a transient pending-pair entry is held in `chrome.storage.local`. It is removed as soon as the pair is approved, rejected, or times out.

---

## 4. Data Shared Externally

**None.**

ContextMint Bridge contains no telemetry, no analytics, no crash reporting, no remote configuration, no feature flags, and no A/B testing. It reports nothing to its developer or to any third party. The only network connections the extension is involved in are:

- The local WebSocket connection to `127.0.0.1:37149` (MCP server connections on your own machine).
- HTTP requests made inside your browser tabs at the explicit direction of an approved MCP server.
- **Outbound WebSocket connections to remote bridge targets you configure yourself** in the popup (a `wss://` relay that hosts MCP servers somewhere other than your machine). These are off by default: none exist until you add one, and removing or disabling a target closes its connection. The connection carries the access token you entered for that relay (as a WebSocket subprotocol). The contents of every request, response and cookie are end-to-end encrypted between the extension and each MCP server, so the relay cannot read them — but the relay operator can see the handshake metadata around them: the extension's hello (its ID, version and public identity keys), each MCP's hello (server name and version, `mcpId`, declared domains, capabilities and key names), the pair code shown during pairing, and the timing and size of frames. See [SECURITY.md §T-remote-bridge](https://github.com/chrischall/fetchproxy/blob/main/docs/SECURITY.md#t-remote-bridge--a-configured-remote-bridge-target).
- **Safari only — the bridge target the ContextMint app hands over.** In Safari, ContextMint Bridge ships inside the ContextMint app. When you set up the browser bridge in that app, the extension asks it — the app on the same device, over Safari's native messaging, never the network — for the bridge address and its access credential, and connects to that address exactly as it would to a remote bridge target you added yourself (the same `wss://` requirement and the same relay-visible metadata apply). The extension keeps the address and credential **in memory only**: they are never written to `chrome.storage`, IndexedDB or any other storage, never logged, and are asked for again each time Safari restarts the extension. The only thing the extension tells the app is whether that one connection is currently up — no browsing data, URLs, cookies or request content. Disconnecting in the ContextMint app removes the target. The Chrome build does not do any of this.

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
