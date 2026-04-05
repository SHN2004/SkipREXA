(() => {
  if (window.skiprexaAttendanceHelperLoaded) return;
  window.skiprexaAttendanceHelperLoaded = true;

  const PANEL_ID = "skiprexa-attendance-summary";
  const TILE_HIGHLIGHT_CLASS = "skiprexa-subject-tile-highlight";
  let lastDigest = "";
  let renderTimer = null;
  let isSubmitTriggered = new URLSearchParams(window.location.search).has("code");
  let highlightedCells = [];

  function cleanText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function parseRgb(color) {
    const match = String(color || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  function colorDistance(a, b) {
    return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
  }

  function classifyByColor(cell) {
    const computed = window.getComputedStyle(cell).backgroundColor;
    const rgb = parseRgb(computed) || parseRgb(cell.getAttribute("bgcolor"));
    if (!rgb) return null;

    const palette = [
      { type: "leave", rgb: [176, 0, 0] },
      { type: "approved_leave", rgb: [0, 128, 0] },
      { type: "duty_leave", rgb: [255, 153, 0] },
      { type: "duty_attendance", rgb: [190, 190, 0] }
    ];

    const nearest = palette
      .map((item) => ({ ...item, distance: colorDistance(item.rgb, rgb) }))
      .sort((a, b) => a.distance - b.distance)[0];

    return nearest && nearest.distance <= 95 ? nearest.type : null;
  }

  function classifyEntryType(cell, text) {
    const lower = `${text} ${cell.className || ""} ${cell.title || ""}`.toLowerCase();

    if (lower.includes("duty attendance")) return "duty_attendance";
    if (lower.includes("duty leave")) return "duty_leave";
    if (lower.includes("approved")) return "approved_leave";
    if (lower.includes("leave")) return "leave";

    return classifyByColor(cell) || "leave";
  }

  function extractSubject(raw) {
    const text = cleanText(raw);
    const match = text.match(/[A-Z0-9]+\/([A-Z0-9]+)/i);
    return (match ? match[1] : text).toUpperCase();
  }

  function findLeaveTable() {
    const tables = Array.from(document.querySelectorAll("table")).filter(
      (table) => !table.closest(`#${PANEL_ID}`)
    );

    for (const table of tables) {
      const firstRow = table.querySelector("tr");
      if (!firstRow) continue;

      const headerCells = Array.from(firstRow.querySelectorAll("th,td")).map((cell) =>
        cleanText(cell.textContent)
      );
      if (headerCells.length < 3) continue;
      if (!/^date\/hours$/i.test(headerCells[0])) continue;

      const hourLikeCount = headerCells
        .slice(1)
        .filter((text) => /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 12).length;

      if (hourLikeCount >= 4) return table;
    }

    return null;
  }

  function parseLeaveEntries() {
    const table = findLeaveTable();
    if (!table) return [];

    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length < 2) return [];

    const headerCells = Array.from(rows[0].querySelectorAll("th,td")).map((cell) => cleanText(cell.textContent));
    const hourHeaders = headerCells.slice(1).map((hour, index) => hour || String(index + 1));

    const entries = [];
    const seen = new Set();

    for (const row of rows.slice(1)) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 2) continue;

      const date = cleanText(cells[0].textContent);
      if (!/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(date)) continue;

      for (let i = 1; i < cells.length; i += 1) {
        const cell = cells[i];
        const raw = cleanText(cell.textContent);
        if (!raw) continue;
        if (!/[A-Z0-9]+\/[A-Z0-9]+/i.test(raw)) continue;

        const type = classifyEntryType(cell, raw);
        if (type === "duty_attendance") continue;

        const subject = extractSubject(raw);
        const hour = hourHeaders[i - 1] || String(i);
        const key = `${date}|${hour}|${subject}`;
        if (seen.has(key)) continue;
        seen.add(key);

        entries.push({
          date: date || "-",
          hour,
          subject,
          leaveType: type
        });
      }
    }

    return entries;
  }

  function findAnchorElement() {
    return findLeaveTable() || document.querySelector("form") || document.body;
  }

  function parseShortDate(value) {
    const match = String(value || "").match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (!match) return 0;
    const day = Number(match[1]);
    const monthMap = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11
    };
    const month = monthMap[match[2].toLowerCase()];
    const year = Number(match[3]);
    if (Number.isNaN(day) || Number.isNaN(year) || month === undefined) return 0;
    return new Date(year, month, day).getTime();
  }

  function groupBySubject(entries) {
    const grouped = new Map();
    for (const entry of entries) {
      const current = grouped.get(entry.subject) || {
        subject: entry.subject,
        missedHours: 0,
        sessions: []
      };
      current.missedHours += 1;
      current.sessions.push({ date: entry.date, hour: entry.hour, leaveType: entry.leaveType });
      grouped.set(entry.subject, current);
    }

    const rows = Array.from(grouped.values());
    for (const row of rows) {
      row.sessions.sort((a, b) => {
        const da = parseShortDate(a.date);
        const db = parseShortDate(b.date);
        if (da !== db) return da - db;
        return Number(a.hour) - Number(b.hour);
      });
    }

    rows.sort((a, b) => {
      if (b.missedHours !== a.missedHours) return b.missedHours - a.missedHours;
      return a.subject.localeCompare(b.subject);
    });

    return rows;
  }

  function clearSubjectHighlight() {
    if (!highlightedCells.length) return;
    for (const cell of highlightedCells) {
      cell.classList.remove(TILE_HIGHLIGHT_CLASS);
    }
    highlightedCells = [];
  }

  function highlightSubjectCells(subject) {
    clearSubjectHighlight();
    if (!subject) return;

    const table = findLeaveTable();
    if (!table) return;

    const cells = Array.from(table.querySelectorAll("td"));
    for (const cell of cells) {
      const raw = cleanText(cell.textContent);
      if (!/[A-Z0-9]+\/[A-Z0-9]+/i.test(raw)) continue;
      if (extractSubject(raw) !== subject) continue;
      cell.classList.add(TILE_HIGHLIGHT_CLASS);
      highlightedCells.push(cell);
    }
  }

  function attachSubjectHover(panel) {
    const rows = panel.querySelectorAll("tr[data-subject]");
    for (const row of rows) {
      const subject = row.getAttribute("data-subject");
      row.addEventListener("mouseenter", () => highlightSubjectCells(subject));
      row.addEventListener("mouseleave", clearSubjectHighlight);
    }
  }

  function getOrCreatePanel(anchor) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      panel.style.marginTop = "6px";
      panel.style.padding = "12px";
      panel.style.border = "1px solid #c8d1db";
      panel.style.borderRadius = "8px";
      panel.style.background = "#ffffff";
      panel.style.fontFamily = "Segoe UI, Arial, sans-serif";
      panel.style.fontSize = "13px";
      panel.style.lineHeight = "1.4";
      panel.style.maxWidth = "1120px";
      panel.style.boxShadow = "0 4px 14px rgba(0,0,0,0.09)";
    }

    if (anchor === document.body) {
      document.body.appendChild(panel);
    } else {
      anchor.insertAdjacentElement("afterend", panel);
    }

    return panel;
  }

  function renderSummary() {
    if (!isSubmitTriggered) return;

    const entries = parseLeaveEntries();
    const digest = JSON.stringify(entries);
    if (digest === lastDigest) return;
    lastDigest = digest;

    const panel = getOrCreatePanel(findAnchorElement());
    const missedEntries = entries;
    clearSubjectHighlight();

    if (!missedEntries.length) {
      panel.innerHTML = `
        <div style="font-size:16px;font-weight:700;margin-bottom:8px;">SkipREXA Missed Classes</div>
        <div>No missed class hours found for the selected class.</div>
      `;
      return;
    }

    const subjectRows = groupBySubject(missedEntries);

    const rowsHtml = subjectRows
      .map(
        (entry) => `
          <tr data-subject="${entry.subject}" style="transition:background-color 0.15s ease;">
            <td style="padding:8px 10px;border:1px solid #d9e1e8;vertical-align:top;">
              <details>
                <summary style="cursor:pointer;font-weight:600;color:#0f4c81;display:flex;align-items:center;gap:8px;list-style:none;">
                  <span class="skiprexa-chevron" aria-hidden="true">&#9656;</span>
                  <span>${entry.subject}</span>
                </summary>
                <div style="margin-top:6px;padding-top:6px;border-top:1px dashed #d5deea;color:#334155;">
                  ${entry.sessions
                    .map(
                      (item) =>
                        `<div style="display:flex;justify-content:space-between;gap:8px;">
                          <span>${item.date}</span><span>Hour ${item.hour}</span>
                        </div>`
                    )
                    .join("")}
                </div>
              </details>
            </td>
            <td style="padding:8px 10px;border:1px solid #d9e1e8;text-align:center;font-weight:700;color:#991b1b;">${entry.missedHours}</td>
          </tr>
        `
      )
      .join("");

    panel.innerHTML = `
      <style>
        #${PANEL_ID} details > summary::-webkit-details-marker { display: none; }
        #${PANEL_ID} details > summary::marker { content: ""; }
        #${PANEL_ID} tr[data-subject]:hover { background: #f8fbff; }
        #${PANEL_ID} .skiprexa-chevron {
          display: inline-block;
          transition: transform 0.18s ease;
          color: #075985;
        }
        #${PANEL_ID} details[open] .skiprexa-chevron { transform: rotate(90deg); }
        .${TILE_HIGHLIGHT_CLASS} {
          outline: 2px solid #16a34a !important;
          outline-offset: -2px;
          box-shadow: inset 0 0 0 999px rgba(34, 197, 94, 0.16);
          transition: box-shadow 0.16s ease, outline-color 0.16s ease;
        }
      </style>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;">
        <div style="font-size:16px;font-weight:700;color:#0b3558;">SkipREXA Missed Classes</div>
        <div style="padding:4px 10px;border-radius:999px;background:#fef2f2;color:#7f1d1d;border:1px solid #fecaca;font-weight:700;">
          Total Missed Hours: ${missedEntries.length}
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;background:#fff;table-layout:fixed;">
        <thead>
          <tr style="background:linear-gradient(180deg,#f8fbff 0%, #edf4fb 100%);">
            <th style="padding:8px 10px;border:1px solid #d9e1e8;text-align:left;">Subject (click to view missed sessions)</th>
            <th style="padding:8px 10px;border:1px solid #d9e1e8;text-align:center;width:170px;">Hours Missed</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;

    attachSubjectHover(panel);
  }

  function scheduleRender() {
    if (!isSubmitTriggered) return;
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(renderSummary, 250);
  }

  function attachSubmitListeners() {
    document.addEventListener(
      "submit",
      () => {
        isSubmitTriggered = true;
        scheduleRender();
      },
      true
    );

    document.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const submitTrigger = target.closest('input[type="submit"],button[type="submit"],button[name*="submit"],input[name*="submit"]');
        if (!submitTrigger) return;
        isSubmitTriggered = true;
        scheduleRender();
      },
      true
    );
  }

  function watchDynamicUpdates() {
    const observer = new MutationObserver(() => {
      scheduleRender();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  attachSubmitListeners();
  watchDynamicUpdates();
  if (isSubmitTriggered) scheduleRender();
})();
