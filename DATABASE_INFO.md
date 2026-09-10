# Data Index Information

SkipREXA now reads question-paper metadata from a JSON index stored in this repository at [`data/question-papers.json`](./data/question-papers.json).

## Source of Truth

- The scraper in [`scraper/`](./scraper/README.md) logs into the Rajagiri portal and rebuilds the JSON index from `https://student.rajagiritech.ac.in/qp_downloads`.
- The GitHub Actions workflow in [`.github/workflows/scrape-question-papers.yml`](./.github/workflows/scrape-question-papers.yml) is intended to refresh that JSON on a schedule.
- The extension fetches the JSON index from GitHub at runtime instead of querying Supabase.

## JSON Shape

Each scrape writes this top-level structure:

```json
{
  "metadata": {
    "generated_at": "2026-03-12T14:09:11.087197+00:00",
    "source": "student.rajagiritech.ac.in",
    "page_url": "https://student.rajagiritech.ac.in/qp_downloads",
    "paper_count": 2630,
    "notes": []
  },
  "papers": [
    {
      "id": "cfc44b6d4f1c0039",
      "sl_no": "2629",
      "question_paper_code": "215536",
      "course_name": "3D Design to Digital Fabrication: CAD, CAM & AM Essentials (102907/ME531M)",
      "course_code": "215536",
      "actual_subject_code": "102907",
      "semester": "S5",
      "exam_type": "Regular",
      "admission_year": 2023,
      "exam_month": "November",
      "exam_year": 2025,
      "raw_exam_details": "B. Tech. Fifth Semester Minor (RIZe), (2023 Admission) End Semester Examination, November 2025- Registration",
      "download_url": "https://student.rajagiritech.ac.in/storage/qp/215536.pdf",
      "source_row": {
        "headers": ["Sl.no", "Question Paper Code", "Course Name", "Exam", "Download"],
        "cells": ["2629", "215536", "3D Design to Digital Fabrication: CAD, CAM & AM Essentials (102907/ME531M)", "B. Tech. Fifth Semester Minor (RIZe), (2023 Admission) End Semester Examination, November 2025- Registration", ""],
        "links": ["https://student.rajagiritech.ac.in/storage/qp/215536.pdf"]
      }
    }
  ]
}
```

## Historical Note

The project previously read from a public Supabase mirror. That path has been retired in favor of the GitHub-hosted JSON index so scheduled scraping can update the catalog without a database dependency.
