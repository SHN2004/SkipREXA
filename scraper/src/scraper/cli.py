from __future__ import annotations

from pathlib import Path

import typer

from scraper.config import ScraperConfig
from scraper.models import DoctorReport
from scraper.rajagiri import AuthenticationError, RajagiriClient, build_output, parse_qp_downloads_html, write_output

app = typer.Typer(help="SkipREXA Rajagiri scraper CLI", no_args_is_help=True)


def resolve_config(
    username: str | None,
    password: str | None,
    output: Path | None = None,
) -> ScraperConfig:
    try:
        return ScraperConfig.from_env(username=username, password=password, output_path=output)
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error


@app.command()
def doctor(
    username: str | None = typer.Option(None, help="Rajagiri UID. Falls back to RAJAGIRI_USERNAME."),
    password: str | None = typer.Option(None, help="Rajagiri password. Falls back to RAJAGIRI_PASSWORD."),
) -> None:
    """Validate login and inspect qp_downloads without writing output."""
    config = resolve_config(username, password)
    with RajagiriClient(config) as client:
        login = client.login()
        report = DoctorReport(login=login)

        if login.authenticated:
            page_response = client.fetch_qp_downloads()
            parsed_page = parse_qp_downloads_html(page_response.text, str(page_response.url))
            report.qp_page_url = parsed_page.page_url
            report.table_count = parsed_page.table_count
            report.row_count = parsed_page.row_count
            report.paper_count = len(parsed_page.papers)
            report.notes.extend(parsed_page.notes)

        typer.echo(report.model_dump_json(indent=2))
        if not login.authenticated:
            raise typer.Exit(code=1)


@app.command()
def scrape(
    username: str | None = typer.Option(None, help="Rajagiri UID. Falls back to RAJAGIRI_USERNAME."),
    password: str | None = typer.Option(None, help="Rajagiri password. Falls back to RAJAGIRI_PASSWORD."),
    output: Path | None = typer.Option(
        None,
        "--output",
        "-o",
        help="Output JSON path. Defaults to ../data/question-papers.json.",
        dir_okay=False,
    ),
) -> None:
    """Log in, parse qp_downloads, and write the normalized JSON file."""
    config = resolve_config(username, password, output)
    with RajagiriClient(config) as client:
        login = client.login()
        if not login.authenticated:
            raise AuthenticationError(
                "Rajagiri login failed. Run `uv run scraper doctor` for diagnostics."
            )

        page_response = client.fetch_qp_downloads()
        parsed_page = parse_qp_downloads_html(page_response.text, str(page_response.url))
        output_model = build_output(parsed_page)
        write_output(output_model, config.output_path)

    typer.echo(
        f"Wrote {len(output_model.papers)} papers to {config.output_path} "
        f"from {output_model.metadata.page_url}"
    )


def main() -> None:
    app()
