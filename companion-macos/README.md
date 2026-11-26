# RecDock Mac local companion

This directory retains the earlier **website + local companion** architecture and the self-contained runtime packaging used by desktop development.

**[Visit the RecDock website](https://recdock-plaud-web.vercel.app/)** · **[Download the current Mac app](https://recdock-plaud-web.vercel.app/#download)** · [Mac user guide](../desktop/README.md)

The current user path is the standalone Mac app. The companion is a separate development component; do not run it alongside the desktop app against the same recording library.

## Architecture

- An AppKit menu-bar app manages a per-user Node service. Closing its window or the website keeps tasks running; explicitly quitting stops the service.
- Node, Python, production dependencies, FFmpeg/FFprobe, and native helpers are bundled. The target computer does not need Homebrew, Xcode, or a source checkout.
- Recordings, models, settings, and authorization live in Application Support, outside the app bundle. Existing source-workspace data is retained at its original location.
- Approved HTTPS workspace origins request authorization with PKCE and a local user confirmation. Only authorization-token digests are persisted; access can be inspected and revoked. One-time pairing codes remain a fallback.
- Login-at-start uses SMAppService and is selected by the user.
- Models use pinned revisions and integrity checks. The companion links to upstream access conditions for users to accept themselves.

Validation distinguishes automated checks, real GPU inference, browser-to-companion authorization, clean-Mac installation, and public distribution. Report unverified areas explicitly.

## Build a local runtime package

Use an Apple Silicon Mac with Xcode Command Line Tools, the shared workspace dependencies, a standalone Python 3.11 installation, the model-processing dependencies, and audio tools already prepared. See the [workspace development notes](../plaud-web/docs/development.md) for the audio environment.

From the repository root:

```sh
python3 companion-macos/scripts/build.py --output companion-macos/dist/local-test
```

The script creates a self-contained `RecDock.app` and ZIP. Models are not included; users can select an existing model folder or download them through the companion. Bundled native libraries determine the actual macOS minimum, which is recorded in `build-result.json`. The existing runtime baseline requires macOS 26.2.

Use a new output directory for each build. Local ad-hoc helper packages are development artifacts. Developer ID signing and notarization can be requested with `--identity 'Developer ID Application: …' --notary-profile <profile-name>` when the required developer credentials exist. Distribution still requires matching third-party source and notices, compatibility checks, and clean-Mac validation. The current public desktop candidate's status is documented separately in the [Mac guide](../desktop/README.md).

## Data and removal

The companion stores recordings, authorization, and settings under `~/Library/Application Support/RecDock`. App replacement or removal does not automatically delete that directory. Disable login-at-start and quit the companion before removing the app; retain or manage the data directory separately.
