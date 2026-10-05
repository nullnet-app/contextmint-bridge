# App Store listing assets — ContextMint Bridge

What to put where in App Store Connect for **ContextMint Bridge** (app record
6819349214, bundle ID `app.nullnet.contextmint.bridge`, iOS and macOS in one
universal-purchase record). The Chrome Web Store's assets are one folder up;
this folder is the Safari app's.

| File | App Store Connect field |
| --- | --- |
| [`listing.md`](listing.md) | Name, subtitle, promotional text, description, keywords, category, support / marketing / privacy policy URLs, copyright |
| [`review-notes.md`](review-notes.md) | The version → App Review Information (notes; what goes in Sign-In Information) |
| [`app-privacy.md`](app-privacy.md) | App Privacy, App Information → Age Rating, export compliance (owner step O5) |
| `screenshots/mac/*-1280x800.png` | macOS → Screenshots (1280x800) |
| `screenshots/iphone/*-1320x2868.png` | iOS → iPhone 6.9" Display (1320x2868) |
| `screenshots/ipad/*-2064x2752.png` | iOS → iPad 13" Display (2064x2752) |

Upload the screenshots in file-name order. Every one is a 24-bit PNG with no
alpha channel, at exactly its device's size;
`packages/extension-chrome/tests/store-assets.test.ts` checks that, and that
the iPhone and iPad shots show no MCP connected over loopback (nothing local
can reach the extension on iOS) and name no other browser.

## Regenerating the screenshots

They are rendered from the **real popup of the Safari build**
(`packages/extension-safari/dist/`), with the same stubbed `chrome.*` and
seeded vault as the Chrome Web Store shots, then placed on branded canvases.
After any popup change:

```sh
npm ci
npm run store-assets --workspace=@fetchproxy/extension-chrome
```

That rebuilds both extensions and rewrites every image, Chrome's and these.
`-- --only=app-store` renders only this folder's. It needs a local Chrome or
Chromium (`CHROME_PATH` overrides). The scenes and headlines are
`APP_STORE_SCREENSHOTS` in `packages/extension-chrome/store-assets/scenes.ts`;
the canvases are `appStoreScreenshotHtml` in `canvas.ts`.

## What is not here yet

Screenshots of the container app itself (its one enable screen) and of the
extension running in a real Safari need a dev- or TestFlight-signed build:
Safari never runs an ad-hoc-signed extension. They are optional for the
listing and are left to the owner's live checks (plan Task 8).
