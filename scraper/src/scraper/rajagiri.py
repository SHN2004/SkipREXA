from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Iterable
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from bs4.element import Tag

from scraper.config import ScraperConfig
from scraper.models import LoginAttempt, ParsedPage, QuestionPaper, RawTableRow, ScrapeMetadata, ScrapeOutput

MONTH_PATTERN = re.compile(
    r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\b",
    re.IGNORECASE,
)
YEAR_PATTERN = re.compile(r"\b20\d{2}\b")
SEMESTER_PATTERN = re.compile(r"\bS[1-8]\b", re.IGNORECASE)
CODE_PATTERN = re.compile(r"\b\d{6}\b")
ADMISSION_PATTERN = re.compile(r"\(?(\d{4})\s*(?:admns?\.?|admission|batch)\)?", re.IGNORECASE)

SEMESTER_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"first\s+semester|1st\s+semester|s1\b", re.IGNORECASE), "S1"),
    (re.compile(r"second\s+semester|2nd\s+semester|s2\b", re.IGNORECASE), "S2"),
    (re.compile(r"third\s+semester|3rd\s+semester|s3\b", re.IGNORECASE), "S3"),
    (re.compile(r"fourth\s+semester|4th\s+semester|s4\b", re.IGNORECASE), "S4"),
    (re.compile(r"fifth\s+semester|5th\s+semester|s5\b", re.IGNORECASE), "S5"),
    (re.compile(r"sixth\s+semester|6th\s+semester|s6\b", re.IGNORECASE), "S6"),
    (re.compile(r"seventh\s+semester|7th\s+semester|s7\b", re.IGNORECASE), "S7"),
    (re.compile(r"eighth\s+semester|8th\s+semester|s8\b", re.IGNORECASE), "S8"),
]


class AuthenticationError(RuntimeError):
    pass


def clean_text(value: str) -> str:
    return " ".join(value.split())


def extract_texts(cells: Iterable[Tag]) -> list[str]:
    return [clean_text(cell.get_text(" ", strip=True)) for cell in cells]


