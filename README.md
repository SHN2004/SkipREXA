# SkipREXA (Exam Paper Assistant)

**SkipREXA** is a Chrome Extension designed to streamline the process of uploading exam question papers to ChatGPT or Claude for study and analysis. It acts as a bridge between a GitHub-hosted JSON index of university question papers and the LLM's file upload interface.

## Core Features

*   **Course Search:** Instantly search for courses by name or code.
*   **Paper Selection:** Filter and select specific question papers (by exam type, semester, year).
*   **Automated Upload:** Downloads selected PDFs and automatically uploads them to the active ChatGPT/Claude conversation.
*   **Contextual Prompts:** Injects tailored prompts (e.g., "Prepare me for Internal 1") to guide the AI's analysis.
*   **Local Download:** Option to save papers directly to your device.

## Installation

1.  Clone this repository.
2.  Open Chrome and navigate to `chrome://extensions/`.
3.  Enable **Developer mode** (top right).
4.  Click **Load unpacked** and select the directory where you cloned this repo.

## Data Source & Configuration

This project reads from a JSON index committed to this repository and intended to be refreshed by the scraper workflow.

*   **Zero Config:** The extension fetches the latest JSON index directly from GitHub.
*   **Scraper Project:** The scraping and GitHub Actions workflow live in **[`scraper/`](./scraper/README.md)**.
*   **Data File:** The generated paper index is stored in **[`data/question-papers.json`](./data/question-papers.json)**.
*   **Source Priority:** The extension uses `github-first` by default so scheduled scraper updates are picked up without rebuilding the extension. For unpacked local Chromium testing, build with `VITE_DATA_SOURCE_STRATEGY=local-first` to prefer the bundled local JSON first.

## Usage

1.  Open [ChatGPT](https://chatgpt.com).
2.  Click the SkipREXA extension icon.
3.  Search for a course and select the papers you need.
4.  Click **Upload** to send them to ChatGPT/Claude with a context prompt.
