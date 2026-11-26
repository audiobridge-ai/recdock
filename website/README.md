# RecDock website

**[Open the official website](https://recdock-plaud-web.vercel.app/)** for the product overview, Mac download, system requirements, model information, and integration contact links.

The website is the main entry point for users. Audio import, local transcription, and transcript review run in the [Mac app](../desktop/README.md). The illustrated workspace on the website is an interactive mockup and does not process audio.

English is the default. **中文 / English** changes the displayed copy and remembers the visitor's choice. The static site uses no external fonts, analytics scripts, accounts, or recording uploads.

## For developers

Run this command from the repository root; no dependency installation is needed:

```sh
node website/build.mjs
```

The output is `website/dist/`. `python3 website/build.py` provides an alternative copy-based build.

| File | Purpose |
| --- | --- |
| `index.html` | English HTML, semantic page structure, and download links |
| `locales.js` | English/Chinese copy and remembered language switching |
| `styles.css` | Responsive layout and visual styles |
| `demo.js` | Interaction for the illustrative transcript |

The existing Vercel project uses `website` as its Root Directory, `node build.mjs` as its Build Command, and `dist` as its Output Directory. Its install command is `node --version`; the site has no npm dependencies. Deployment and verification records are in the [RC3 publication report](../docs/reports/desktop-rc3-publication-2026-11-12.json).

When publishing a new app version, verify its release assets, checksum, system requirements, and build information before changing the download links. Update both the initial English HTML and the corresponding entries in `locales.js`. Keep user instructions ahead of engineering details and clearly distinguish illustrations from tested product behavior.