def header_lookup(headers: list[str], cells: list[str]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for index, header in enumerate(headers):
        if index >= len(cells):
            continue
        key = clean_text(header).lower()
        if key:
            lookup[key] = cells[index]
    return lookup


def find_value(lookup: dict[str, str], *needles: str) -> str | None:
    for key, value in lookup.items():
        if any(needle in key for needle in needles):
            return value
    return None


def first_match(pattern: re.Pattern[str], values: Iterable[str]) -> str | None:
    for value in values:
        match = pattern.search(value)
        if match:
            return match.group(0)
    return None


def normalize_link(href: str, page_url: str) -> str:
    return urljoin(page_url, href.strip())


def parse_subject_codes(course_name: str) -> tuple[str | None, str | None]:
    match = re.search(r"\(([^)]+)\)", course_name)
    if not match:
        return None, None

    tokens = [clean_text(token) for token in match.group(1).split("/") if clean_text(token)]
    actual_subject_code = tokens[0] if tokens else None
    alternate_code = tokens[1] if len(tokens) > 1 else None
    return actual_subject_code, alternate_code


def parse_exam_details(raw_exam: str) -> tuple[str | None, int | None, str | None, str | None]:
    exam_text = clean_text(raw_exam)
    exam_lower = exam_text.lower()

    semester = None
    for pattern, semester_code in SEMESTER_PATTERNS:
        if pattern.search(exam_lower):
            semester = semester_code
            break

    exam_type = "Regular"
    if "supplementary" in exam_lower or "supply" in exam_lower or "supple" in exam_lower:
        exam_type = "Supplementary"
    elif "improvement" in exam_lower or "improve" in exam_lower:
        exam_type = "Improvement"
    elif "regular" in exam_lower:
        exam_type = "Regular"

    exam_month = first_match(MONTH_PATTERN, [exam_text])
    year_match = re.search(r"(\d{4})\s*$", exam_text)
    if year_match:
        exam_year = int(year_match.group(1))
    else:
        years = YEAR_PATTERN.findall(exam_text)
        exam_year = int(years[-1]) if years else None

    if not exam_month:
        if "odd" in exam_lower:
            exam_month = "November"
        elif "even" in exam_lower:
            exam_month = "April"

    return (
        exam_month.title() if exam_month else None,
        exam_year,
        exam_type,
        semester,
    )


def parse_admission_year(raw_exam: str, exam_year: int | None, semester: str | None) -> int | None:
    match = ADMISSION_PATTERN.search(raw_exam)
    if match:
        return int(match.group(1))

    if exam_year is None or semester is None:
        return None

    semester_number = int(semester[1:])
    years_since_admission = max(0, (semester_number - 1) // 2)
    admission_year = exam_year - years_since_admission
    if 2015 <= admission_year <= 2030:
        return admission_year
    return None


def build_paper(row: RawTableRow, page_url: str) -> QuestionPaper | None:
    if not row.links:
        return None

    download_url = row.links[0]
    combined_values = row.cells + row.headers
    lookup = header_lookup(row.headers, row.cells)

    course_name = (
        find_value(lookup, "course", "subject")
        or (row.cells[2] if len(row.cells) > 2 else "")
        or max((value for value in row.cells if len(value) > 8), key=len, default="")
    )
    if not course_name:
        return None

    sl_no = find_value(lookup, "sl.no", "sl no") or (row.cells[0] if row.cells else None)
    question_paper_code = (
        find_value(lookup, "question paper code", "paper code", "qp code")
        or (row.cells[1] if len(row.cells) > 1 else None)
    )
    raw_exam_details = find_value(lookup, "exam") or (row.cells[3] if len(row.cells) > 3 else None)

    actual_subject_code = find_value(lookup, "subject code", "actual subject code")
    parsed_subject_code, alternate_code = parse_subject_codes(course_name)
    actual_subject_code = actual_subject_code or parsed_subject_code

    course_code = find_value(lookup, "course code") or question_paper_code
    if not course_code:
        codes = CODE_PATTERN.findall(course_name)
        if codes:
            course_code = codes[0]
            if len(codes) > 1:
                actual_subject_code = actual_subject_code or codes[1]
    if not actual_subject_code:
        actual_subject_code = alternate_code

    if raw_exam_details:
        exam_month, exam_year, exam_type, semester = parse_exam_details(raw_exam_details)
    else:
        semester = find_value(lookup, "semester") or first_match(SEMESTER_PATTERN, combined_values)
        exam_type = find_value(lookup, "exam type") or first_match(
            re.compile(r"\b(Regular|Supplementary|Model|Internal)\b", re.IGNORECASE),
            combined_values,
        )
        exam_month = find_value(lookup, "month") or first_match(MONTH_PATTERN, combined_values)
        year_text = find_value(lookup, "year") or first_match(YEAR_PATTERN, combined_values)
        exam_year = int(year_text) if year_text and year_text.isdigit() else None

    admission_year = parse_admission_year(raw_exam_details or "", exam_year, semester)

    digest_source = download_url or "|".join(row.cells)
    paper_id = hashlib.sha1(digest_source.encode("utf-8")).hexdigest()[:16]

    return QuestionPaper(
        id=paper_id,
        sl_no=sl_no,
        question_paper_code=question_paper_code,
        course_name=course_name,
        course_code=course_code,
        actual_subject_code=actual_subject_code,
        semester=semester.upper() if semester else None,
        exam_type=exam_type.title() if exam_type else None,
        admission_year=admission_year,
        exam_month=exam_month.title() if exam_month else None,
        exam_year=exam_year,
        raw_exam_details=raw_exam_details,
        download_url=normalize_link(download_url, page_url),
        source_row=row,
    )


def parse_qp_downloads_html(html: str, page_url: str) -> ParsedPage:
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    parsed_rows: list[RawTableRow] = []
    papers: list[QuestionPaper] = []
    notes: list[str] = []

    if not tables:
        notes.append("No <table> elements found on qp_downloads page.")

    for table in tables:
        headers = extract_texts(table.find_all("th"))
        for tr in table.find_all("tr"):
            cell_tags = tr.find_all(["td", "th"])
            cells = extract_texts(cell_tags)
            if not cells:
                continue
            if headers and cells == headers:
                continue

            links = []
            for anchor in tr.find_all("a", href=True):
                href = clean_text(anchor["href"])
                normalized = normalize_link(href, page_url)
                if normalized not in links:
                    links.append(normalized)

            row = RawTableRow(headers=headers, cells=cells, links=links)
            parsed_rows.append(row)

            pdf_links = [
                link
                for link in links
                if link.lower().endswith(".pdf")
                or "/storage/qp/" in link.lower()
                or "download" in link.lower()
            ]
            if not pdf_links:
                continue

            candidate = build_paper(
                RawTableRow(headers=headers, cells=cells, links=[pdf_links[0]]),
                page_url,
            )
            if candidate is not None:
                papers.append(candidate)

    if not papers:
        notes.append("No downloadable paper rows were detected from the available tables.")

    unique_papers = {paper.download_url: paper for paper in papers}
    deduped = sorted(
        unique_papers.values(),
        key=lambda paper: (paper.course_name.lower(), paper.exam_year or 0, paper.download_url),
    )

    return ParsedPage(
        page_url=page_url,
        table_count=len(tables),
        row_count=len(parsed_rows),
        papers=deduped,
        notes=notes,
    )


class RajagiriClient:
    def __init__(self, config: ScraperConfig) -> None:
        self.config = config
        self.client = httpx.Client(
            timeout=config.timeout_seconds,
            follow_redirects=False,
            verify=config.verify_ssl,
        )

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> "RajagiriClient":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def login(self) -> LoginAttempt:
        response = self.client.get(self.config.login_url)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        form = soup.find("form", id="loginForm")
        if form is None:
            raise AuthenticationError("Could not find the login form on the Rajagiri portal.")

        payload = {}
        for element in form.find_all("input"):
            name = element.get("name")
            if not name:
                continue
            payload[name] = element.get("value", "")

        payload["user_name"] = self.config.username
        payload["password"] = self.config.password

        submit_url = urljoin(self.config.login_url, form.get("action") or self.config.login_url)
        login_response = self.client.post(submit_url, data=payload)
        redirect_location = login_response.headers.get("location")
        if redirect_location:
            redirect_location = urljoin(submit_url, redirect_location)

        final_url = redirect_location or str(login_response.url)
        cookies = sorted(cookie.name for cookie in self.client.cookies.jar)
        notes: list[str] = []
        authenticated = True

        if redirect_location and redirect_location.rstrip("/") == self.config.login_url.rstrip("/"):
            authenticated = False
            notes.append("Portal redirected back to /login after credential submission.")

        if login_response.status_code >= 400:
            authenticated = False
            notes.append(f"Unexpected login status code: {login_response.status_code}")

        return LoginAttempt(
            login_url=self.config.login_url,
            final_url=final_url,
            redirect_location=redirect_location,
            status_code=login_response.status_code,
            authenticated=authenticated,
            cookies=cookies,
            notes=notes,
        )

    def fetch_qp_downloads(self) -> httpx.Response:
        response = self.client.get(self.config.qp_downloads_url, follow_redirects=True)
        response.raise_for_status()
        final_path = urlparse(str(response.url)).path.rstrip("/")
        if final_path == "/login":
            raise AuthenticationError("Portal redirected to /login when requesting qp_downloads.")
        return response


def write_output(output: ScrapeOutput, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output.model_dump(mode="json"), indent=2) + "\n", encoding="utf-8")


def build_output(parsed_page: ParsedPage) -> ScrapeOutput:
    return ScrapeOutput(
        metadata=ScrapeMetadata(
            source="student.rajagiritech.ac.in",
            page_url=parsed_page.page_url,
            paper_count=len(parsed_page.papers),
            notes=parsed_page.notes,
        ),
        papers=parsed_page.papers,
    )
