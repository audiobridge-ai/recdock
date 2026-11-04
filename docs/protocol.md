# Protocol notes

These notes describe the implementation in this repository. Device behavior was studied from PLAUD App v4.1.0 and selected hardware observations. This is an independent implementation, not an official SDK. Original application packages, decompiled sources, account credentials, and captured recordings are not included.

## Discovery and protocol selection

Device names can be changed and are not used as the device identity. Known manufacturer advertisement layouts contain a serial number and, for supported layouts, the protocol version. The parser uses the serial number prefix to recognize known product families and reads the protocol version from the appropriate advertisement offset.

Web Bluetooth manufacturer filters select candidates. If the browser provides `watchAdvertisements()`, the page can read the selected device's advertisement. Otherwise, the macOS helper reads broadcasts and returns only the serial number requested by the authenticated local session. The shared TypeScript parser determines the protocol version; it is not guessed from the model name.

The macOS helper only scans. It does not establish GATT connections, read recording files, access account keys, or write advertisement logs. Requests require a locally authenticated account, a matching bound device, a same-origin request, and CSRF protection. Cancellation, logout, and response closure stop the scan.

## Connection and authentication

The control service is `0x1910`; notifications use `0x2BB0` and writes use `0x2BB1`. The browser installs the notification listener before subscribing and serializes GATT operations.

| Protocol | Authentication material | Implementation |
| --- | --- | --- |
| Other than 20/30 | Account ID or BLE token | Legacy token handshake, including the second handshake where required |
| 20 | Account identity, device SN signature, account RSA key pair | FE10 signature, optional FE11 public-key request, FE12 session material, RSA and PLAUD.AI marker verification, ChaCha20-Poly1305 session |
| 30 | Account identity, SN, device public key, user ECC private key | Existing manual mode-2 reconnect using P-256, ECDH and HKDF |

The UI reports a usable connection only after an authenticated device-state response has been decoded. A completed browser selection or GATT connection alone is insufficient.

Login and material preparation use official PLAUD HTTPS endpoints through a loopback-only local server. Authentication material is prepared automatically when the user clicks Connect. Existing account keys and complete device material are reused before fetching or initializing keys. A cloud access token is not a BLE identity token.

Session restoration verifies the account ID against the server profile. Refresh uses `/auth/refresh-user-token` with the refresh token as Bearer and an empty body. Token pairs rotate together. A replayable user GET may be retried once after refresh; device signatures and key-generation POSTs are not blindly replayed.

## Status and recording transfers

- Command 3 provides device state; state code 4099 indicates recording.
- Commands 20–23 provide recording start, pause, resume and stop events. Command 19 includes duration and new-file events and can require an ACK.
- Directory command 26 uses a request ID and ordered pages. File IDs remain opaque identifiers for protocol and transfer operations. For display only, plausible Unix-second IDs in default recording titles are formatted in the browser’s current time zone; counters and unknown IDs retain their original labels.
- Download command 28, type-02 data frames, and command-29 file tails are matched by file session and continuous byte offset.
- Gaps and timeouts use bounded retries after stopping and acknowledging the current transfer. Download state is retained only in page memory for the same account, device and file identity.
- Recording or pause defers directory and download activity. Starting a recording during transfer pauses synchronization.
- File-tail CRC parameters have not been established for this path; the implementation does not claim to verify that CRC.

## Audio recovery

A `PLAUD.AI` file may have a 512-byte version-1 header, an RSA-wrapped content key and a separately encrypted audio payload. This layer is independent of BLE transport encryption.

The implemented path unwraps the 32-byte content key with the original account RSA private key and decrypts the payload with IETF ChaCha20 according to the header's segment size. For confirmed segmented recordings, each segment restarts at counter zero. Unsupported header variants and unknown audio layouts are preserved as the original file.

Confirmed single-channel 80-byte/20-ms Opus frames are packaged as Ogg Opus. Existing Ogg files are checked for container integrity. WAV export decodes audio locally through Web Audio and writes 16-kHz PCM16 RIFF/WAVE without playing audio. Older retained RSA versions can be tried when the current key cannot decrypt an older recording.

Unknown multistream layouts are not converted by guessing. Failed recovery keeps the original `.bin`; renaming the extension is not a conversion.

## Implementation references

- Discovery: `src/ble/discovery.ts`, `src/protocol/advertisement.ts`, `src/app/device-protocol.ts`.
- Authentication: `src/auth/handshake.ts`, `src/auth/session.ts`, `server/cloud-client.ts`.
- Status and transfers: `src/protocol/recording.ts`, `src/protocol/files.ts`, `src/app/file-transfer.ts`.
- Audio: `src/audio/plaud.ts`, `src/audio/ogg.ts`, `src/audio/recovery.ts`, `src/audio/wav.ts`.

Relevant App analysis entry points include `ds2`, `zt7`, `js2`, `GetStateRsp`, `DeviceEventPushInd`, `GetRecSessionsRsp`, `qkn`, and `j38`. They are references for the investigation, not bundled source dependencies. Audio containers follow RFC 3533, RFC 6716 and RFC 7845.
