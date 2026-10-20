# Fonts and licences

Every font in this package is free software under the **SIL Open Font License 1.1** (OFL). You may bundle, self-host
and serve them with the widget, including in a commercial product. Keep the licence text next to the files and do not
sell the fonts on their own. Full texts are in this folder.

| Family | Files here | Weights | Used by | Copyright | Licence text |
|---|---|---|---|---|---|
| Vazirmatn | `vazirmatn-400/500/600/700.woff2` | 400, 500, 600, 700 | WebYar (all text). Respok when the widget runs right-to-left (Persian) | Copyright 2015 The Vazirmatn Project Authors (https://github.com/rastikerdar/vazirmatn) | `OFL-Vazirmatn.txt` |
| Figtree | `Figtree-Regular/Medium/SemiBold/Bold/ExtraBold.woff2` | 400, 500, 600, 700, 800 | Respok (all Latin text) | Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree) | `OFL-Figtree.txt` |
| DM Mono | `DMMono-Regular.woff`, `DMMono-Medium.woff` | 400, 500 | Respok: inline code and tracking numbers only | Copyright 2020 The DM Mono Project Authors (https://www.github.com/googlefonts/dm-mono) | `OFL-DMMono.txt` |

Notes

- The Vazirmatn files are byte-identical to the ones already shipped in production at `public/widget/fonts/vazirmatn-*.woff2`
  (they exist there today but have no `@font-face`).
- DM Mono is published only as TTF. The `.woff` files here are lossless WOFF (zlib) wraps of the official
  `DMMono-Regular.ttf` / `DMMono-Medium.ttf`. If your build can produce WOFF2, converting them is fine.
- `fonts.css` in this folder declares all faces with paths relative to itself. Production must load font faces at
  **document level** (the existing `<link id="gs-presentation-fonts">`), because `@font-face` inside a shadow root is
  ignored by Chromium and Safari.
