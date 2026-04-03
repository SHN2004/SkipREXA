# OpenClaw Integration

This repo now ships a local search artifact and a fixed command wrapper so an OpenClaw server can clone the repo and allowlist one paper-search command for WhatsApp.

## What OpenClaw Should Clone

Clone the branch you want to use onto the OpenClaw server. The local search files are:

- `data/openclaw-paper-index.json`
- `bin/search-skiprexa-papers`

The search index is derived from `data/question-papers.json`. Rebuild it with:

```bash
npm run build:openclaw-index
```

## Allowed Command

Allowlist only this wrapper in the `restricted-whatsapp` agent:

```bash
/path/to/SkipREXA/bin/search-skiprexa-papers
```

The wrapper executes the in-repo Node CLI and does not require granting the agent arbitrary shell, Python, or patching access.

## CLI Usage

```bash
bin/search-skiprexa-papers --query "data structures supplementary june 2024 s3"
bin/search-skiprexa-papers --query "102907"
bin/search-skiprexa-papers --query "digital control systems" --limit 5
```

Arguments:

- `--query "<text>"` is required.
- `--limit <n>` is optional and returns only the first `n` ranked results.
- `--index <file>` is optional and overrides the default `data/openclaw-paper-index.json` path.

## Output Contract

The command prints JSON to stdout only.

Example:

```json
{
  "status": "ok",
  "query": "102907",
  "total": 2,
  "results": [
    {
      "id": "cfc44b6d4f1c0039",
      "course_name": "3D Design to Digital Fabrication: CAD, CAM and AM Essentials (102907/ME531M)",
      "course_code": "215536",
      "actual_subject_code": "102907",
      "question_paper_code": "215536",
      "semester": "S5",
      "exam_type": "Regular",
      "exam_month": "November",
      "exam_year": 2025,
      "download_url": "https://student.rajagiritech.ac.in/storage/qp/215536.pdf"
    }
  ]
}
```

`status` is:

- `ok` when at least one result matches
- `none` when no results match

## WhatsApp Agent Expectations

Recommended OpenClaw flow:

1. Detect a paper-search request in an approved direct message.
2. Call `bin/search-skiprexa-papers --query "<user text>"`.
3. Format the returned JSON into a short WhatsApp reply.
4. Include the `download_url` directly in the reply.

The repo-side command deliberately does not send WhatsApp messages or make policy decisions about authorized users. That stays on the OpenClaw side.
