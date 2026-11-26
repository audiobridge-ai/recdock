# Repository and cross-platform development

For product information and downloads, start with the [RecDock website](https://recdock-plaud-web.vercel.app/). The [Mac user guide](../desktop/README.md) covers the downloadable app. This document is for contributors working across repository components.

## Components and command scope

```text
recdock/
├── README.md                  # Product overview and user entry point
├── LICENSE
├── desktop/                   # Mac app, model setup, native bridge, packaging
├── website/                   # Public product website and download links
├── companion-macos/           # Earlier web companion and runtime packaging
├── docs/                      # Shared architecture and validation reports
├── plaud-web/
│   ├── src/                   # Workspace UI and TypeScript device protocols
│   ├── server/                # Local account, recording, and transcript APIs
│   ├── contracts/             # Audio schemas and synthetic contract fixtures
│   ├── worker/                # Python local audio processing
│   ├── extensions/            # Optional ChatGPT browser extension
│   └── docs/                  # Workspace engineering notes and reports
└── plaud-app/
    ├── lib/                   # Flutter UI, domain logic, and Dart protocols
    ├── android/               # Android native project
    ├── ios/                   # iOS native project
    ├── test/                  # Flutter tests and synthetic fixtures
    ├── integration_test/      # Native integration acceptance entry points
    ├── tool/                  # Protocol, transcript, and storage checks
    └── docs/                  # Mobile designs and delivery reports
```

The Mac app uses the shared workspace and local Python processing. The experimental Flutter client has a separate AssemblyAI cloud transcription workflow. The website is a static product entry point and does not process recordings.

The root is not an npm or Flutter workspace. Keep each component's lockfile and build commands in its own scope. The root README uses `npm --prefix` to make those scopes explicit. Python worker commands run from `plaud-web/` as documented in its development guide; Flutter, Dart, and mobile verification commands run from `plaud-app/`.

## Documentation and interface language

Use **English as the primary language** for new public documentation, code comments, and contributor-facing text. The root README introduces the website and the ordinary user's workflow before development. Component READMEs should clearly state who they are for and link users back to the website and Mac guide.

The desktop workspace, website, ChatGPT extension, and Android/iOS mobile interface support English and Chinese, with English as the default. Mobile preferences are stored per installation; native transcription notifications use the same preference. System dialogs follow the operating system language. UI changes need both translations and must preserve recording titles, transcript content, custom speaker names, and user-written prompts. Interface language and transcription language are separate preferences.

Dated design notes and acceptance reports retain their original language and historical context. Link to them for evidence, while keeping current installation and development instructions in the maintained guides.

## Shared protocols and contracts

- [Device protocol notes](../plaud-web/docs/protocol.md): reference for TypeScript/Dart protocol implementations.
- [Audio and transcript contracts](../plaud-web/docs/audio-contracts.md): recording objects, timestamps, revisions, and export semantics.
- [Audio JSON Schema](../plaud-web/contracts/audio-v1.schema.json) and [synthetic fixtures](../plaud-web/contracts/fixtures/): inputs read by the current Node/Python validators.
- [Mobile protocol parity checker](../plaud-app/tool/verify_protocol_parity.mjs): executes both implementations against the same packets.
- [Mobile transcript contract checker](../plaud-app/tool/verify_transcript_contract.mjs): validates mobile-generated objects with the shared schema.

Keep these assets at their existing paths unless a coordinated migration updates every consumer. Changes to protocol fields or timestamp semantics must update the relevant implementations and fixtures together and run cross-platform checks. UI and native platform implementations remain independently maintained.

## Local data and checkout changes

The source workspace's default recording library is `plaud-web/.local-audio/library/`; `RECDOCK_LIBRARY_DIR` may select an external directory. Models, recordings, and other local data are ignored by Git. The packaged Mac app uses `~/Library/Application Support/RecDock` and its selected external model folder. Mobile recordings live in each app's sandbox.

The earlier monorepo migration moved the original web repository into `plaud-web/` and added `plaud-app/`, preserving the web Git history. Historical reports may refer to the root layout that existed when they were written. The [migration record](reports/monorepo-2026-11-09.md) explains that transition.

After a fresh checkout, install each component's dependencies. After moving a Flutter checkout, run `flutter pub get` again to refresh generated absolute paths. Use `plaud-app/ios/Runner.xcworkspace` for the iOS project.

Do not commit Pods, SDK paths, signing keys, account caches, recordings, model weights, or generated installation bundles. Synthetic fixtures are for offline validation and do not contain production accounts or real user recordings.

## Validation

From the repository root, after installing the relevant npm dependencies:

```sh
npm --prefix plaud-web test
npm --prefix plaud-web run build
npm --prefix desktop test
node scripts/i18n/check.mjs
```

Worker changes also require the Python checks in the [workspace development guide](../plaud-web/docs/development.md). Native bridge changes need the corresponding platform build and integration checks.

For mobile work, run from `plaud-app/` after installing Flutter dependencies and the sibling workspace's npm dependencies:

```sh
flutter analyze
flutter test
node --experimental-strip-types tool/verify_protocol_parity.mjs
node --experimental-strip-types tool/verify_transcript_contract.mjs
dart tool/verify_storage.dart
```

Use Node.js 22.18–22.x for the shared workspace. `RECDOCK_DART` selects the Dart executable for Node-based parity checks. Protocol and transcript-contract changes must validate both implementations; storage changes need the real-file storage checker.

## Releases

Components can be built and released separately. The desktop release uses the `desktop-v` tag prefix; `web-v` can identify separate workspace releases. Mobile previews use the `mobile-v` prefix and the [mobile workflow](../.github/workflows/mobile.yml). The workflow validates both native builds and publishes a test-signed Android APK, provenance, and checksums for mobile tags. iOS Simulator compilation does not produce an installable IPA; distribution signing is not configured.

Before linking a new app download from the website, verify the installation asset, checksum, component OS minimum, source commit, third-party notices, and reported validation scope. Keep published candidate and notarization status explicit. See the [desktop build guide](../desktop/README.md#for-developers) and [website guide](../website/README.md).
