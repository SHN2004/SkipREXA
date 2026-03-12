# Scraper

This folder contains the standalone Rajagiri scraper project for SkipREXA. It is managed with `uv` and is intentionally isolated from the extension app.

## Commands

```bash
cd scraper
uv sync
uv run scraper doctor
uv run scraper scrape
uv run pytest
```

## Credentials

Set these before running the scraper:

```bash
export RAJAGIRI_USERNAME="your_uid"
export RAJAGIRI_PASSWORD="your_password"
```

You can also pass them inline:

```bash
uv run scraper doctor --username your_uid --password 'your_password'
uv run scraper scrape --username your_uid --password 'your_password'
```

## Output

By default the scraper writes to:

```text
../data/question-papers.json
```

Override it with:

```bash
uv run scraper scrape --output ../data/question-papers.json
```

## Current Status

- The Rajagiri portal uses a standard login form and an authenticated `qp_downloads` page.
- With the credentials used during local verification on March 12, 2026, the portal redirected back to `/login` after submit in `agent-browser`, Selenium, and raw HTTP.
- The CLI includes `doctor` so you can verify credentials quickly before running the full scrape.

## GitHub Actions

Use the workflow in [`.github/workflows/scrape-question-papers.yml`](../.github/workflows/scrape-question-papers.yml).

Required repository secrets:

- `RAJAGIRI_USERNAME`
- `RAJAGIRI_PASSWORD`
