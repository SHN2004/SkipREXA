(() => {
  if (window.skiprexaAttendanceHelperLoaded) return;
  window.skiprexaAttendanceHelperLoaded = true;

  const PANEL_ID = "skiprexa-attendance-summary";
  let lastDigest = "";
  let renderTimer = null;
  let isSubmitTriggered = new URLSearchParams(window.location.search).has("code");

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
      panel.style.fontSize = "14px";
      panel.style.lineHeight = "1.4";
      panel.style.maxWidth = "1120px";
      panel.style.boxShadow = "0 1px 3px rgba(0,0,0,0.08)";
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

    if (!missedEntries.length) {
      panel.innerHTML = `
        <div style="font-size:16px;font-weight:700;margin-bottom:8px;">SkipREXA Missed Classes</div>
        <div>No missed class hours found for the selected class.</div>
      `;
      return;
    }

    const sortedEntries = [...missedEntries].sort((a, b) => {
      const da = Date.parse(a.date) || 0;
      const db = Date.parse(b.date) || 0;
      if (da !== db) return da - db;
      return Number(a.hour) - Number(b.hour);
    });

    const rowsHtml = sortedEntries
      .map(
        (entry) => `
          <tr>
            <td style="padding:8px;border:1px solid #d9e1e8;">${entry.date}</td>
            <td style="padding:8px;border:1px solid #d9e1e8;text-align:center;">${entry.hour}</td>
            <td style="padding:8px;border:1px solid #d9e1e8;">${entry.subject}</td>
          </tr>
        `
      )
      .join("");

    panel.innerHTML = `
      <div style="font-size:16px;font-weight:700;margin-bottom:8px;">SkipREXA Missed Classes</div>
      <div style="margin-bottom:10px;">
        Total missed class hours: <strong>${missedEntries.length}</strong>
      </div>
      <table style="width:100%;border-collapse:collapse;background:#fff;">
        <thead>
          <tr style="background:#f0f6fc;">
            <th style="padding:8px;border:1px solid #d9e1e8;text-align:left;">Date Missed</th>
            <th style="padding:8px;border:1px solid #d9e1e8;text-align:center;">Hour Number</th>
            <th style="padding:8px;border:1px solid #d9e1e8;text-align:left;">Subject</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
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
