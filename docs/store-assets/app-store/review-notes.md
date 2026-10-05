# App Review notes — ContextMint Bridge

For App Store Connect → the version → **App Review Information**. The **Notes**
block below is pasted as-is (4000-character limit, held by
`tests/app-store-listing.test.ts`).

## Sign-in information

**Sign-in required: yes**, for Connect only (local pairing on the Mac needs no
account). Before the first submission the owner creates a ContextMint demo
account for App Review, with MCP servers already registered so that Connect
has something to show, and types its user name and password into App Store
Connect's **Sign-In Information** fields. The credentials never go in this
repository. The demo account must stay usable for as long as a version is in
review.

## Contact information

The owner's name, phone and email, typed in App Store Connect (not kept here).

## Notes

```text
WHAT THIS IS
ContextMint Bridge is a Safari web extension. The app exists because Safari extensions ship inside an app. Its one screen says what the extension does, shows whether Safari has it turned on, and opens Safari's Extensions settings. The extension is the product (Guideline 4.2: the app is the enable guide for it, which is the shape Apple's own Safari Web Extension packager produces).

The extension lets MCP (Model Context Protocol) servers, the tools AI assistants use, make web requests from inside the person's own signed-in Safari tab, so the person never copies a password, token or cookie into a tool.

WHY IT ASKS FOR ALL WEBSITES
The person chooses which sites each tool may reach, and those differ per person, so the extension cannot list its sites in advance. Access is still per tool and per domain: a tool can do nothing until the person compares an 8-digit pair code shown in the extension with the one the tool prints, and approves the exact domains, cookies, storage keys and headers it lists. Requests to any other domain are refused inside the extension. Every request and response is end-to-end encrypted between the extension and the tool. No analytics or telemetry; the app makes no network connections at all.

HOW TO SEE IT WORK ON A MAC (no account needed)
1. Open ContextMint Bridge once, click Open Safari Extensions Settings, turn ContextMint Bridge on, and allow it on example.com (or all websites).
2. In Safari, open https://example.com/ and leave the tab open.
3. In Terminal, with Node.js (current LTS) installed, run fpx, the fetchproxy command-line tool:
   npx @fetchproxy/cli profile add review --domain example.com
   npx @fetchproxy/cli get https://example.com/ -p review
4. The terminal prints a pair code, and the ContextMint Bridge toolbar icon shows a badge. Open the extension: it shows the same code, the domain example.com and the capability requested. Click Approve.
5. The terminal prints the HTML of example.com, fetched through the open Safari tab. Running step 3's second command again needs no approval. Removing the pairing (Forget in the extension) makes it ask again.

HOW TO SEE IT WORK WITH CONNECT (Mac, iPhone or iPad)
1. Turn the extension on as above (on iPhone or iPad: Settings > Apps > Safari > Extensions > ContextMint Bridge).
2. Open the extension in Safari and choose Connect to mcp.nullnet.app.
3. A tab opens on ContextMint; sign in with the demo account in Sign-In Information and confirm this browser.
4. The extension now shows "Connected to" the demo account, and the MCP servers that account hosts appear under Trusted MCPs. When one asks for something new, the extension asks the person to allow it first.
On iPhone and iPad there are no local MCP servers, so Connect is the only path, and iOS serves requests while Safari is open.

The source, the protocol and the threat model are public: github.com/nullnet-app/contextmint-bridge and github.com/chrischall/fetchproxy.
```
