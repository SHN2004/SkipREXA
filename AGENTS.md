# Repository Guidelines

## Project Structure & Module Organization
- `manifest.json` defines MV3 permissions, scripts, and host matches.
- `popup.html` + `popup.js` implement the extension UI and user flow.
- `content.js` runs on ChatGPT pages to inject prompts and simulate drag-and-drop uploads.
- `background.js` is the service worker used for PDF downloads and messaging.
- `supabase-client.js` is a lightweight REST client for Supabase queries.
- `icon*.png` are extension assets; `DATABASE_INFO.md` documents schema details.

## Build, Test, and Development Commands
This project has no build step or package manager scripts. Use Chrome’s extension tooling:
- Load the extension: open `chrome://extensions/` → enable Developer Mode → “Load unpacked” → select this repo.
- Reload after changes: click the extension “Reload” button.
- Debugging:
  - Popup: right-click the popup → Inspect.
  - Content script: DevTools on ChatGPT page (filter logs by emoji prefixes).
  - Service worker: `chrome://extensions/` → “Inspect views”.

## Coding Style & Naming Conventions
- Vanilla JS/HTML/CSS; no bundler and no external libraries.
- Indentation: 2 spaces, no semicolons (match existing style).
- Use `camelCase` for variables/functions and `UPPER_SNAKE_CASE` for constants.
- Console logs use emoji prefixes (e.g., `🚀`, `✅`, `❌`) for scan-friendly debugging.
- Keep CSS inline in `popup.html` and reuse existing CSS custom properties.

## Testing Guidelines
- No automated tests are currently defined.
- Manual smoke checks:
  - Search and select courses in the popup.
  - Download/upload a paper and confirm prompt injection in ChatGPT.
  - Verify theme toggle persistence via `chrome.storage.local`.

## Commit & Pull Request Guidelines
- Commit messages are imperative and sentence-case (e.g., “Add…”, “Enhance…”).
- PRs should include:
  - A short description of user-facing changes.
  - Screenshots/GIFs for popup UI changes.
  - Notes on manual testing steps executed.

## Security & Configuration Tips
- Supabase credentials are stored in `chrome.storage.sync`; avoid hardcoding new secrets.
- Fetch PDFs via `background.js` to bypass CORS rather than direct fetches in `content.js`.
