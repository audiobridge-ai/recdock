# Development

## Structure

| Path | Responsibility |
| --- | --- |
| `src/main.ts`, `src/style.css` | Account, device selection, connection progress and workspace UI |
| `src/ui` | Flow state, non-secret browser preferences and recording view models |
| `src/ble` | Web Bluetooth selection, GATT transport and notification inbox |
| `src/auth` | Browser API client, credentials and BLE handshakes |
| `src/app` | Connection controller, automatic protocol detection and file transfers |
| `src/protocol` | Advertisement and device packet codecs |
| `src/audio` | File decryption, Ogg packaging and WAV export |
| `server` | Local cloud proxy, session restoration, encrypted file cache and broadcast bridge |
| `server/native` | macOS Swift broadcast scanner and file-lock helper |
| `tests` | Synthetic protocol, authentication, transfer, audio, storage and UI-state tests |

## Checks

```sh
npm ci
npm test
npm run build
```

Node.js 22.18 or newer is required. The build runs the TypeScript checker and produces the Vite frontend bundle. FFmpeg enables independent Opus/WAV interoperability tests; those specific checks are skipped when FFmpeg is absent. macOS-specific storage checks are skipped on other systems.

The initial implementation has 236 passing tests on macOS with FFmpeg, including automatic first-connection preparation, cached-key reuse, cancellation, stale responses, CSRF protection, transfer recovery, original-file preservation and synthetic RSA/ChaCha20 recordings. Tests generate fixture keys at runtime and do not require a real account or recording device.

## Browser simulation

With the development server running at `http://localhost:5173`, open:

```text
http://localhost:5173/scripts/ui-verification.html
```

This development-only page replaces the API and BLE transport with a synthetic account and device before loading the UI. It exercises a first connection without a known protocol version, automatic material preparation and workspace rendering. It does not log in to PLAUD or connect to hardware. It is not a production entry point.

The simulated operations are available in `window.__uiVerification.trace`. Before closing the test page, call `await window.__uiVerification.cleanup()` to remove only the synthetic account's non-secret browser preferences. Reloading or closing the page removes its runtime overrides.

`ble-scan-diagnostic.html` is a separate real-device selection diagnostic. It asks the browser to select a device but does not automatically connect GATT.

## Hardware validation

Use the normal application and your own account. Disconnect the phone App, keep the recorder awake and nearby, and allow the necessary browser and macOS Bluetooth permissions. Check initial connection, restored login, reconnect, status updates and a short recording download. Cancellation and same-page resume should not save incomplete files.

Keep account credentials, cached keys, recordings and device logs outside the repository. The example credentials file is blank, and `.gitignore` excludes common local material and generated binaries. Do not copy application-data caches into the source tree.
