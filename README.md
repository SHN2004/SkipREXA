# SkipREXA (Exam Paper Assistant)

**SkipREXA** is a Chrome Extension designed to streamline the process of uploading exam question papers to ChatGPT and Claude for study and analysis. It acts as a bridge between a GitHub-hosted JSON index of university question papers and the LLM's file upload interface.

## Core Features

*   **Course Search:** Instantly search for courses by name or code.
*   **Paper Selection:** Filter and select specific question papers (by exam type, semester, year).
*   **Automated Upload:** Downloads selected PDFs and automatically uploads them to the active ChatGPT or Claude conversation.
*   **Contextual Prompts:** Injects tailored prompts (e.g., "Prepare me for Internal 1") to guide the AI's analysis on either platform.
*   **Multi-LLM Support:** Works with both [ChatGPT](https://chatgpt.com) and [Claude](https://claude.ai).
*   **Local Download:** Option to save papers directly to your device.

## Setup

### Prerequisites

*   [Node.js](https://nodejs.org/) and `npm`
*   Google Chrome

### Build the extension

```bash
git clone https://github.com/SHN2004/SkipREXA.git
cd SkipREXA
npm install
npm run build
```

This creates the production extension build in the `dist/` folder.

### Load the extension in Chrome

1.  Open Chrome and navigate to `chrome://extensions/`.
2.  Enable **Developer mode** (top right).
3.  Click **Load unpacked**.
4.  Select the generated `dist/` folder from this project.

If you rebuild the project later, run:

```bash
npm run build
```

Then go back to `chrome://extensions/` and click **Reload** on the SkipREXA extension card.

### Create a release package

To generate a zip package for distribution or Chrome Web Store upload:

```bash
npm run package
```

This creates a versioned zip file inside the `releases/` folder.

## Data Source & Configuration

This project reads from a JSON index committed to this repository and intended to be refreshed by the scraper workflow.

For scraper setup and usage, see **[`scraper/README.md`](./scraper/README.md)**.

*   **Zero Config:** The extension fetches the latest JSON index directly from GitHub.
*   **Scraper Project:** The scraping and GitHub Actions workflow live in **[`scraper/`](./scraper/README.md)**.
*   **Data File:** The generated paper index is stored in **[`data/question-papers.json`](./data/question-papers.json)**.
*   **Source Priority:** The extension uses `github-first` by default so scheduled scraper updates are picked up without rebuilding the extension. For unpacked local Chromium testing, build with `VITE_DATA_SOURCE_STRATEGY=local-first` to prefer the bundled local JSON first.

## Usage

1.  Open either [ChatGPT](https://chatgpt.com) or [Claude](https://claude.ai).
2.  Click the SkipREXA extension icon.
3.  Search for a course and select the papers you need.
4.  Click **Upload** to send them to the active ChatGPT or Claude conversation with a context prompt.
