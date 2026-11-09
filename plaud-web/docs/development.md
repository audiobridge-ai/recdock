# Development

## Structure

User-triggered local audio import/processing, persistent background transcription, speaker labels, paragraph timestamps, revision editing and full-file exports are now integrated into the workspace. Run `npm run dev` and open <http://localhost:5173/#library>. Importing personal recordings does not require a PLAUD login or Bluetooth connection. Choose **导入并转写** or **仅导入音频**; device recordings similarly offer **下载并转写** or **仅下载 Ogg**. Connection, discovery and plain saving do not start model tasks. Processing uses local models, without an OpenAI API key.

See [按需下载与转写验收说明](reports/user-triggered-workspace-2026-11-04.md) for the current workflow and [上一轮工作台交付说明](reports/audio-workspace-2026-11-04.md) for the earlier sample preparation. [当前验收结论](reports/feature-readiness-2026-11-07.md) records the user's acceptance of the complete hardware workflow and current transcription quality, and authorization to proceed with Android/iOS development. Quantitative accuracy scoring remains a future improvement and does not block App development. [实施方案](audio-intelligence-plan.md) records remaining work, [本机基准运行说明](audio-benchmark.md) covers Python/model preparation, and [数据与 Worker 协议](audio-contracts.md) defines the shared contracts. Automated transcripts and timestamps retain candidate labels and review tools. Automatic Edge-extension delivery is implemented and has prior real-browser acceptance; see [交付记录](chatgpt-forward-delivery.md).

| Path | Responsibility |
| --- | --- |
| `src/main.ts`, `src/style.css` | Account, device selection, connection progress and workspace UI |
| `src/ui` | Flow state, non-secret browser preferences and recording view models |
| `src/ble` | Web Bluetooth selection, GATT transport and notification inbox |
| `src/auth` | Browser API client, credentials and BLE handshakes |
| `src/app` | Connection controller, automatic protocol detection and file transfers |
| `src/protocol` | Advertisement and device packet codecs |
| `src/audio` | File decryption, Ogg packaging and WAV export |
| `src/library` | Independent recording library, job progress, paged transcript review and version-bound exports |
| `server` | Local cloud proxy, session restoration, encrypted file cache and broadcast bridge |
| `server/library`, `server/application.ts` | Scope isolation, streamed imports, media Range requests, persistent single-worker queue and revisions |
| `worker/recdock_audio/runtime.py` | Offline Python worker, stage caches, model verification and canonical transcript publication |
| `server/native` | macOS Swift broadcast scanner and file-lock helper |
| `tests` | Synthetic protocol, authentication, transfer, audio, storage and UI-state tests |

## Checks

```sh
npm ci
npm test
npm run build
```

Node.js 22.18 or newer is required. The build runs the TypeScript checker and produces the Vite frontend bundle. FFmpeg enables independent Opus/WAV interoperability tests; those specific checks are skipped when FFmpeg is absent. macOS-specific storage checks are skipped on other systems.

The test suite covers automatic first-connection preparation, cached-key reuse, stale responses, CSRF protection, transfer recovery, original-file preservation and synthetic RSA/ChaCha20 recordings. Library tests add imports, account isolation, persistent revisions, complete exports, worker restart/cancellation and in-memory DOM interactions. Tests generate fixture keys and synthetic audio at runtime and do not require a real account, recording device or model inference. Current counts are recorded in the delivery report.

Python checks run separately:

```sh
PYTHONPATH=worker worker/.venv/bin/python -m unittest discover -s worker/tests -v
```

The local service must remain running for background processing. Restarting it resumes unfinished personal jobs; account jobs wait for that account's valid session. The default library is `<project>/.local-audio/library/`, separate from browser storage and credentials. The first start copies and SHA-256-verifies `~/Library/Application Support/PLAUD BLE Workspace/library-v1/scopes/` into the project library when the destination is empty. It refuses migration while the legacy service is running, rejects symbolic links and leaves the old library intact. Explicit storage overrides are not migrated automatically. Each recording keeps its originals, playable Ogg, model artifacts, task states, transcript revisions and readable exports together. `exports/latest.md`, `latest.txt`, `latest.json` follow the current saved revision; `exports/<revisionId>/` retains version copies. `RECDOCK_LIBRARY_DIR`, `RECDOCK_AUDIO_PYTHON` and `RECDOCK_AUDIO_MODELS` override the library, Python executable and model directory. Run one service instance per library. Do not run dev and preview against the same library simultaneously. Vite denies serving private audio/model directories and does not watch the Python environment or model cache.

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

## Explicit processing contract

`POST /api/library/imports/:id/commit` accepts `{ "transcribe": true | false }`. Missing means **save only**. A playable recording is queued only for `true`; raw/unrecoverable files never enter ASR. `POST /api/library/recordings/:id/jobs` explicitly starts or retries local processing. Language is selected by the user for device and local imports. A repeated device action reuses a stored recording with the same device/session and source size instead of downloading again.

`PATCH /api/library/recordings/:id` accepts a `title` without moving the stable recording directory. Rows expose `storagePath`; environment information exposes `storageRoot`. `GET .../audio?download=1` serves the playable asset as an attachment. Version-bound transcript exports remain independent of list/text filters.

The managed worker preserves raw diarization artifacts. Canonical publication clips at most 40 ms of model endpoint overshoot to the decoded source bounds, flags affected paragraphs for speaker review, and still rejects larger violations. A real 8-second Ogg regression first exposed a 13 ms overrun; the fixed pipeline completed all model stages on this Mac.

API regression tests use real request/response streams in memory, including binary Range responses, avoiding OS listening-port permissions. The development server and browser acceptance separately exercise the actual HTTP listener.
