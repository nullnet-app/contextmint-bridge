# App Privacy, age rating and export compliance (owner step O5)

The answers the owner types into App Store Connect for ContextMint Bridge (app
record 6819349214). They are derived from `docs/PRIVACY.md`, the container's
privacy manifests (`apple/App/PrivacyInfo.xcprivacy`,
`apple/Extension/PrivacyInfo.xcprivacy`) and fetchproxy `docs/SECURITY.md`
§T-remote-bridge. If any of those change, re-check this page.

## App Privacy

App Store Connect → App Privacy. Apple counts data as **collected** when it is
sent off the device and kept, by the developer or a partner, for longer than it
takes to serve the request in real time. That rules out most of what the
extension handles:

| What | Leaves the device? | Kept by the developer? | Counts as collected? |
| --- | --- | --- | --- |
| The container app | No: no network connection, no storage | — | No |
| Request and response contents, cookies, storage values an approved MCP reads | Only to the MCP the person paired, end-to-end encrypted (AES-256-GCM, per-session keys); a relay sees ciphertext | No: the relay cannot read them | No |
| Trust records, identity keys, bridge credential | No: the extension's own storage on the device | — | No |
| Analytics, crash reports, advertising identifiers | Not gathered at all | — | No |
| **Connect** (optional): this browser's **public identity key** and its **browser name** (editable; "Safari on iPhone" by default), sent to `https://mcp.nullnet.app` | Yes, when the person chooses Connect | Yes: the gateway keeps them with the bridge credential it issues, under the ContextMint account the person signed into | **Yes** |
| Relay metadata on a connected bridge (MCP server names, declared domains and key names, pair codes, timing and sizes; PRIVACY.md §4) | Yes, while a connected bridge carries traffic | Only if the gateway logs it beyond real time (check mcp-host's retention) | Only if kept |

So "Data Not Collected", which the plan expected, is true of the app and of
local use, but **not** of Connect, which the developer's own gateway operates.
Recommended answer (conservative, and the one that matches PRIVACY.md):

**Do you or your third-party partners collect data from this app?** Yes.

| Data type | Collected for | Linked to the user? | Used for tracking? |
| --- | --- | --- | --- |
| Identifiers → **Device ID** (the browser's public identity key, stored by the gateway on Connect) | App Functionality | Yes (kept under the ContextMint account the person connected) | No |
| Other Data → **Other Data Types** (the browser name chosen at Connect) | App Functionality | Yes | No |

Add **Usage Data → Product Interaction** (App Functionality, linked, not
tracking) only if mcp-host keeps per-MCP relay metadata beyond real time.
Nothing else applies: no contact info, health, financial, location, contacts,
user content, browsing or search history, diagnostics or purchases.

The alternative, **Data Not Collected**, is defensible only if Connect counts as
ContextMint's collection (the ContextMint app's own label already declares the
account and the browsers paired to it) rather than this app's. That is the
owner's call; the table above is the answer that cannot be called wrong.

**Privacy Policy URL:**
`https://github.com/nullnet-app/contextmint-bridge/blob/main/docs/PRIVACY.md`
(the link the container app's screen opens, too).

## Age rating

App Store Connect → App Information → Age Rating. Every content question is
**None** / **No**: no violence, sexual content, profanity, horror, drugs,
alcohol, tobacco, gambling, contests or medical content; no user-generated
content, messaging or chat; no advertising; no parental controls or age
assurance. **Unrestricted Web Access: No**: the app has no web view, and the
extension makes requests only inside the person's own Safari tabs on domains
they approved. **Result: 4+.**

## Export compliance

`apple/project.yml` sets `ITSAppUsesNonExemptEncryption: false` on both
containers, so App Store Connect does not ask per build. That answer holds:
the container has no cryptography of its own, and the extension's
X25519 / Ed25519 / HKDF / AES-256-GCM all run through Safari's WebCrypto
(`crypto.subtle`, via `@fetchproxy/protocol`), with no bundled crypto library.
That is "encryption limited to that within the Apple operating system", which
needs no documentation. If a JavaScript crypto library ever lands in the
extension, this answer must be revisited before the next upload.

## URLs

| Field | Value |
| --- | --- |
| Privacy Policy URL | `https://github.com/nullnet-app/contextmint-bridge/blob/main/docs/PRIVACY.md` |
| Support URL | `https://github.com/nullnet-app/contextmint-bridge/issues` |
| Marketing URL | optional; `https://github.com/nullnet-app/contextmint-bridge` |
