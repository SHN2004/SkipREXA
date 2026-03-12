from scraper.rajagiri import parse_qp_downloads_html


def test_parse_qp_downloads_html_extracts_question_papers() -> None:
    html = """
    <html>
      <body>
        <table>
          <thead>
            <tr>
              <th>Sl.no</th>
              <th>Question Paper Code</th>
              <th>Course Name</th>
              <th>Exam</th>
              <th>Download</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>1</td>
              <td>211001</td>
              <td>Linear Algebra and Calculus (100908/MA100A)</td>
              <td>B.Tech Degree First Semester Examination, April 2021</td>
              <td><a href="/storage/qp/211001.pdf">PDF</a></td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
    """

    parsed = parse_qp_downloads_html(html, "https://student.rajagiritech.ac.in/qp_downloads")

    assert parsed.table_count == 1
    assert parsed.row_count == 1
    assert len(parsed.papers) == 1

    paper = parsed.papers[0]
    assert paper.sl_no == "1"
    assert paper.question_paper_code == "211001"
    assert paper.course_name == "Linear Algebra and Calculus (100908/MA100A)"
    assert paper.course_code == "211001"
    assert paper.actual_subject_code == "100908"
    assert paper.semester == "S1"
    assert paper.exam_type == "Regular"
    assert paper.exam_month == "April"
    assert paper.exam_year == 2021
    assert paper.download_url == "https://student.rajagiritech.ac.in/storage/qp/211001.pdf"


def test_parse_qp_downloads_html_extracts_supplementary_admission_details() -> None:
    html = """
    <html>
      <body>
        <table>
          <thead>
            <tr>
              <th>Sl.no</th>
              <th>Question Paper Code</th>
              <th>Course Name</th>
              <th>Exam</th>
              <th>Download</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>2</td>
              <td>212319</td>
              <td>Linear Algebra and Calculus (100908/MA100A)</td>
              <td>S1 Btech Supplementary (2020 admns.) June 2024</td>
              <td><a href="/storage/qp/212319.pdf">PDF</a></td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
    """

    parsed = parse_qp_downloads_html(html, "https://student.rajagiritech.ac.in/qp_downloads")

    paper = parsed.papers[0]
    assert paper.question_paper_code == "212319"
    assert paper.semester == "S1"
    assert paper.exam_type == "Supplementary"
    assert paper.admission_year == 2020
    assert paper.exam_month == "June"
    assert paper.exam_year == 2024
