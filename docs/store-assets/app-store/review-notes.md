# App Review notes — ContextMint Bridge

For App Store Connect → the version → **App Review Information**. The **Notes**
block below is pasted as-is (4000-character limit, held by
`tests/app-store-listing.test.ts`).

## Sign-in information

**Sign-in required: no**. The extension's core function, pairing an MCP server
and approving its sites (the Mac steps in the Notes), needs no account. Connect
is optional and links the extension to a ContextMint account, which is
invite-only and signs in only through Google, Apple or GitHub (no passwords),
so it cannot be offered as a reviewer login. Instead, a short screen recording
of the Connect flow is uploaded as a review attachment in App Review
Information, file name `ContextMint-Bridge-Connect.mov` (see the shot list
below). Leave App Store Connect's sign-in fields empty.

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
Connect is optional. It links the extension to a ContextMint account, which is invite-only and signs in through Google, Apple or GitHub (no passwords), so no demo login can be provided. The attached video ContextMint-Bridge-Connect.mov shows the full flow on a Mac: turning the extension on, choosing Connect to mcp.nullnet.app, signing in and confirming the browser on ContextMint's page, the extension showing "Connected to" the account, a hosted MCP server attaching, and a request served through a signed-in Safari tab. On iPhone and iPad Connect works the same way, and requests are served while Safari is open.

The source, the protocol and the threat model are public: github.com/nullnet-app/contextmint-bridge and github.com/chrischall/fetchproxy.
```

## Demo video shot list

For the owner: a recording of about 2 minutes, attached in App Store Connect →
the version → App Review Information → **Attachment**.

**Before recording**

- Use a ContextMint account that shows only demo MCP servers, for example one
  MCP against a public site such as example.com. No personal or work MCPs.
- Use a clean Safari window: no other tabs, no bookmarks bar, no other signed-in
  accounts or tabs with personal data. Hide the Dock and turn on Do Not Disturb
  so no notifications appear.
- Make sure ContextMint Bridge is installed from the build under review and
  that no Connect pairing exists yet (Forget it in the extension if it does).

**Recording**

Press Cmd-Shift-5, choose Record Selected Window (or Record Selected Portion
around Safari and System Settings), then Record. No narration is needed; pause
a second or two on each screen so the reviewer can read it.

1. Open the ContextMint Bridge app: its one screen, then Open Safari
   Extensions Settings.
2. Turn ContextMint Bridge on in Safari's Extensions settings and allow it on
   the demo site.
3. In Safari, open the extension from the toolbar and choose Connect to
   mcp.nullnet.app.
4. On ContextMint's page, sign in with Google, Apple or GitHub, then confirm
   this browser. (Keep any account picker showing only the demo identity.)
5. Back in the extension: it shows "Connected to" the account.
6. A hosted MCP server attaches and appears under Trusted MCPs; approve what it
   asks for.
7. Open the demo site in a Safari tab, signed in if it needs it, and run a
   request from the hosted MCP; show the result arriving and the extension's
   activity for that request.
8. Stop the recording from the menu bar.

**Export**

Trim the start and end in QuickTime Player (Edit → Trim), then save as a .mov
under 500 MB at ~/Movies/ContextMint-Bridge-Connect.mov and upload it as the
review attachment.
