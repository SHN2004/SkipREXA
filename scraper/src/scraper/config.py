from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel, Field


class ScraperConfig(BaseModel):
    username: str
    password: str
    login_url: str = "https://student.rajagiritech.ac.in/login"
    qp_downloads_url: str = "https://student.rajagiritech.ac.in/qp_downloads"
    output_path: Path = Field(default_factory=lambda: Path(__file__).resolve().parents[3] / "data" / "question-papers.json")
    timeout_seconds: float = 30.0
    verify_ssl: bool = False

    @classmethod
    def from_env(
        cls,
        username: str | None = None,
        password: str | None = None,
        output_path: Path | None = None,
    ) -> "ScraperConfig":
        resolved_username = username or os.getenv("RAJAGIRI_USERNAME")
        resolved_password = password or os.getenv("RAJAGIRI_PASSWORD")

        missing = []
        if not resolved_username:
            missing.append("RAJAGIRI_USERNAME")
        if not resolved_password:
            missing.append("RAJAGIRI_PASSWORD")

        if missing:
            missing_list = ", ".join(missing)
            raise ValueError(f"Missing required credentials: {missing_list}")

        data: dict[str, object] = {
            "username": resolved_username,
            "password": resolved_password,
        }
        if output_path is not None:
            data["output_path"] = output_path

        return cls(**data)
