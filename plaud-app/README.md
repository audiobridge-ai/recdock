# RecDock mobile source

An experimental Flutter Android/iOS client in the [RecDock repository](../README.md). It shares device-protocol and transcript contracts with the [TypeScript workspace](../plaud-web/README.md), but uses its own **AssemblyAI cloud transcription workflow**.

**[Visit RecDock](https://recdock-plaud-web.vercel.app/)** · [Download the Mac app](https://recdock-plaud-web.vercel.app/#download)

The Mac app is the current downloadable product. This mobile directory contains source version **0.3.0**; it is not an announced Android or iOS store release. RecDock is independent of, and not endorsed by, PLAUD.

## Implemented workflow

- Local audio import, original-file retention, SHA-256 deduplication, search, playback, renaming, and recoverable trash.
- Foreground BLE scanning, PLAUD advertisement identification, account-bound device matching, authentication, status, recording lists, streaming downloads, decryption, and playback.
- Explicit cloud transcription with the user's AssemblyAI key, speaker labels, timestamp playback, text/speaker edits, historical revisions, full export, and native sharing.
- Account-scoped storage, offline restart playback, same-run download continuation, and a persistent client-side task queue.

Saving recordings does not depend on an account. Importing audio or signing in does not automatically start transcription or upload audio. Save your own AssemblyAI key, region, and language in the transcription settings, then explicitly start transcription and confirm the upload.

Simulator acceptance uses dedicated synthetic cloud/device peers while exercising native Keychain/Keystore and playback. Live PLAUD account access and physical BLE connections have not been validated on this client. See the delivery records for [device connectivity](docs/phase-1-delivery.md), [transcription and review](docs/phase-2-delivery.md), and [background tasks](docs/phase-3-delivery.md).

## Data and platform behavior

Recordings and transcript revisions live in the app's Application Support storage. Trash can be restored; uninstalling clears local app data. Approved transcription uploads a playable audio copy to AssemblyAI and charges the project associated with the user's key. The original remains local. Keys use account-scoped system secure storage and are excluded from task indexes and exports.

File selection uses the system picker. Bluetooth access is requested when scanning; Android 11 and earlier need location permission and location services, while Android 12+ uses nearby-device permissions. The client does not request microphone or broad file-storage access.

The persistent FIFO queue uploads one recording at a time and permits at most two cloud tasks whose completion is not confirmed. Approved uploads can resume within the original data scope. A lost submission response is marked for confirmation instead of automatically repeating a billable POST.

Android uses a native foreground service with a notification for upload, submission, and polling. iOS uses system background uploads and opportunistic refresh; immediate polling and completion notifications while suspended are not guaranteed. Local notifications need system permission; the implementation does not require APNs, FCM, or a public service.

Original machine drafts and human edits remain separate versions. Text edits discard stale word-level timing. Android plays device Opus/Ogg directly; iOS creates a streaming CAF/Opus cache as needed without loading a long recording fully into memory or creating a large PCM file.

Device connectivity supports legacy protocols and protocol 20. Automatic protocol 30 authentication remains future work. A device is shown as connected only after matching the bound SN, authentication, and a successful status request. Downloads and playback are currently foreground operations; leaving the foreground pauses them. Persistent download continuation after process termination is not promised.

Previously verified sessions may read local recordings offline for up to seven days after a network failure; offline device authorization is prohibited. A 401 response, mismatched account, unverified session, or expired offline window prevents that recovery.

## For developers

All commands below run from `plaud-app/`, unless a repository-root path is shown. Keep `plaud-web/` as a sibling checkout directory for cross-platform checks.

### Requirements and builds

Use **Flutter 3.27 or later**, **Dart 3.6.2 or later within Dart 3.x**, Android SDK, and JDK 17. iOS builds require macOS, Xcode, and CocoaPods. The platform minimums are Android API 23 and iOS 14; exact build-tool versions are defined in the native project files and lockfiles.

```sh
flutter pub get
flutter analyze
flutter test
flutter run -d <device-id>
```

```sh
flutter build apk --debug
flutter build ios --simulator --debug
```

Installing on a physical iPhone requires local developer signing; production signing and a mobile release pipeline are not configured.

The iOS app integrates the Swift BLE plugin as a static framework and sets Keychain entitlements for its own bundle ID. Retain the simulator build's signing and entitlements when testing secure storage. `Podfile.lock` uses normal CocoaPods trunk dependencies rather than a temporary checkout.

### Validation

Install the workspace's npm dependencies and the app's Flutter dependencies before running cross-platform checks. Use **Node.js 22.18–22.x** for the shared TypeScript implementation.

```sh
node --experimental-strip-types tool/verify_protocol_parity.mjs
node --experimental-strip-types tool/verify_transcript_contract.mjs
dart tool/verify_storage.dart
```

`RECDOCK_DART` selects the Dart executable used by the protocol checker. These checks run the real TypeScript and Dart implementations and use temporary files for storage validation, without starting a test server.

Native integration entry points are `integration_test/phase1_test.dart`, `phase2_test.dart`, and `phase3_test.dart`. They cover device download/playback, key settings, explicit transcription, task recovery, review, and native sharing. Accounts, keys, audio, and service responses in those tests are synthetic. Production entry points do not import the test modules or expose a demo switch.

Use English for new documentation and contributor-facing text. Keep cloud-upload consent, account isolation, and unknown-submission handling intact when changing the workflow. Historical acceptance results are recorded in the dated delivery documents linked above.
