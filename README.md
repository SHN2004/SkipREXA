# SkipREXA (Exam Paper Assistant)

**SkipREXA** is a Chrome Extension designed to streamline the process of uploading exam question papers to ChatGPT or Claude for study and analysis. It acts as a bridge between a database of university question papers and the LLM's file upload interface.

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

## Database & Configuration

This project is **pre-configured** with read-only access to the necessary Supabase backend. You do not need to set up a database or configure API keys to use the extension.

*   **Zero Config:** The extension works immediately after installation.
*   **Data Structure:** If you are interested in the database schema or data model, please read **[DATABASE_INFO.md](DATABASE_INFO.md)**.

## Usage

1.  Open [ChatGPT](https://chatgpt.com).
2.  Click the SkipREXA extension icon.
3.  Search for a course and select the papers you need.
4.  Click **Upload** to send them to ChatGPT/Claude with a context prompt.
