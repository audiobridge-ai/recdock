English and Simplified Chinese are now available on Android and iOS. First launch defaults to English; change **Settings → Interface language** to switch and save your preference.

- Localized the library, device/account pages, transcription settings, upload consent, task progress and recovery notices, review dialogs, and export labels.
- Native Android transcription notifications and iOS completion alerts use the selected app language. System dialogs follow the operating system language; iOS includes English and Chinese Bluetooth purpose descriptions.
- Recording titles, transcript content, custom speaker names, JSON data, and transcription-language settings are preserved.
- Automated checks cover catalog completeness, placeholder integrity, English defaults on both platforms, switching and persistence, and export integrity. Both Android APK and iOS Simulator builds must pass before publication.

**Android preview:** download the APK and verify it with `SHA256SUMS.txt`. Android 6.0 (API 23) or later is required. This is an experimental release-mode build using a **debug signing certificate**, not a production-signed or Play Store release. Signature compatibility with previous test installations is not guaranteed. Export important data before replacing an installation; uninstalling removes local app data. Android may ask you to allow installation from your browser or file manager.

**iOS:** this release contains source code, not an installable IPA. An unsigned Simulator build verifies compilation and bundled language resources. Installing on a physical iPhone requires your own authorized Apple signing/provisioning or a future TestFlight/App Store distribution.

The mobile client uses your own **AssemblyAI cloud transcription** key. It does not include the Mac app's local Qwen/pyannote workflow. Uploads require explicit confirmation and may incur AssemblyAI charges. Live PLAUD account/BLE hardware regression and a physical-iPhone acceptance pass are still outstanding. See the [mobile guide](https://github.com/audiobridge-ai/recdock/tree/main/plaud-app).

This preview does not replace or modify the existing Mac release.
