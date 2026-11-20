from __future__ import annotations

import hashlib
import json
import re
import subprocess
import time
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


def run_agent_browser(command: str, timeout: int = 30) -> str:
    """Run an agent-browser command and return the output."""
    result = subprocess.run(
        ["agent-browser"] + command.split(),
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return result.stdout.strip()


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
        # Try browser-based login with captcha solving
        session_path = "/tmp/opencode/rajagiri_session.json"

        # Close any existing browser session
        try:
            run_agent_browser("close", timeout=10)
        except Exception:
            pass

        # Open login page
        run_agent_browser("open https://student.rajagiritech.ac.in/login")
        time.sleep(2)

        # Get captcha question
        snapshot = run_agent_browser("snapshot")
        captcha_match = re.search(r"(\d+\s*[x×*+-/÷]\s*\d+\s*=\s*\?)", snapshot)
        if not captcha_match:
            raise AuthenticationError("Could not find captcha question in snapshot")

        captcha_question = captcha_match.group(1)

        # Solve captcha in Python
        match = re.search(r"(\d+)\s*([x×*+-/÷])\s*(\d+)", captcha_question)
        if not match:
            raise AuthenticationError(f"Could not parse captcha: {captcha_question}")

        a = int(match.group(1))
        op = match.group(2)
        b = int(match.group(3))

        if op in ("x", "×", "*"):
            captcha_answer = a * b
        elif op == "+":
            captcha_answer = a + b
        elif op == "-":
            captcha_answer = a - b
        elif op in ("/", "÷"):
            captcha_answer = a // b
        else:
            raise AuthenticationError(f"Unknown operator: {op}")

        # Find form element refs
        uid_ref = None
        password_ref = None
        captcha_ref = None

        for line in snapshot.split("\n"):
            if 'textbox "UID"' in line:
                ref_match = re.search(r"ref=(\w+)", line)
                if ref_match:
                    uid_ref = "@" + ref_match.group(1)
            elif 'textbox "Password"' in line:
                ref_match = re.search(r"ref=(\w+)", line)
                if ref_match:
                    password_ref = "@" + ref_match.group(1)
            elif 'spinbutton "Enter answer"' in line:
                ref_match = re.search(r"ref=(\w+)", line)
                if ref_match:
                    captcha_ref = "@" + ref_match.group(1)

        if not all([uid_ref, password_ref, captcha_ref]):
            raise AuthenticationError(
                f"Could not find all form elements. uid={uid_ref}, password={password_ref}, captcha={captcha_ref}"
            )

        # Fill form using @eN refs
        run_agent_browser(f"fill {uid_ref} {self.config.username}")
        run_agent_browser(f"fill {password_ref} {self.config.password}")
        run_agent_browser(f"fill {captcha_ref} {captcha_answer}")

        # Find login button ref
        login_ref = None
        for line in snapshot.split("\n"):
            if 'button "Log In"' in line:
                ref_match = re.search(r"ref=(\w+)", line)
                if ref_match:
                    login_ref = "@" + ref_match.group(1)
                    break

        # Submit form using JavaScript via shell
        subprocess.run(
            ["agent-browser", "eval", "document.forms[0].submit()"],
            capture_output=True,
            text=True,
            timeout=30,
        )

        # Wait for login
        time.sleep(5)

        # Check if we're on the home page
        url = run_agent_browser("get url")

        if "login" in url:
            # Login failed, check for error
            snapshot = run_agent_browser("snapshot")
            if "CAPTCHA is invalid or expired" in snapshot:
                # Retry once
                run_agent_browser("open https://student.rajagiritech.ac.in/login")
                time.sleep(2)
                run_agent_browser(f'eval "{js}"')
                time.sleep(5)
                url = run_agent_browser("get url")

        authenticated = "login" not in url

        if authenticated:
            # Save session state
            run_agent_browser(f"state save {session_path}")

            # Load cookies from session
            with open(session_path, "r") as f:
                session = json.load(f)

            for cookie in session["cookies"]:
                self.client.cookies.set(
                    cookie["name"],
                    cookie["value"],
                    domain=cookie["domain"],
                    path=cookie["path"],
                )

            cookies = sorted(cookie.name for cookie in self.client.cookies.jar)
            return LoginAttempt(
                login_url=self.config.login_url,
                final_url=url,
                redirect_location=None,
                status_code=200,
                authenticated=True,
                cookies=cookies,
                notes=["Browser-based login with captcha solving succeeded."],
            )
        else:
            snapshot = run_agent_browser("snapshot")
            notes = ["Browser-based login failed."]
            if "credentials do not match" in snapshot:
                notes.append("Invalid credentials.")
            elif "CAPTCHA is invalid or expired" in snapshot:
                notes.append("Captcha expired.")

            return LoginAttempt(
                login_url=self.config.login_url,
                final_url=url,
                redirect_location=None,
                status_code=401,
                authenticated=False,
                cookies=[],
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
