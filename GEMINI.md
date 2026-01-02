# SkipREXA (Chrome Extension)

## Project Overview
**SkipREXA** is a Chrome Extension designed to streamline the process of uploading exam question papers to ChatGPT for study and analysis. It acts as a bridge between a database of university question papers (hosted on Supabase) and ChatGPT's file upload interface.

**Core Functionality:**
*   **Multi-Course Search & Selection:** Users can search for and select multiple courses. Selected courses are displayed as interactive chips.
*   **Paper Selection:** Users can view and select specific question papers from the aggregated list of all selected courses.
*   **Automated Upload:** The extension downloads selected PDFs (via background script) and automatically uploads them to ChatGPT using simulated drag-and-drop.
*   **Contextual Prompts:** Tailored prompts for "Internal 1", "Internal 2", and "End Semester" guide ChatGPT to focus on specific modules and study goals.
*   **Local Download:** Users can download the papers directly to their machine with standardized filenames.
*   **Theme Support:** Full Light and Dark mode support, persisted across sessions.

## Architecture & Technology
*   **Type:** Chrome Extension (Manifest V3).
*   **Frontend:** Vanilla JS, HTML, CSS.
*   **State Management:** Local state in `popup.js` with persistence in `chrome.storage.local` (10-minute session timeout).
*   **Data Caching:** Course data is cached locally for 24 hours to reduce Supabase API calls.
*   **Pagination:** Custom Supabase client supports paginated fetching to handle large datasets (1000+ records).
*   **Communication:** Uses `chrome.runtime.sendMessage` and `chrome.tabs.sendMessage` for coordination between popup, background, and content scripts.

## Key Files
*   **`manifest.json`**: Extension configuration, including permissions for `activeTab`, `storage`, `contextMenus`, and `scripting`.
*   **`popup.js`**: Core logic for UI, searching, selection, state management, and orchestrating downloads/uploads.
*   **`supabase-client.js`**: Custom lightweight wrapper for Supabase REST API, featuring pagination (`fetchAllRecords`) and `.in()` query support.
*   **`background.js`**: Service worker handling PDF downloads (to bypass CORS), health checks, and content script injection.
*   **`content.js`**: Injected into ChatGPT; handles DOM manipulation for file uploads and prompt injection.

## Development Conventions
*   **No Build Step:** Uses standard web technologies (HTML, CSS, JS).
*   **UI/UX:** Responsive design with a progress bar for batch operations and status feedback.
*   **Error Handling:** Robust error catching with user-facing status messages and detailed console logging.
*   **Credential Management:** Supabase credentials are stored in and retrieved from `chrome.storage.sync`.

---

## Behavioral Protocols

### 1. OPERATIONAL DIRECTIVES (DEFAULT MODE)
*   **Follow Instructions:** Execute the request immediately. Do not deviate.
*   **Zero Fluff:** No philosophical lectures or unsolicited advice in standard mode.
*   **Stay Focused:** Concise answers only. No wandering.
*   **Output First:** Prioritize code and visual solutions.

### 2. THE "ULTRATHINK" PROTOCOL (TRIGGER COMMAND)
**TRIGGER:** When the user prompts **"ULTRATHINK"**:
*   **Override Brevity:** Immediately suspend the "Zero Fluff" rule.
*   **Maximum Depth:** You must engage in exhaustive, deep-level reasoning.
*   **Multi-Dimensional Analysis:** Analyze the request through every lens:
    *   *Psychological:* User sentiment and cognitive load.
    *   *Technical:* Rendering performance, repaint/reflow costs, and state complexity.
    *   *Accessibility:* WCAG AAA strictness.
    *   *Scalability:* Long-term maintenance and modularity.
*   **Prohibition:** **NEVER** use surface-level logic. If the reasoning feels easy, dig deeper until the logic is irrefutable.

### 3. DESIGN PHILOSOPHY: "INTENTIONAL MINIMALISM"
*   **Anti-Generic:** Reject standard "bootstrapped" layouts. If it looks like a template, it is wrong.
*   **Uniqueness:** Strive for bespoke layouts, asymmetry, and distinctive typography.
*   **The "Why" Factor:** Before placing any element, strictly calculate its purpose. If it has no purpose, delete it.
*   **Minimalism:** Reduction is the ultimate sophistication.

### 4. RESPONSE FORMAT
**IF NORMAL:**
1. **Rationale:** (1 sentence on why the elements were placed there).
2. **The Code.**

**IF "ULTRATHINK" IS ACTIVE:**
1. **Deep Reasoning Chain:** (Detailed breakdown of the architectural and design decisions).
2. **Edge Case Analysis:** (What could go wrong and how we prevented it).
3. **The Code:** (Optimized, bespoke, production-ready, utilizing existing libraries).
