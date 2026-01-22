# Gemini Implementation Tracker

This file tracks what was researched, tried, changed, and learned while adding Gemini (`https://gemini.google.com/app`) support to SkipREXA.

## Goal

Extend the extension to support Gemini file uploads (and prompt injection), in addition to existing ChatGPT support.

## Baseline (existing behavior)

- Extension originally supported only ChatGPT (`chatgpt.com`, `chat.openai.com`)
- Upload strategy for ChatGPT lives in `content.js`:
  - Converts base64 PDFs to `File`
  - Uses drop-zone detection + synthetic drag events (`DragEvent`/`DataTransfer`)
- Prompt injection for ChatGPT uses:
  - `#prompt-textarea[contenteditable="true"]` (ProseMirror) or textarea fallbacks

## Research & Discovery (Gemini UI + upload constraints)

### Agent-browser setup

- `agent-browser` initially failed (`Daemon failed to start`) in sandbox mode
- Installed Chromium for agent-browser (required escalated permissions due to network + writing outside repo)
- Running with escalated permissions allowed `agent-browser` to operate

### Gemini signed-out behavior

- When signed out (incognito), Gemini shows “Sign in to upload files”
- Upload button exists: `button[aria-label="Open upload file menu"]`
- Upload is gated; the actual upload controls aren’t reliably present until signed in

### Gemini signed-in behavior (via CDP)

Connected to your real Chromium instance with remote debugging:

- Started Chromium with:
  - `--remote-debugging-port=9222`
  - `--user-data-dir=/tmp/skiprexa-cdp`
  - `--load-extension=/Users/shn/dev/SkipREXA`
- Connected with:
  - `agent-browser connect 9222`

Key interactive elements from Gemini snapshot:

- Prompt editor:
  - `.ql-editor[contenteditable="true"][role="textbox"]`
  - `aria-label="Enter a prompt here"`
  - `data-placeholder="Ask Gemini 3"`
- Upload menu button:
  - `button[aria-label="Open upload file menu"]` / `button[aria-label="Close upload file menu"]`
- Upload menu items (after opening menu):
  - `button[aria-label^="Upload files"]` (“Upload files. Documents, data, code files”)
  - “Add from Drive”, “Photos”, “Import code”, “NotebookLM”
- Hidden file input created after selecting “Upload files”:
  - `input[type="file"][name="Filedata"]`
  - `multiple` enabled
  - `display: none` / `aria-hidden="true"`
  - Sits under Angular overlay elements (`cdk-overlay-*`)

### What didn’t work (Gemini)

1) Synthetic drag-and-drop upload
- Tried dispatching `DragEvent`/`DataTransfer` onto:
  - the prompt editor (`.ql-editor…`)
  - the upload overlay component (`images-files-uploader`)
- Gemini ignored synthetic drag/drop; no UI attachment and no upload network activity observed

2) Programmatic `input.files = …` + dispatch `change`
- Found the hidden file input, assigned a `FileList`, dispatched `change/input`
- Gemini UI did not show attachments, and no upload requests were triggered
- Conclusion: Gemini likely requires trusted input/user gesture for file selection

3) Plain JS `element.click()` to open menu / choose “Upload files”
- Gemini sometimes ignores non-trusted JS clicks for the upload flow
- This produced an `unknown error` when trying to “prepare” the file input in the extension

## Design Decision (Gemini upload approach)

Because Gemini ignores synthetic drag/drop and untrusted DOM file assignment:

- Use Chrome MV3 `chrome.debugger` (CDP) to set files via:
  - `DOM.setFileInputFiles`
- To satisfy trusted-user-gesture constraints:
  - Use CDP `Input.dispatchMouseEvent` to click the upload menu button and “Upload files” menu item
  - Temporarily block the native file picker to avoid UI modal freezes during automation

Gemini upload requires local disk file paths for `DOM.setFileInputFiles`:

- Save downloaded base64 PDFs to disk first (via `chrome.downloads`)
- Then pass file paths to background service worker to attach them through CDP

## Implementation Changes

### `manifest.json`

