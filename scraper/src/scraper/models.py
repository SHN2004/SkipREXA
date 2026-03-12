from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field


class LoginAttempt(BaseModel):
    login_url: str
    final_url: str
    redirect_location: str | None = None
    status_code: int
    authenticated: bool
    cookies: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class RawTableRow(BaseModel):
    headers: list[str] = Field(default_factory=list)
    cells: list[str] = Field(default_factory=list)
    links: list[str] = Field(default_factory=list)


class QuestionPaper(BaseModel):
    id: str
    sl_no: str | None = None
    question_paper_code: str | None = None
    course_name: str
    course_code: str | None = None
    actual_subject_code: str | None = None
    semester: str | None = None
    exam_type: str | None = None
    admission_year: int | None = None
    exam_month: str | None = None
    exam_year: int | None = None
    raw_exam_details: str | None = None
    download_url: str
    source_row: RawTableRow


class ScrapeMetadata(BaseModel):
    generated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    source: str
    page_url: str
    paper_count: int
    notes: list[str] = Field(default_factory=list)


class ScrapeOutput(BaseModel):
    metadata: ScrapeMetadata
    papers: list[QuestionPaper]


class ParsedPage(BaseModel):
    page_url: str
    table_count: int
    row_count: int
    papers: list[QuestionPaper]
    notes: list[str] = Field(default_factory=list)


class DoctorReport(BaseModel):
    login: LoginAttempt
    qp_page_url: str | None = None
    table_count: int | None = None
    row_count: int | None = None
    paper_count: int | None = None
    notes: list[str] = Field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")
