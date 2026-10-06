# Chrome Web Store listing assets — ContextMint Bridge

What to put where in the Chrome Web Store developer console.

| File                                                                                 | Console field                                        |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| [`listing-description.md`](listing-description.md)                                   | Store listing → Description                          |
| [`permission-justifications.md`](permission-justifications.md)                       | Privacy practices → single purpose + each permission |
| [`promo-small-440x280.png`](promo-small-440x280.png)                                 | Store listing → Small promo tile (440x280)           |
| [`promo-marquee-1400x560.png`](promo-marquee-1400x560.png)                           | Store listing → Marquee promo tile (1400x560)        |
| [`screenshots/1-trusted-mcps-1280x800.png`](screenshots/1-trusted-mcps-1280x800.png) | Store listing → Screenshots (1280x800), first        |
| [`screenshots/2-pair-prompt-1280x800.png`](screenshots/2-pair-prompt-1280x800.png)   | Screenshots, second                                  |
| [`screenshots/3-scope-update-1280x800.png`](screenshots/3-scope-update-1280x800.png) | Screenshots, third                                   |

The Safari app's App Store listing (copy, review notes, privacy answers and
its Mac, iPhone and iPad screenshots) is in [`app-store/`](app-store/README.md).

The store icon (128x128) is `packages/extension-chrome/icons/128.png`, which is
already in the uploaded zip; the console's Store icon field takes the same file. The privacy policy URL is `docs/PRIVACY.md`.

Every image is a 24-bit PNG with no alpha channel, as the store requires
(`packages/extension-chrome/tests/store-assets.test.ts` checks the sizes and
the format).

## Popup reference shots (not uploaded)

`popup/` holds the bare popup in every state worth reviewing — the trusted list
with long names and the Inactive disclosure open, Connect waiting for the
gateway's Confirm, connected with an account, a pairing prompt, a scope update,
the key-changed account card, a vouched card, and the warnings — each in light
and dark (`<scene>-<light|dark>.png`), plus `-end.png` where the popup scrolls
past 600px, showing its foot. They are the visual reference for a popup change,
rendered by the same command below; the layout they show is the design system's
ExtensionPopup spec (`system/ui_kits/contextmint/components/ExtensionPopup.md`).

## Regenerating the images

The screenshots are rendered from the **real popup**: the built
`packages/extension-chrome/dist/popup.html` and `popup.js`, loaded in headless
Chrome with a stubbed `chrome.*` and trust records seeded through the
extension's own vault code, then placed on a branded 1280x800 canvas. So after
any popup change, regenerate them rather than editing the PNGs:

```sh
npm ci
npm run store-assets --workspace=@fetchproxy/extension-chrome
```

That rebuilds the extension, then rewrites every PNG in this folder. It needs a
local Chrome or Chromium: it uses `CHROME_PATH` if set, otherwise the usual
install locations. Commit the changed PNGs with the change that caused them.

The generator lives in `packages/extension-chrome/store-assets/`:

- `scenes.ts` — the popup states shown (trusted MCPs, a pairing prompt, a
  scope-update offer, and the `popup/` reference states) and each screenshot's
  headline. Every name and domain is illustrative (`example.com`).
- `chrome-stub.ts`, `seed.ts` — the `chrome.*` stub and the vault seeding.
- `canvas.ts` — the branded canvases and the promo tile.
- `png.ts` — re-encodes Chrome's RGBA screenshots as 24-bit RGB.
- `generate.ts` — drives headless Chrome (`puppeteer-core`, a devDependency).

None of it is bundled into the extension.

## Brand

ContextMint, from `chrischall/nullnet-design-system` v1.6.1: ink `#0b0b0f`,
paper `#fafafa`, star `#f5c518`, the system font stacks, the ContextMint Bridge
mark (`packages/extension-chrome/icons/icon.svg`) and the Cursor C
(`packages/extension-chrome/store-assets/brand/contextmint-icon.svg`, copied
verbatim from `system/assets/`). Change the mark in the design system, then
re-copy it — never redraw it here.
