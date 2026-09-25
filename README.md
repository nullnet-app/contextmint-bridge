# ContextMint Bridge

The browser extension that lets MCP servers on your machine work inside your
signed-in browser tabs. An MCP server asks the extension to make a request; the
extension runs it from a tab you already have open on that site, with your own
session cookies and browser identity, and hands the response back over a local,
encrypted WebSocket (`127.0.0.1:37149`). Every server has to be paired first:
you compare an 8-digit code and approve the exact domains and capabilities it
declared, and you can revoke it from the popup at any time.

In the Chrome Web Store (and in Safari, inside the ContextMint app) it's **ContextMint Bridge**; the protocol
and npm packages are **fetchproxy**. It works with ContextMint and with any
fetchproxy-based MCP or `fpx` running on your machine.

The wire protocol, the MCP-side server (`@fetchproxy/server`), the `fpx` CLI,
the protocol reference and the security threat model live in
[chrischall/fetchproxy](https://github.com/chrischall/fetchproxy). This repo is
the extension only.

## Install (developer / sideload)

Build the unpacked extension from source:

```sh
git clone https://github.com/nullnet-app/contextmint-bridge.git
cd contextmint-bridge
npm ci
npm run build --workspace=@fetchproxy/extension-chrome
```

Then load it into Chrome (or Edge, Arc, Brave):

1. Open `chrome://extensions`.
2. Toggle "Developer mode" (top right).
3. "Load unpacked" → pick `packages/extension-chrome/dist/`.
4. After **every** later pull: rebuild, then press **Reload** on the
   extension's card. Chrome keeps running the bundle it loaded until you do,
   and across a protocol major a stale extension is refused by every MCP with
   `protocol version mismatch` — see
   [`packages/extension-chrome/README.md`](packages/extension-chrome/README.md#install-developer--sideload).

To check it works, start any fetchproxy-based MCP (or run an `fpx` command),
open the extension's popup, confirm the 8-digit pair code matches the one the
MCP printed, and approve.

## Repository layout

| Package                                                  | What it is                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`packages/extension-core`](packages/extension-core)     | Browser-agnostic logic: service worker, pairing and trust, content scripts, popup.                                |
| [`packages/extension-chrome`](packages/extension-chrome) | Chrome MV3 wrapper: `manifest.json`, icons, and the esbuild step that produces `packages/extension-chrome/dist/`. |

```sh
npm test            # vitest, all mocked
npm run typecheck   # tsc (vitest does not typecheck)
npm run build       # every workspace
```

## Privacy

The extension has no telemetry and sends nothing to its developer. See
[`docs/PRIVACY.md`](docs/PRIVACY.md) for exactly what it reads, stores and where
it connects.

## License

MIT — see [`LICENSE`](LICENSE).
