# RecDock

A local recording workspace for importing, transcribing and reviewing audio, with optional PLAUD Bluetooth device support.

RecDock is an independent client. It is not affiliated with or endorsed by PLAUD.

## Features

- A persistent recording workspace that works without a PLAUD account; login and connection use a modal, with settings in a side drawer.
- Email/password sign-in or user-initiated import of an official Web session.
- Account-bound device cards and a single Connect action that prepares authentication material automatically.
- Automatic protocol detection from advertisements, with a macOS bridge when browser advertisement access is unavailable.
- Device overview with recording status, battery and storage information.
- A unified recording list, Bluetooth downloads, cancellation and same-page resume.
- Explicit **Download and transcribe** or **Download Ogg only** actions; discovering or importing a file does not implicitly start transcription.
- Offline local transcription, speaker labels, timestamp playback, revision editing and automatic readable transcript files.
- One-click ChatGPT delivery of the complete saved transcript through an optional Edge extension, with one bound tab, submission receipts and duplicate protection.
- Local recovery of supported encrypted recordings and WAV or Ogg export.
- Remembered login, device mappings and export preferences, with historical account keys retained for older recordings.

## Requirements

- Node.js **22.18 or newer** and npm.
- A modern browser opened through `localhost` or HTTPS. Device connections require desktop Chrome or Edge with Web Bluetooth.
- For device connections: a supported recorder bound to your own PLAUD account.
- **macOS** for the native broadcast and persistent-cache helpers, with Swift available through Xcode or Apple's Command Line Tools.

The complete workflow currently targets macOS. Support depends on the device and firmware. Automatic preparation covers legacy protocols and protocol 20; protocol 30 currently requires existing ECC credentials through advanced diagnostics.

## Quick start

```sh
git clone https://github.com/audiobridge-ai/recdock.git
cd recdock
npm ci
npm run dev
```

Open **http://localhost:5173/** and keep the local server running.

For local audio, open **Import** and choose **Import and transcribe** or **Import audio only** directly in the workspace. A PLAUD login and Bluetooth are not required. Model preparation and FFmpeg are required for processing; see the [development notes](docs/development.md).

For PLAUD recordings:

1. Disconnect the recorder from the phone App and keep it awake near the computer.
2. Click **Connect PLAUD** in the workspace header. Sign in or import an official Web session in the dialog.
3. Select your device and click **Connect**. Confirm the browser device selection and any system Bluetooth permission request.
4. RecDock identifies the protocol and prepares authentication automatically. Closing the dialog leaves the connection running; **Cancel connection** is a separate action.
5. Select a device recording in the left list and choose **Download and transcribe** or **Download Ogg only**. Set the shared transcription language under **Settings** before starting.

The workspace retains its selected recording, playback and unsaved transcript edits while dialogs open. Open **Filter** for source and processing-state filters, reset, or the recycle bin. Local imports always go into the personal library. The list also includes the signed-in account's library; logging out hides that account's private recordings while keeping personal recordings available. Connected-device actions and account actions are in the header menus; settings and diagnostics open in a drawer.

The device cards show account-bound devices, not a live list of nearby Bluetooth devices. The browser's initial device-selection permission is still required. Previously authorized devices can be reused when the browser supports it.

## Login and local data

The local server sends account and material-preparation requests to restricted official PLAUD HTTPS API hosts. After preparation, BLE authentication, state updates and recording transfers operate locally. Recording audio is processed on your computer. When you explicitly send a transcript to ChatGPT, its complete text and your prompt are uploaded to the ChatGPT page you connected; audio is not included.

Passwords are cleared after submission and are not persisted. With remembered login enabled, access/refresh tokens and authentication material are saved in an AES-256-GCM file cache. The random encryption key and encrypted data are stored in a directory restricted to the current OS user; the key is not protected independently by Keychain. RecDock does not request a Keychain password.

For compatibility with existing installations, the macOS cache lives at:

```text
~/Library/Application Support/PLAUD BLE Workspace/
```

Browser IndexedDB stores only non-secret device mappings and export preferences. Ordinary logout removes saved login authorization while retaining historical recording keys. The explicit local-data removal action deletes that account's saved material and may prevent recovery of older recordings.

Cloud-session restoration verifies the account identity. Supported password sessions can refresh their tokens; imported Web sessions may require another import when their token expires. A bounded offline restore can reuse previously verified account and complete device material. It does not replace initial account authentication.

## Recordings and export

Device downloads keep **Ogg** by default, alongside the original device bytes. They are saved by the local service into `<project>/.local-audio/library/`, with separate personal/account scopes and one folder per recording. Set `RECDOCK_LIBRARY_DIR` to override the root. The first start copies and hash-verifies an existing legacy library without deleting the old directory.

Transcription starts only when explicitly selected. A completed transcript, and every saved edit, writes `exports/latest.md`, `latest.txt`, `latest.json` and revision-specific copies in the same recording folder. The workspace displays the folder path.

Supported `PLAUD.AI` recordings are decrypted locally with the corresponding account RSA material before audio packaging. Existing downloaded files can be recovered under **Settings → Device original-file recovery**.

Unknown formats, unsupported multistream layouts or unavailable original keys leave the original `.bin` intact. Renaming a file extension does not convert it. Optional browser WAV conversion accepts compressed inputs up to 16 MiB; this limit does not apply to retaining Ogg. Bluetooth downloads have a 256 MiB source-file limit. Library imports accept up to 1 GiB per uploaded file and audio up to 6 hours; those project limits still apply to Ogg.

Incomplete transfers are kept only in page memory for the same account, device and file. They may resume after cancellation or disconnection, but refreshing or closing the page discards them. Recording or pause defers file synchronization.

## Send a transcript to ChatGPT

Load the [optional Edge extension](extensions/chatgpt-bridge/README.md), refresh the workspace, then connect an existing signed-in ChatGPT tab under **Settings → ChatGPT delivery**. Select a completed transcript and click **Send to ChatGPT**. The full saved version is attached as Markdown, including paragraphs hidden by search or pagination. Save or cancel pending edits first.

The extension reuses one bound tab and processes one task at a time. A confirmed submission becomes **Open ChatGPT**; repeated clicks open the existing conversation. Login, drafts, upload limits or page changes pause the task and offer manual export. The automation limit is 8 MiB per Markdown file; files are never truncated. A submission receipt does not imply cross-conversation retrieval or memory storage. See the [delivery notes](docs/chatgpt-forward-delivery.md).

## Development

```sh
npm test
npm run build
npm run preview
```

The current JavaScript suite passes **323 tests**, TypeScript checks and a production build on this Mac. The unchanged Python worker baseline previously passed **39 tests**. FFmpeg is required for the recording library and local processing, and also enables independent audio interoperability tests. See [development notes](docs/development.md) and [protocol notes](docs/protocol.md).

Both development and preview commands provide the loopback-only local API. The `dist/` directory contains only the frontend; hosting it alone does not provide login, native detection or the local-cache API. Keep the same `localhost` origin to preserve browser device permissions and mappings.

`localhost refused to connect` usually means the local server is not running or the address/port is incorrect. The UI and API share the same origin; disabling browser CORS protections is unnecessary.

## Scope

RecDock currently focuses on already-bound devices, status monitoring, recording retrieval, local transcript review and optional ChatGPT delivery. It does not implement new-device binding, unbinding, recording start/stop control, device-file deletion, OTA or Wi-Fi transfers. Device and firmware behavior still needs hardware validation beyond the synthetic test suite.

## License

[MIT](LICENSE)