- Added Gemini host permission:
  - `https://gemini.google.com/*`
- Added Gemini content script match:
  - `https://gemini.google.com/*`
- Added permissions needed for Gemini flow:
  - `downloads` (save PDFs to disk)
  - `debugger` (CDP attach + `DOM.setFileInputFiles`)

### `background.js`

- Expanded supported platform detection to include Gemini:
  - content script injection on `gemini.google.com`
- Context menu document patterns include Gemini
- Added message handler:
  - `action: 'geminiAttachFiles'`
- Implemented `geminiAttachFiles(tabId, filePaths)`:
  - Attaches debugger to tab
  - Enables `DOM`, `Runtime`, `Page`
  - Opens upload menu + clicks “Upload files” using CDP mouse events
  - Creates/locates `input[type=file][name=Filedata]`
  - Calls `DOM.setFileInputFiles`
  - Dispatches `change/input` for Gemini to read the file selection
- Improved error propagation:
  - returns `{ success: false, error, stack }` so popup shows real failure reasons

### `popup.js`

- Added platform routing:
  - `getActivePlatformFromUrl(url)` returns `chatgpt` / `gemini`
  - Popup error now says “Please open ChatGPT or Gemini first”
- Gemini upload pipeline:
  - Save PDFs to `Downloads/SkipREXA/GeminiUploads/<filename>`
  - Send file paths to background via `geminiAttachFiles`
- Download robustness updates (to prevent “stuck on preparing”):
  - `sanitizeDownloadFilename()` replaces `/` and other reserved characters, trims length
  - Added `waitForDownloadComplete()` polling fallback (events can be missed)
  - Added “Download start timeout” guard
  - Avoided revoking blob URL too early (revokes after download completes)
  - Chunked base64 decode + yielding to keep popup responsive
- Added logging:
  - `📥 Saving for Gemini:` and error logging of Gemini attach responses

### `content.js`

- Added host detection (`getActivePlatform()`)
- If on Gemini, prompt injection uses:
  - `.ql-editor[contenteditable="true"][role="textbox"]`
  - focuses editor, inserts text, dispatches `InputEvent('input')`
- ChatGPT behavior unchanged

## Manual Testing Notes

### User-observed UI behavior

- Clicking “Upload files” in Gemini can open macOS file picker modal
- Modal blocks the page (and CDP automation) until canceled
- Gemini attachments are visible as chips/cards, but filenames are not always easily discoverable via simple DOM text queries

### Known failure modes encountered

- `Could not prepare Gemini file input: unknown error`
  - Caused by non-trusted JS click approach; fixed by using CDP mouse events
- “Preparing for Gemini…” stuck at 0%
  - Caused by invalid filename chars (`/`) and/or premature blob URL revocation and/or missing download events
  - Addressed with filename sanitization + polling + delayed revocation + start timeout

## Open Items / Next Checks

- Verify end-to-end on Gemini:
  - After saving to disk, `chrome.debugger` should attach and `DOM.setFileInputFiles` should result in an attachment chip in Gemini UI
- Add a user-facing warning:
  - Chrome will show an infobar like “Chrome is being controlled by automated test software” or debugger attachment warnings (expected with `debugger`)
- Consider explicit status UX:
  - “Saving PDF locally for Gemini…” vs “Attaching file in Gemini…”

## Latest Changes (CDP robustness)

- Added frame-aware DOM lookup for Gemini elements (menu button, upload item, file input)
- Added retries/timeouts for menu open + file input creation
- Switched event dispatch to `Runtime.callFunctionOn` for the resolved file input node
- Improved CDP click with `buttons` + `pointerType` and added `Page.bringToFront`
- Hardened file picker blocking by overriding `showPicker` and restoring overrides in `finally`

## Summary of Gemini Constraints (important)

- Synthetic drag-and-drop does not work for Gemini uploads
- Programmatic `input.files` assignment is ignored
- A CDP-based file attach (`DOM.setFileInputFiles`) is required
- Trusted click events via CDP are needed to reliably create/access the hidden file input without user interaction
