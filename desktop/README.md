# RecDock for Mac

Import recordings, transcribe locally, listen back, review, and export from one Mac app.

**[Visit the website](https://recdock-plaud-web.vercel.app/)** · **[Download for Mac](https://recdock-plaud-web.vercel.app/#download)** · [Release notes and checksums](https://github.com/audiobridge-ai/recdock/releases/tag/desktop-v1.0.0-rc.3)

This guide covers the current **1.0.0-rc.3** release candidate. You can use local audio without a PLAUD device or a RecDock account.

## Requirements

- An **Apple Silicon Mac running macOS 26.2 or later**. Windows, Intel Mac, and older macOS versions are not validated for this package.
- About **487 MB** for the ZIP and **1.50 GB** for the extracted app. Models need another **3.78 GB**; keep at least **10 GB free**, plus room for recordings and processing.
- Internet access for initial model downloads and optional PLAUD or ChatGPT features. Prepared models support offline local processing.
- Edge and a signed-in ChatGPT tab only if you want automatic transcript forwarding.

The app includes Electron, Node, Python, FFmpeg, and its processing dependencies. Users do not need to install Homebrew or developer tools. Model files are prepared separately and reused across app upgrades.

## Install RecDock

1. Follow the [website download link](https://recdock-plaud-web.vercel.app/#download) to GitHub Releases. Choose `RecDock-1.0.0-rc.3-macos-arm64.zip`; download the matching `SHA256SUMS.txt` if you want to verify it with `shasum -a 256 -c SHA256SUMS.txt` in the download folder.
2. Quit any previous RecDock app or local companion and let its service stop. Fully extract the ZIP, then move `RecDock.app` to Applications.
3. Open the app. This candidate has a **local ad-hoc signature and no Developer ID certificate or Apple notarization**. If macOS cannot verify the developer, check the file's source and checksum and consult [Apple's opening instructions](https://support.apple.com/en-us/102445). On systems that permit it, the app-specific approval is under **System Settings → Privacy & Security → Open Anyway** after attempting to open the app.
4. Continue with **Models & App** to prepare the models, then import a short recording to try the workflow.

If macOS reports a damaged app, signature validation fails, or protection software stops a process, retain the exact message and check the download's integrity. Managed computers remain subject to their administrator's policy.

## Prepare your models

Open **Models & App** at the top of the workspace. Choose an existing RecDock model folder, or use **Download / Resume**, then **Verify all files** and **Check environment**.

The app uses pinned revisions of Qwen3 ASR 1.7B, Qwen3 ForcedAligner 0.6B, and pyannote Community 1. For the speaker model, follow **Model access and first download**, accept the upstream Hugging Face access conditions yourself, and save an authorized download token.

The download token is encrypted using macOS secure storage. Saving or reading it may require Keychain access; status checks do not read the token. Existing complete models can be selected and verified without that authorization and continue to work offline. The token is for model downloads, not transcription requests.

## Import, transcribe, review, and export

1. Set the transcription language under **Settings → Transcription settings** before starting new processing. Local imports do not require PLAUD sign-in.
2. Choose **Import → Import & transcribe**, or **Import audio only** to save a recording for later.
3. Select a completed recording. Click a timestamp to hear the original audio, edit a paragraph or speaker name, and save your changes.
4. Use **Export text** for the complete selected version. Markdown, TXT, JSON, SRT, and VTT are available; original audio can be saved separately.

Machine drafts and historical revisions are retained. Treat automatic text, speaker labels, and timing as a draft to review against the audio.

## Send a transcript to ChatGPT

Follow the [extension guide](../plaud-web/extensions/chatgpt-bridge/README.md) to load the app-provided extension in Edge. Then open ChatGPT, sign in, and choose **Settings → ChatGPT forwarding → Connect an existing ChatGPT tab** in RecDock.

**Send to ChatGPT** attaches the complete saved Markdown transcript and your prompt. It does not upload audio; filters and pagination do not shorten the document. Automatic forwarding supports up to **8 MiB** per transcript. No OpenAI API key is required for this workflow.

The extension preserves new drafts and attachments already in ChatGPT. If submission is uncertain, it checks the page rather than automatically sending again. A confirmed submission can be reopened through its original conversation. Export the Markdown file for manual upload if ChatGPT sign-in, quotas, or page changes prevent automatic forwarding.

## Interface language

English is the default. Use **中文 / English** at the top right to change it. The app remembers your choice and updates its native menus. The website and extension popup have their own remembered choices.

Changing the interface language reloads the workspace while the processing service continues. The selected recording is restored. Unsaved transcript, title, or speaker edits require confirmation; active imports, saves, device operations, and audio exports defer switching. Save any edited ChatGPT prompt first.

Interface language does not change transcription language or translate your recording content and custom names. macOS system dialogs follow the operating system's language settings.

## Data, updates, and background tasks

App data lives in `~/Library/Application Support/RecDock`. Your selected model folder remains separate from the app. Replacing the app preserves recordings, revisions, and model files; back up important recordings separately.

Closing the window keeps processing running. Quitting stops the service and preserves task records so unfinished work can resume after reopening. Run one RecDock app or companion at a time.

Use **Models & App → Open data folder** to inspect local files. Startup failures are recorded in `desktop/startup-status.json`; an environment check writes `desktop/environment-status.json`. Review diagnostic files before sharing them. Public issue reports do not need recordings, account caches, or download tokens.

If startup stays on account recovery or an empty library, try **View → Reload**. An initialization delay was observed during candidate testing; a later full app restart restored the library automatically. Report persistent failures with the app version, macOS version, and error details.

After updating the app, reload its existing RecDock extension at `edge://extensions/`. Keep one RecDock extension enabled.

## Device support and release status

PLAUD connectivity is optional and targets already-bound devices. The implementation covers account access, authentication, device status, and recording retrieval. First-time binding, recording control, device-file deletion, OTA, and Wi-Fi transfers are outside the current scope.

Local import, real model processing, review, export, and ChatGPT forwarding have been tested on the development Mac. **Clean-Mac installation and desktop PLAUD hardware regression remain unverified.** Consult the [RC3 validation report](../docs/reports/desktop-rc3-i18n-2026-11-12.md) for the exact checks and known limits.

## For developers

Run the commands below from the repository root on a Mac with Xcode Command Line Tools. Use **Node.js 22.18–22.x** and prepare a self-contained runtime through the [companion packaging guide](../companion-macos/README.md#build-a-local-runtime-package), or supply an existing verified runtime app.

### Install development dependencies

```sh
npm --prefix plaud-web ci
npm --prefix desktop ci
npm --prefix desktop test
python3 desktop/scripts/build_icons.py
```

### Develop with the fixed launcher

Reuse an existing runtime and the installed Electron SDK:

```sh
python3 desktop/scripts/prepare_dev.py --resources /path/to/RecDock.app/Contents/Resources
```

Open the generated `desktop/vendor/RecDock Dev.app`. Source edits do not require re-signing the runtime. The launcher is rebuilt only with `--refresh-launcher`; the first setup needs the Electron SDK or a verified archive supplied with `--electron-zip`.

### Build an installation archive

Build the audio tools from the pinned FFmpeg 8.0.1 source. The script verifies the source archive and records build parameters.

```sh
curl -fL https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n8.0.1.tar.gz -o /tmp/recdock-ffmpeg-n8.0.1.tar.gz
python3 desktop/scripts/build_audio_tools.py --source /tmp/recdock-ffmpeg-n8.0.1.tar.gz --output desktop/vendor/audio-tools
```

Supply the verified runtime app, the official Electron 45.3.1 ARM64 ZIP, and the shared audio tools:

```sh
python3 desktop/scripts/build_macos.py --runtime-app /path/to/verified/RecDock.app --electron-zip /path/to/electron-v45.3.1-darwin-arm64.zip --audio-tools desktop/vendor/audio-tools --output desktop/dist/rc-build --archive
python3 desktop/scripts/inspect_package.py desktop/dist/rc-build
```

Use a fresh output directory; the script refuses to overwrite a build. The Electron archive checksum is pinned in the build script. Packaging defaults to ad-hoc signing without notarization. `build-result.json` records the actual component OS minimum, package size, and archive checksum. The current public candidate is a ZIP.

RecDock's code uses the [MIT License](../LICENSE). Models, Electron/Chromium, Python packages, and FFmpeg retain their upstream licenses. The app includes notices, matching FFmpeg source, and rebuild instructions under `Contents/Resources/Licenses`; model weights are not redistributed in the repository or app archive.
