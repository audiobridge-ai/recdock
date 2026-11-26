# RecDock → ChatGPT

An optional Edge / Chromium Manifest V3 extension that sends the **complete saved version** of a RecDock transcript to ChatGPT as a Markdown attachment. It sends your prompt and transcript, without audio, and uses the visible ChatGPT page rather than private ChatGPT APIs. It does not read cookies or account tokens.

**[Visit RecDock](https://recdock-plaud-web.vercel.app/)** · [Download the Mac app](https://recdock-plaud-web.vercel.app/#download) · [Mac app guide](../../../desktop/README.md)

## Set up the Mac app

1. Open RecDock and choose **Models & App → Open extension folder**. Use the directory provided by the app so it matches your installed version.
2. Open `edge://extensions/` in Edge, turn on **Developer mode**, choose **Load unpacked**, and select that directory. Allow its native messaging permission when requested.
3. Open <https://chatgpt.com/>, sign in to your intended account, and leave a tab in chat mode.
4. In RecDock, choose **Settings → ChatGPT forwarding → Connect an existing ChatGPT tab**. You can also connect from the extension's toolbar popup.
5. Open a completed recording, save or cancel pending edits, and click **Send to ChatGPT**.

Keep one RecDock extension enabled. After updating the app, click **Reload** on the existing extension in Edge. If you use the source workspace, refresh that page too.

English is the default popup language; **中文 / English** switches and remembers the choice. Open the popup through Edge's toolbar.

## What gets sent

The attachment contains the complete saved transcript version, including paragraphs hidden by search, filters, or pagination. The extension reuses one connected tab and starts a new conversation there for each new submission. It does not create ChatGPT tabs.

A confirmed submission can be reopened in its existing conversation. If the connected tab closes, open ChatGPT and reconnect. Reconnect after changing ChatGPT accounts as well; the tab connection does not authenticate the account's identity for you.

Automatic forwarding is limited to **8 MiB of UTF-8 Markdown**. Larger transcripts are rejected without truncation; export them for manual upload. ChatGPT's own quotas, file limits, and feature availability also apply.

## Submission status and recovery

- Submission begins only after the attachment is ready and the send button is available. Each task attempts the send action once.
- Confirmation requires a visible user message with the complete prompt, an attachment card in that same message, and a `/c/...` conversation URL. This confirms submission to that conversation, not cross-conversation retrieval or memory storage.
- A new draft, existing attachment, active reply, login requirement, quota issue, or unexpected page structure pauses automation and preserves user content.
- A paused task that has not attempted submission can be retried explicitly after resolving the page state. A task with an uncertain submission only reconciles the page; it does not automatically upload or send again.
- Workspace records and extension receipts can restore status after a refresh. An unknown submission is not automatically resumed after a process or extension restart.

When ChatGPT restores text that exactly matches a previously confirmed submission for the current connection, with no new attachment, the extension clears that leftover text through native editor events. New or changed drafts, attachments, and unconfirmed submissions are preserved. An existing file elsewhere in ChatGPT does not trigger deduplication.

Attachment matching accepts ChatGPT's numeric duplicate-name suffixes while still checking the version and content hash embedded in the original filename. An exact ready attachment may be reused for an explicit retry. Preparation, attachment readiness, and submission confirmation have separate time limits of approximately 30, 90, and 60 seconds.

## For developers

### Source workspace setup

Run RecDock's local workspace at **http://localhost:5173/**, load this directory as an unpacked extension, and refresh the workspace. Then follow the same tab connection steps above. Other ports and hosted websites are not accepted by the workspace content script.

The Mac app uses **Native Messaging** instead of the localhost content script. Its packaged bridge connects the app to the same extension without granting the public marketing website access to your desktop library.

### Permissions and stored data

The manifest requests `storage`, `scripting`, and `nativeMessaging`, with host access to `http://localhost/*` and `https://chatgpt.com/*`. The content script and background handler further restrict browser workspace requests to the top-level `http://localhost:5173` page. The native host restricts access to the configured RecDock extension ID; see [native host registration](../../../desktop/src/native-registration.cjs).

The local service saves transcript snapshots, hashes, versions, and receipts in the recording's `chatgpt/transfers.json`, preserving the personal/PLAUD account scope. The extension stores task metadata and prompts persistently; temporary transcript packets use `storage.session` and are removed after completion or stopping. The extension receives explicitly provided transcript packets and cannot read arbitrary local paths.

### Page adaptation and validation

ChatGPT page adaptation is concentrated in `page-adapter.mjs`. After source edits, reload the extension and refresh the source workspace. Changes to the page should pause the workflow until the adapter is updated; do not fall back to private upload APIs.

ChatGPT navigation can retain hidden editors and message copies. Select the file input belonging to the visible editor form and require Markdown support. Image-only inputs and hidden message copies cannot establish an upload or submission receipt.

Run the extension and forwarding checks from `plaud-web/` after installing its dependencies:

```sh
node --experimental-strip-types --test tests/chatgpt-extension.test.ts tests/chatgpt-forward.test.ts tests/chatgpt-forwarder.test.ts tests/i18n.test.ts
```
