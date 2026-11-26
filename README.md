# RecDock

Turn recordings into transcripts you can review and use. RecDock is a free, open-source recording workspace for your Mac, with local transcription, timestamp playback, speaker labels, editing, and complete transcript export.

**[Visit the official website](https://recdock-plaud-web.vercel.app/)** · **[Download for Mac](https://recdock-plaud-web.vercel.app/#download)** · [Release notes and checksums](https://github.com/audiobridge-ai/recdock/releases/tag/desktop-v1.0.0-rc.3)

Start with the website for a product overview, system requirements, and downloads. You can import audio and use the local library without a PLAUD device or a RecDock account.

RecDock is an independent project, not affiliated with or endorsed by PLAUD.

## Get started

1. **Download RecDock** from the [website](https://recdock-plaud-web.vercel.app/#download). The current Mac release candidate is **1.0.0-rc.3**; installation files and their checksums are hosted on GitHub Releases.
2. **Install the Mac app.** Quit any older RecDock app or companion, fully extract the ZIP, and move `RecDock.app` to Applications. Follow the [first-launch instructions](#first-launch-on-macos) if macOS blocks it or says the app is damaged.
3. **Prepare your models.** Open **Models & App** to select an existing model folder or download and verify the models. The speaker model requires you to accept its Hugging Face access conditions and supply an authorized download token.
4. **Import a recording.** Select its language under **Settings → Transcription settings**, then choose **Import → Import & transcribe**, or **Import audio only** to save it for later. No device connection or PLAUD sign-in is needed for local audio.
5. **Review and take the transcript with you.** Click timestamps to listen, edit text and speaker names, then export the complete transcript or optionally [send it to ChatGPT](#send-a-transcript-to-chatgpt).

You do not need Node.js, Python, Homebrew, or developer tools to use the packaged app. For a walkthrough, see the [Mac app guide](desktop/README.md).

### System requirements

| Item | Current Mac candidate |
| --- | --- |
| Hardware | Apple Silicon Mac |
| Operating system | macOS 26.2 or later |
| App download | About 487 MB as a ZIP; about 1.50 GB extracted |
| Local models | About 3.78 GB, downloaded separately |
| Free space | At least 10 GB recommended, plus space for recordings and temporary files |
| Internet | Needed for initial model downloads, optional PLAUD account access, and ChatGPT forwarding |
| Other desktop platforms | Windows and Intel Mac downloads are not available yet |

The current release is an **unnotarized candidate**, with a local ad-hoc signature rather than a Developer ID certificate. Read the [release notes](https://github.com/audiobridge-ai/recdock/releases/tag/desktop-v1.0.0-rc.3) and [installation guide](desktop/README.md#install-recdock) before installing. Clean-Mac installation and desktop PLAUD hardware regression remain unverified.

### First launch on macOS

> [!WARNING]
> The current Mac candidate is not signed with an Apple Developer ID certificate or notarized by Apple. You may need to explicitly allow it to run on first launch.

After moving the app to Applications, macOS may display:

> “RecDock.app” is damaged and can't be opened. You should move it to the Bin.

For a trusted, verified download, first try **System Settings → Privacy & Security → Open Anyway**, following [Apple's instructions](https://support.apple.com/en-us/102445).

If the downloaded app is still blocked by quarantine, and you have verified the official release's checksum and the app bundle using the [installation checks](desktop/README.md#if-macos-says-recdock-is-damaged), open Terminal and run:

```sh
xattr -rd com.apple.quarantine "/Applications/RecDock.app"
```

Then open RecDock again. This removes the download-quarantine attribute from **RecDock.app and its bundled files only**; the app remains ad-hoc signed and unnotarized. A replacement download or update may need approval again.

A damaged-app message can also indicate actual corruption or tampering. If integrity checks fail or macOS reports malware, stop and re-download or report the issue. Company-managed Macs may enforce additional restrictions.

## What you can do

- **Work locally:** import audio, keep the original file, and transcribe on your Mac after model setup.
- **Listen and review:** follow paragraph timestamps, check speaker labels, and correct the transcript against the recording.
- **Keep your revisions:** retain the machine draft alongside saved edits and historical versions.
- **Export complete transcripts:** choose Markdown, TXT, JSON, SRT, or VTT.
- **Continue in ChatGPT:** send a complete saved transcript and your prompt through the optional browser extension.
- **Retrieve device recordings:** optional PLAUD support connects to already-bound devices; see [device support and release status](desktop/README.md#device-support-and-release-status) for the validation limits.

Automatic transcripts are drafts. Review text, timing, and speaker attribution before relying on them.

## Send a transcript to ChatGPT

1. In **Models & App**, open the extension folder and follow the [Edge extension setup guide](plaud-web/extensions/chatgpt-bridge/README.md).
2. Open ChatGPT in Edge and sign in to the account you want to use.
3. In RecDock, open **Settings → ChatGPT forwarding → Connect an existing ChatGPT tab**.
4. Open a completed recording and choose **Send to ChatGPT**.

RecDock sends the complete saved transcript as a Markdown attachment with your prompt. It does not send the audio. Search filters and pagination do not shorten the attachment. No OpenAI API key is required for this browser workflow.

You can also export the transcript and upload it manually. ChatGPT sign-in, upload limits, and available features depend on your account.

## Your data and language

On Mac, recordings, models, and saved edits stay on your computer during local processing. The app keeps its data outside the application bundle, so replacing the app during an update preserves your library and model selection. See [data, updates, and background tasks](desktop/README.md#data-updates-and-background-tasks).

Model downloads and optional PLAUD account operations use their respective online services. Only an explicit **Send to ChatGPT** action forwards your saved transcript and prompt to ChatGPT.

English is the default interface language. Use **中文 / English** to switch; the app, website, and extension each remember their own choice. Interface language is separate from transcription language and does not translate your recording titles, transcript text, or custom speaker names.

## Get help or discuss an integration

- [Read the Mac app guide](desktop/README.md) for setup, model access, updates, and troubleshooting.
- [Report an issue](https://github.com/audiobridge-ai/recdock/issues) with your app version, macOS version, and the relevant error message. Keep recordings, credentials, and tokens out of public reports.
- [Discuss an integration](https://github.com/audiobridge-ai/recdock/issues/new) if you build recording devices or software. RecDock demonstrates device connectivity, local audio processing, transcript review, and desktop integration; we welcome conversations about bringing these capabilities into other products.

RecDock's own code is available under the [MIT License](LICENSE). Models and bundled third-party components retain their upstream licenses; see the [model notices](plaud-web/worker/MODEL-NOTICES.md).

## For developers

The Mac app is the primary downloadable product. The repository also contains its shared workspace, the marketing website, an earlier web-companion architecture, and an experimental Flutter mobile client.

### Repository map

| Directory | Purpose | Guide |
| --- | --- | --- |
| [`desktop/`](desktop/) | Electron Mac app, model setup, packaged runtime, and browser bridge | [Desktop development and builds](desktop/README.md#for-developers) |
| [`website/`](website/) | Public product website and download entry point | [Website development](website/README.md) |
| [`plaud-web/`](plaud-web/) | Shared TypeScript workspace, Node local API, Python audio worker, and device protocols | [Workspace development](plaud-web/README.md) |
| [`plaud-web/extensions/chatgpt-bridge/`](plaud-web/extensions/chatgpt-bridge/) | Optional Edge extension for ChatGPT forwarding | [Extension guide](plaud-web/extensions/chatgpt-bridge/README.md) |
| [`companion-macos/`](companion-macos/) | Earlier website-companion app and self-contained runtime packaging | [Companion development](companion-macos/README.md) |
| [`plaud-app/`](plaud-app/) | Experimental Flutter Android/iOS client with a separate AssemblyAI transcription workflow | [Mobile development](plaud-app/README.md) |
| [`docs/`](docs/) | Shared architecture, contracts, and validation reports | [Repository and cross-platform guide](docs/repository-layout.md) |

### Run the shared workspace from source

Use **Node.js 22.18–22.x** and npm, as required by the current package configuration. Device discovery and the complete local processing workflow currently target macOS; the [workspace guide](plaud-web/README.md) covers native helpers, FFmpeg, and model setup.

```sh
git clone https://github.com/audiobridge-ai/recdock.git
cd recdock
npm --prefix plaud-web ci
npm --prefix plaud-web run dev
```

Open <http://localhost:5173/> and keep the local server running. For the desktop development launcher and installation archives, follow the [desktop build guide](desktop/README.md#for-developers).

### Validate a change

Run these commands from the repository root after installing the relevant dependencies. Desktop checks also need `npm --prefix desktop ci`.

```sh
npm --prefix plaud-web test
npm --prefix plaud-web run build
npm --prefix desktop test
node scripts/i18n/check.mjs
```

Worker changes need the Python checks documented in the [workspace development notes](plaud-web/docs/development.md). Mobile changes use the separate [Flutter and cross-platform checks](plaud-app/README.md#validation). Protocol or transcript-contract changes must cover both implementations.

### Contributing and documentation

Use **English for new public documentation, code comments, and contributor-facing text**. UI changes should provide English and Chinese copy, keep English as the default, and preserve user-authored content. Follow the existing [localization module](plaud-web/src/i18n/) and run the language check above.

Keep source changes scoped, include relevant validation, and do not commit recordings, model weights, account caches, signing keys, or generated app bundles. Component READMEs describe the current workflows; dated engineering notes and historical reports may still be in Chinese.
