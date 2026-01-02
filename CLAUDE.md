# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**SkipREXA** is a Chrome Extension (Manifest V3) that automates uploading university exam question papers to ChatGPT. It fetches papers from a Supabase database and uses DOM manipulation to simulate file uploads and inject contextual prompts into ChatGPT's interface.

## Core Architecture

### Extension Components

1. **popup.html/popup.js**: Main UI where users search courses, select papers, and trigger uploads
2. **background.js**: Service worker that handles PDF downloads via `fetch()` to bypass CORS restrictions
3. **content.js**: Injected into ChatGPT pages to manipulate the DOM for file uploads and prompt injection
4. **supabase-client.js**: Lightweight custom Supabase REST API wrapper (no official SDK)

### Data Flow

```
User selects courses → Fetch papers from Supabase → Download PDFs via background.js
→ Convert to base64 → Pass to content.js → Simulate drag-and-drop on ChatGPT → Inject prompt
```

### File Upload Strategy

The extension uses **drag-and-drop simulation** as the primary upload method (`content.js:141-207`). It:
- Converts base64 PDFs to `File` objects
- Finds ChatGPT's drop zone using multiple selector strategies
- Dispatches realistic `DragEvent` sequences (dragenter → dragover → drop → dragleave)
- Uploads files individually with delays to prevent ChatGPT UI issues

## Development Workflow

### Loading the Extension

1. Navigate to `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select `E:\dev\examPaperExtension`

### Testing Changes

- **Popup changes**: Reload the extension in `chrome://extensions/` or close/reopen the popup
- **Content script changes**: Refresh the ChatGPT page
- **Background script changes**: Reload the extension (background service workers restart automatically)

### Debugging

- **Popup**: Right-click popup → "Inspect" → Console tab
- **Content script**: Open DevTools on ChatGPT page → Console (filter by "Question Paper Helper")
- **Background script**: `chrome://extensions/` → "Inspect views: service worker"

All console logs use emoji prefixes (🚀, ✅, ❌, 📤, etc.) for visual categorization.

## Key Implementation Details

### Supabase Integration

The custom client (`supabase-client.js`) implements:
- Basic `.from(table).select(columns).eq(column, value)` queries
- `.in(column, values)` for multi-value filters
- Pagination with `fetchAllRecords()` (1000-record batches)
- URL encoding of special characters in filter values (e.g., `#`, `&` in course codes)

Credentials are stored in `chrome.storage.sync` and initialized on first run with defaults.

### ChatGPT DOM Interaction

**Critical selectors** (`content.js:406-469`):
- Drop zones: `[data-testid="prompt-textarea"]`, `textarea[placeholder*="message"]`, `div[contenteditable="true"]`
- Prompt input: `#prompt-textarea[contenteditable="true"]` (ProseMirror editor)

**File upload verification** is disabled by default to avoid false negatives. The extension assumes success after dispatching events.

### State Management

- **Selected courses**: Stored in a `Set` in popup.js (not persisted)
- **Theme preference**: Persisted to `chrome.storage.local`
- **Fetched papers**: Cached in memory during the popup session

### Styling

All CSS is inline in `popup.html` using CSS custom properties for theming. Light/dark mode toggles via `.dark-theme` class on `<body>`.

## Common Tasks

### Adding New ChatGPT Selectors

If ChatGPT UI changes break uploads, update selectors in:
- `findDropZone()` (`content.js:406`)
- `injectPromptToChatGPT()` (`content.js:975`)
- `findAttachmentButton()` (`content.js:472`)

### Modifying Upload Logic

The main upload loop is in `uploadPDFsToChatGPT()` (`content.js:141`). Adjust delays (currently 2000ms between uploads) if ChatGPT throttles requests.

### Changing Supabase Schema

If the `question_papers` table schema changes, update query logic in `popup.js` (search for `supabase.from('question_papers')`).

## Important Constraints

- **No build system**: Pure HTML/CSS/JS (no TypeScript, no bundler)
- **No external libraries**: Custom Supabase client to minimize size
- **Service worker lifecycle**: `background.js` may suspend; avoid long-lived state
- **Content script isolation**: Cannot directly access page's JavaScript context
- **CORS**: PDFs must be fetched via background script with proper headers (`background.js:110-163`)

## Permissions Required

- `activeTab`: Inject content scripts into ChatGPT
- `storage`: Save theme preferences and credentials
- `contextMenus`: Right-click menu for quick access
- `scripting`: Dynamic content script injection
- Host permissions for ChatGPT and Supabase domains

## Known Issues

- Upload verification is unreliable (commented out in favor of blind uploads)
- Service worker may need manual reload after Chrome restart
- Multi-file batch uploads not fully supported (sequential uploads used instead)
