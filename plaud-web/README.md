# RecDock shared workspace

The TypeScript workspace, local Node API, Python audio worker, and device protocol implementation shared with the RecDock Mac app.

**[Visit the official website](https://recdock-plaud-web.vercel.app/)** · **[Download for Mac](https://recdock-plaud-web.vercel.app/#download)** · [Mac user guide](../desktop/README.md)

For everyday use, start with the packaged Mac app. This directory is the source and development entry point for the workspace. The public website presents the product and links to downloads; it does not run the local audio pipeline in your browser.

RecDock is an independent project, not affiliated with or endorsed by PLAUD.

## Workspace capabilities

- Import, play, review, and export local recordings without a PLAUD account.
- Explicitly choose **Import & transcribe** or **Import audio only**; importing alone does not imply approval to start transcription.
- Run local transcription, timestamp alignment, speaker labeling, and revision editing with prepared models.
- Retain original audio, machine drafts, saved edits, and complete readable transcript files.
- Optionally sign in to PLAUD, match an already-bound device, authenticate, inspect status, and retrieve recordings over Bluetooth.
- Send a complete saved transcript to ChatGPT through the [optional Edge extension](extensions/chatgpt-bridge/README.md).
- Use English by default or switch to Chinese; interface language is separate from transcription language.

Automatic transcripts need review. Device and firmware support have separate validation limits from local audio processing.

## Local audio and device recordings

In a running workspace, choose **Import** to import and transcribe or save audio for later. Preparing models and FFmpeg is required for processing, but a PLAUD account and Bluetooth are not required for local imports.

For device recordings:

1. Disconnect the recorder from the phone app and keep it awake near the computer.
2. Choose **Connect PLAUD**, then sign in with the bound account or import an official web session.
3. Select the account's device and connect. Confirm the browser device selection and any system Bluetooth request.
4. Choose a recording and select **Download & transcribe** or **Download Ogg only**. Set the transcription language in **Settings** before starting.

Account device cards show bound devices, not a live nearby-device scan. The browser's initial device-selection permission is still required. Automatic preparation supports legacy protocols and protocol 20; protocol 30 currently requires existing ECC credentials through advanced diagnostics.

The personal recording library remains available when you sign out. Account recordings and device authentication material follow the corresponding PLAUD account scope.

## Recordings and exports

In source development, the default library is `<project>/.local-audio/library/`. Each recording has its own folder, with separate personal/account scopes. `RECDOCK_LIBRARY_DIR` overrides the root; the packaged Mac app sets its own Application Support directory.

A completed transcript and each saved revision write `exports/latest.md`, `latest.txt`, `latest.json`, and revision-specific copies. The workspace displays the storage path. Markdown, TXT, JSON, SRT, and VTT exports cover the complete selected version.

Device downloads keep Ogg alongside the original device bytes. Supported encrypted PLAUD recordings are decrypted locally using the corresponding account RSA material. Already-downloaded files can be recovered under **Settings → Recover original device files**. Unsupported layouts or missing original keys leave the source file intact.

Local imports accept files up to **1 GiB** and audio up to **6 hours**. Bluetooth source downloads are limited to **256 MiB**. Optional browser WAV conversion accepts compressed inputs up to **16 MiB**; retaining Ogg does not require that conversion.

Incomplete Bluetooth transfers remain in page memory for the same account, device, and file. Cancellation or reconnection may reuse them; closing or refreshing the page discards that partial progress. Recording or pause defers file synchronization.

## Accounts and local data

The local API restricts account and credential-preparation requests to official PLAUD HTTPS hosts. Device authentication and recording transfer run locally after preparation. Local audio processing stays on the computer. Explicit ChatGPT forwarding uploads the complete saved transcript and prompt, without audio.

Passwords clear after submission and are not saved. Remembered PLAUD authorization and historical recording keys use an AES-256-GCM file cache with a random local key in a directory restricted to the current OS user. That account-cache key is not independently protected by Keychain. The packaged app's optional Hugging Face download token uses a separate [secure-storage mechanism](../desktop/README.md#prepare-your-models).

The source workspace retains the legacy account-cache location at `~/Library/Application Support/PLAUD BLE Workspace/`. The desktop app uses its own `~/Library/Application Support/RecDock` data directory. Browser IndexedDB stores non-secret device mappings and export preferences.

Ordinary logout removes saved sign-in authorization while retaining historical recording keys. Explicit account-data removal deletes the saved material and may prevent decryption of old recordings. Imported web sessions can require another import when they expire; supported password sessions can refresh their tokens. Offline recovery only reuses previously verified accounts and complete cached device material.

## ChatGPT forwarding

Follow the [extension guide](extensions/chatgpt-bridge/README.md). In source development, the browser bridge accepts the top-level **http://localhost:5173/** workspace. The packaged Mac app uses Native Messaging instead.

Forwarding attaches the full saved Markdown version, including paragraphs hidden by search or pagination. A confirmed task reopens its existing conversation. New drafts, quota issues, login requirements, or page changes pause the task; an uncertain submission is not automatically sent again. The automatic forwarding limit is **8 MiB**, with manual export available for larger transcripts.

## For developers

### Requirements

- **Node.js 22.18–22.x** and npm, matching `package.json`.
- A modern browser over localhost or HTTPS; device connections require desktop Chrome or Edge with Web Bluetooth.
- macOS and Swift tools for native broadcast detection and the persistent-cache helper.
- FFmpeg and the prepared Python/model environment for audio processing; see the [development notes](docs/development.md).
- For a device connection, a supported recorder already bound to your own PLAUD account.

### Run locally

```sh
git clone https://github.com/audiobridge-ai/recdock.git
cd recdock/plaud-web
npm ci
npm run dev
```

Open <http://localhost:5173/> and keep the server running. The development and preview commands provide the loopback local API; a standalone `dist/` folder contains only the frontend and cannot provide account APIs, native helpers, or local processing by itself.

The earlier online-workspace/local-companion architecture is retained for development. `npm run companion` starts the loopback service, while `npm run dev:web` and `npm run preview:web` serve only the frontend. Website authorization and fallback pairing are described in [online companion development](docs/online-companion.md). Ordinary Mac users should use the [desktop app](../desktop/README.md).

### Validate and contribute

From `plaud-web/`:

```sh
npm test
npm run build
npm run preview
```

For language validation, run `node scripts/i18n/check.mjs` from the repository root. Follow the [development notes](docs/development.md) for worker tests and [protocol notes](docs/protocol.md) for device changes. Cross-platform contract checks are documented in the [mobile guide](../plaud-app/README.md#validation).

Use English for new public documentation and contributor-facing text. UI changes must include English and Chinese copy and preserve user content. Historical verification counts belong in dated reports; use the current test commands to validate your checkout. The [RC3 report](../docs/reports/desktop-rc3-i18n-2026-11-12.md) records the published candidate's checks.

Keep the same localhost origin to retain browser device permissions and mappings. If localhost refuses the connection, check that the server is running and the address is correct. The UI and API share an origin; browser security settings do not need to be disabled.

The device implementation does not cover new-device binding, unbinding, recording start/stop, device-file deletion, OTA, or Wi-Fi transfers. Hardware behavior still requires validation beyond synthetic tests.

## License

[MIT](../LICENSE). Model and third-party component licenses apply separately.
