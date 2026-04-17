(() => {
  if (window.skiprexaAttendanceHelperLoaded) return;
  window.skiprexaAttendanceHelperLoaded = true;

  const PANEL_ID = "skiprexa-attendance-summary";
  const TILE_HIGHLIGHT_CLASS = "skiprexa-subject-tile-highlight";
  const TILE_HIGHLIGHT_INFO_CLASS = "skiprexa-subject-tile-highlight-info";
  const STORAGE_KEY = "skiprexa-attendance-data";
  const SUBJECT_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14;
  let lastDigest = "";
  let renderTimer = null;
  let lateUpdateObserver = null;
  let lateUpdateObserverTimer = null;
  let isSubmitTriggered = new URLSearchParams(window.location.search).has("code");
  let highlightedCells = [];
  let pinnedHighlightSubjects = new Set();
  const subjectMapPromises = new Map();
  const subjectMapFailureTimestamps = new Map();

  // ── Persisted state ──────────────────────────────────────────────
  let attendanceThreshold = 0.75;
  let totalClassesMap = {};
  let subjectNameCache = {};

  function loadPersistedState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.threshold === 0.75 || data.threshold === 0.80) attendanceThreshold = data.threshold;
      if (data.totalClasses && typeof data.totalClasses === "object") totalClassesMap = data.totalClasses;
      if (data.subjectNameCache && typeof data.subjectNameCache === "object") subjectNameCache = data.subjectNameCache;
    } catch { /* ignore */ }
  }

  function savePersistedState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        threshold: attendanceThreshold,
        totalClasses: totalClassesMap,
        subjectNameCache
      }));
    } catch { /* ignore */ }
  }

  loadPersistedState();

  // ── Inject typography ────────────────────────────────────────────
  function injectFont() {
    if (document.getElementById("skiprexa-font-link")) return;
    const link = document.createElement("link");
    link.id = "skiprexa-font-link";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,500;0,9..40,700&family=JetBrains+Mono:wght@500;700&display=swap";
    document.head.appendChild(link);
  }
  injectFont();

  // ── Parsing utilities ────────────────────────────────────────────

  function cleanText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function parseRgb(color) {
    const str = String(color || "");
    // Handle hex: #rgb or #rrggbb
    const hexMatch = str.match(/^#([0-9a-f]{3,6})$/i);
    if (hexMatch) {
      let h = hexMatch[1];
      if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
      return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
    }
    // Handle rgb(...) / rgba(...)
    const match = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
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

  // Known RSMS portal bgcolor values — checked first, before any distance math.
  const KNOWN_COLORS = [
    { hex: /^#9f0000$/i, type: "leave" },           // dark red = unexcused absent
    { hex: /^#b00000$/i, type: "leave" },
    { hex: /^#cc0000$/i, type: "leave" },
    { hex: /^#ff0000$/i, type: "leave" },
    { hex: /^#cccc00$/i, type: "duty_attendance" },  // yellow = duty attendance
    { hex: /^#c8c800$/i, type: "duty_attendance" },
    { hex: /^#bebe00$/i, type: "duty_attendance" },
    { hex: /^#008000$/i, type: "approved_leave" },   // green = approved leave
    { hex: /^#009900$/i, type: "approved_leave" },
    { hex: /^#ff9900$/i, type: "duty_leave" },       // orange = duty leave
  ];

  function classifyEntryType(cell, text) {
    // 1. Check explicit bgcolor attribute first — most reliable on RSMS portal
    const bg = (cell.getAttribute("bgcolor") || "").trim();
    if (bg) {
      for (const { hex, type } of KNOWN_COLORS) {
        if (hex.test(bg)) return type;
      }
    }
    // 2. Text / class / title heuristics
    const lower = `${text} ${cell.className || ""} ${cell.title || ""}`.toLowerCase();
    if (lower.includes("duty attendance")) return "duty_attendance";
    if (lower.includes("duty leave")) return "duty_leave";
    if (lower.includes("approved")) return "approved_leave";
    if (lower.includes("leave")) return "leave";
    // 3. Computed style color distance fallback
    return classifyByColor(cell) || "leave";
  }

  function extractSubject(raw) {
    const text = cleanText(raw);
    const match = text.match(/[A-Z0-9]+\/([A-Z0-9]+)/i);
    return (match ? match[1] : text).toUpperCase();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeSubjectToken(value) {
    return cleanText(value).replace(/\s+/g, "").toUpperCase();
  }

  function getCurrentClassCode() {
    const fromUrl = normalizeSubjectToken(new URLSearchParams(window.location.search).get("code") || "");
    if (fromUrl) return fromUrl;

    const control = document.querySelector('select[name="code"], input[name="code"], select#list1, input#list1');
    const fromControl = normalizeSubjectToken(control && "value" in control ? control.value : "");
    if (fromControl) return fromControl;

    return "";
  }

  function getValidSubjectCacheEntry(classCode) {
    const entry = subjectNameCache[classCode];
    if (!entry || typeof entry !== "object") return null;
    if (!entry.fetchedAt || (Date.now() - entry.fetchedAt) > SUBJECT_CACHE_TTL_MS) return null;
    if (!entry.subjects || typeof entry.subjects !== "object") return null;
    return entry;
  }

  function getSubjectDisplayMeta(subjectCode) {
    const normalizedCode = normalizeSubjectToken(subjectCode);
    const classCode = getCurrentClassCode();
    const cached = classCode ? getValidSubjectCacheEntry(classCode) : null;
    const subjectInfo = cached?.subjects?.[normalizedCode] || null;
    const name = cleanText(subjectInfo?.name || "");
    return {
      code: normalizedCode,
      name,
      label: name ? `${name} (${normalizedCode})` : normalizedCode
    };
  }

  function findSubjectMapTable(doc) {
    const tables = Array.from(doc.querySelectorAll("table"));
    let bestMatch = null;

    for (const table of tables) {
      const firstRow = table.querySelector("tr");
      if (!firstRow) continue;
      const headerCells = Array.from(firstRow.querySelectorAll("th,td")).map((cell) => cleanText(cell.textContent).toLowerCase());
      if (headerCells.length < 3) continue;
      if (headerCells[1] !== "code" || headerCells[2] !== "subject") continue;

      const rows = Array.from(table.querySelectorAll("tr"))
        .slice(1)
        .map((row) => Array.from(row.querySelectorAll("td,th")).map((cell) => cleanText(cell.textContent)))
        .filter((row) => row.length >= 3 && row[1] && row[2] && /\//.test(row[1]));

      if (!rows.length) continue;
      if (!bestMatch || rows.length > bestMatch.rows.length) bestMatch = { table, rows };
    }

    return bestMatch;
  }

  async function fetchExamIdsForClass(classCode) {
    const response = await fetch(`gethint4.asp?cc=&q=${encodeURIComponent(classCode)}&sid=${Date.now()}`, {
      credentials: "include",
      cache: "no-store"
    });
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return Array.from(doc.querySelectorAll('option[value]'))
      .map((option) => cleanText(option.getAttribute("value")))
      .filter(Boolean);
  }

  async function fetchSubjectMapForClass(classCode) {
    const examIds = await fetchExamIdsForClass(classCode);
    if (!examIds.length) return null;

    for (const examId of examIds) {
      const response = await fetch(`Mark.asp?code=${encodeURIComponent(classCode)}&E_ID=${encodeURIComponent(examId)}`, {
        credentials: "include",
        cache: "no-store"
      });
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const match = findSubjectMapTable(doc);
      if (!match) continue;

      const subjects = {};
      for (const row of match.rows) {
        const fullCode = normalizeSubjectToken(row[1]);
        const shortCode = extractSubject(fullCode);
        const name = cleanText(row[2]);
        if (!shortCode || !name) continue;
        subjects[shortCode] = { fullCode, name };
      }

      if (Object.keys(subjects).length) {
        return { fetchedAt: Date.now(), examId, subjects };
      }
    }

    return null;
  }

  function patchSubjectLabels(panel) {
    if (!panel) return;
    const rows = panel.querySelectorAll("tr[data-subject]");
    for (const row of rows) {
      const subject = row.getAttribute("data-subject") || "";
      const subjectMeta = getSubjectDisplayMeta(subject);
      const nameNode = row.querySelector(".skiprexa-subject-name");
      const metaNode = row.querySelector(".skiprexa-subject-meta");
      const pinButton = row.querySelector(".skiprexa-highlight-toggle");

      if (nameNode) nameNode.textContent = subjectMeta.name || subject;

      if (subjectMeta.name) {
        if (metaNode) metaNode.textContent = `(${subject})`;
        else if (nameNode) {
          const nextMeta = document.createElement("span");
          nextMeta.className = "skiprexa-subject-meta";
          nextMeta.textContent = `(${subject})`;
          nameNode.insertAdjacentElement("afterend", nextMeta);
        }
      } else if (metaNode) {
        metaNode.remove();
      }

      if (pinButton) {
        pinButton.setAttribute("title", `Highlight ${subjectMeta.label} on timetable`);
      }
    }

    syncPinnedHighlightButtons(panel);
  }

  function ensureSubjectNamesForCurrentClass(entries) {
    const classCode = getCurrentClassCode();
    if (!classCode || !entries.length) return;

    const cached = getValidSubjectCacheEntry(classCode);
    const neededSubjects = new Set(entries.map((entry) => normalizeSubjectToken(entry.subject)).filter(Boolean));
    const hasAllSubjects = cached && Array.from(neededSubjects).every((subject) => cached.subjects[subject]);
    if (hasAllSubjects) return;
    if (subjectMapPromises.has(classCode)) return;
    if ((Date.now() - (subjectMapFailureTimestamps.get(classCode) || 0)) < 60_000) return;

    const promise = fetchSubjectMapForClass(classCode)
      .then((result) => {
        if (!result) return;
        subjectNameCache[classCode] = result;
        savePersistedState();
        patchSubjectLabels(document.getElementById(PANEL_ID));
      })
      .catch(() => {
        subjectMapFailureTimestamps.set(classCode, Date.now());
        // silent fallback to subject codes
      })
      .finally(() => {
        subjectMapPromises.delete(classCode);
      });

    subjectMapPromises.set(classCode, promise);
  }

  function findLeaveTable() {
    const tables = Array.from(document.querySelectorAll("table")).filter(
      (table) => !table.closest(`#${PANEL_ID}`)
    );
    for (const table of tables) {
      const firstRow = table.querySelector("tr");
      if (!firstRow) continue;
      const headerCells = Array.from(firstRow.querySelectorAll("th,td")).map((cell) => cleanText(cell.textContent));
      if (headerCells.length < 3) continue;
      if (!/^date\/hours$/i.test(headerCells[0])) continue;
      const hourLikeCount = headerCells.slice(1).filter((text) => /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 12).length;
      if (hourLikeCount >= 4) return table;
    }
    return null;
  }

  // Only unapproved "leave" (red) counts against attendance.
  // approved_leave and duty_leave are tracked for info but do NOT count.
  function isCountable(leaveType) {
    return leaveType === "leave";
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
        if (type === "duty_attendance") continue; // never shown
        const subject = extractSubject(raw);
        const hour = hourHeaders[i - 1] || String(i);
        const key = `${date}|${hour}|${subject}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ date: date || "-", hour, subject, leaveType: type });
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
    const monthMap = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
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
        missedHours: 0,      // only countable (red) leaves
        infoHours: 0,        // approved / duty leaves (not counted)
        sessions: []
      };
      if (isCountable(entry.leaveType)) {
        current.missedHours += 1;
      } else {
        current.infoHours += 1;
      }
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
    // Sort by countable misses descending
    rows.sort((a, b) => {
      if (b.missedHours !== a.missedHours) return b.missedHours - a.missedHours;
      return a.subject.localeCompare(b.subject);
    });
    return rows;
  }

  // ── Cell highlight ───────────────────────────────────────────────

  function clearSubjectHighlight() {
    if (!highlightedCells.length) return;
    for (const cell of highlightedCells) {
      cell.classList.remove(TILE_HIGHLIGHT_CLASS);
      cell.classList.remove(TILE_HIGHLIGHT_INFO_CLASS);
    }
    highlightedCells = [];
  }

  function applySubjectHighlights(subjects) {
    clearSubjectHighlight();
    if (!subjects || !subjects.size) return;
    const table = findLeaveTable();
    if (!table) return;
    const cells = Array.from(table.querySelectorAll("td"));
    for (const cell of cells) {
      const raw = cleanText(cell.textContent);
      if (!/[A-Z0-9]+\/[A-Z0-9]+/i.test(raw)) continue;
      if (!subjects.has(extractSubject(raw))) continue;
      const type = classifyEntryType(cell, raw);
      if (isCountable(type)) {
        cell.classList.add(TILE_HIGHLIGHT_CLASS);       // green — counts
      } else {
        cell.classList.add(TILE_HIGHLIGHT_INFO_CLASS);  // blue — doesn't count
      }
      highlightedCells.push(cell);
    }
  }

  function syncPinnedHighlightButtons(panel) {
    const buttons = panel.querySelectorAll(".skiprexa-highlight-toggle");
    for (const button of buttons) {
      const subject = button.getAttribute("data-subject");
      const subjectLabel = subject ? getSubjectDisplayMeta(subject).label : "subject";
      const isActive = Boolean(subject) && pinnedHighlightSubjects.has(subject);
      button.classList.toggle("is-active", isActive);
      const row = button.closest("tr[data-subject]");
      if (row) row.classList.toggle("is-pinned-highlight", isActive);
      button.setAttribute("aria-pressed", String(isActive));
      button.setAttribute("title", isActive ? `Hide ${subjectLabel} on timetable` : `Highlight ${subjectLabel} on timetable`);
    }
  }

  function setPinnedHighlightSubjects(subjects, panel) {
    pinnedHighlightSubjects = new Set(subjects || []);
    applySubjectHighlights(pinnedHighlightSubjects);
    if (panel) syncPinnedHighlightButtons(panel);
  }

  function attachSubjectInteractions(panel) {
    const rows = panel.querySelectorAll("tr[data-subject]");
    for (const row of rows) {
      const subject = row.getAttribute("data-subject");
      row.addEventListener("mouseenter", () => {
        if (pinnedHighlightSubjects.size) return;
        if (!subject) return;
        applySubjectHighlights(new Set([subject]));
      });
      row.addEventListener("mouseleave", () => {
        if (pinnedHighlightSubjects.size) return;
        clearSubjectHighlight();
      });
    }

    const buttons = panel.querySelectorAll(".skiprexa-highlight-toggle");
    for (const button of buttons) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const subject = button.getAttribute("data-subject");
        if (!subject) return;
        const nextSubjects = new Set(pinnedHighlightSubjects);
        if (nextSubjects.has(subject)) nextSubjects.delete(subject);
        else nextSubjects.add(subject);
        setPinnedHighlightSubjects(nextSubjects, panel);
      });
    }

    syncPinnedHighlightButtons(panel);
  }

  // ── Attendance math ──────────────────────────────────────────────

  function minTotalForThreshold(missed, threshold) {
    return Math.ceil(missed / (1 - threshold));
  }

  function computeDangerZone(missed, totalHeld, threshold) {
    // missed here = only countable (red) hours
    if (!totalHeld || totalHeld <= 0) return null;
    const attended = totalHeld - missed;
    const currentPct = (attended / totalHeld) * 100;
    const maxAllowedAbsent = Math.floor(totalHeld * (1 - threshold));
    const canStillMiss = maxAllowedAbsent - missed;

    let level;
    if (canStillMiss <= 0) level = "critical";
    else if (canStillMiss <= 2) level = "warning";
    else level = "safe";

    return { currentPct, canStillMiss, level, attended };
  }

  // ── Danger badge ─────────────────────────────────────────────────

  function dangerBadgeHtml(danger) {
    if (!danger) return "";

    const config = {
      safe: { bg: "rgba(16,185,129,0.08)", border: "rgba(16,185,129,0.25)", color: "#059669", label: "SAFE" },
      warning: { bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.3)", color: "#d97706", label: "WARN" },
      critical: { bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.25)", color: "#dc2626", label: "CRIT" }
    };
    const c = config[danger.level];
    const pctStr = danger.currentPct.toFixed(1);

    const skipStr = danger.canStillMiss > 0
      ? `${danger.canStillMiss} left`
      : danger.canStillMiss === 0
        ? "At limit"
        : `Over by ${Math.abs(danger.canStillMiss)}`;

    return `
      <div class="skiprexa-badge" style="--badge-bg:${c.bg};--badge-border:${c.border};--badge-color:${c.color};">
        <span class="skiprexa-badge-dot"></span>
        <span class="skiprexa-badge-label">${c.label}</span>
        <span class="skiprexa-badge-sep">|</span>
        <span>${pctStr}%</span>
        <span class="skiprexa-badge-sep">·</span>
        <span>${skipStr}</span>
      </div>
    `;
  }

  // ── Panel shell ──────────────────────────────────────────────────

  function getOrCreatePanel(anchor) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
    }

    if (anchor === document.body) {
      document.body.appendChild(panel);
    } else {
      anchor.insertAdjacentElement("afterend", panel);
    }
    return panel;
  }

  // ── Handlers ─────────────────────────────────────────────────────

  function onThresholdChange(value) {
    attendanceThreshold = value === "80" ? 0.80 : 0.75;
    savePersistedState();
    lastDigest = "";
    renderSummary();
  }

  function onTotalClassesInput(subject, value) {
    const num = parseInt(value, 10);
    if (!value || Number.isNaN(num) || num <= 0) delete totalClassesMap[subject];
    else totalClassesMap[subject] = num;
    savePersistedState();
    updateDangerBadges();
  }

  function updateDangerBadges() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const rows = panel.querySelectorAll("tr[data-subject]");
    for (const row of rows) {
      // data-missed only contains countable (red) hours
      const missed = parseInt(row.getAttribute("data-missed") || "0", 10);
      const subject = row.getAttribute("data-subject");
      const totalHeld = totalClassesMap[subject] || 0;

      const minTotalCell = row.querySelector(".skiprexa-min-total");
      if (minTotalCell) minTotalCell.textContent = minTotalForThreshold(missed, attendanceThreshold);

      const badgeSlot = row.querySelector(".skiprexa-danger-slot");
      if (badgeSlot) {
        const danger = computeDangerZone(missed, totalHeld, attendanceThreshold);
        const nextHtml = dangerBadgeHtml(danger);
        if (badgeSlot.innerHTML !== nextHtml) badgeSlot.innerHTML = nextHtml;
      }
    }
  }

  // ── Main render ──────────────────────────────────────────────────

  function renderSummary() {
    if (!isSubmitTriggered) return;

    const entries = parseLeaveEntries();
    ensureSubjectNamesForCurrentClass(entries);
    const digest = JSON.stringify(entries);
    if (digest === lastDigest) return;
    lastDigest = digest;

    const panel = getOrCreatePanel(findAnchorElement());
    const hasRenderedBefore = panel.getAttribute("data-rendered") === "true";
    clearSubjectHighlight();

    if (!entries.length) {
      panel.innerHTML = `
        <div style="font-family:'DM Sans',system-ui,sans-serif;padding:20px;">
          <div style="font-size:15px;font-weight:700;letter-spacing:-0.02em;">SkipREXA</div>
          <div style="margin-top:6px;color:#6b7280;font-size:13px;">No missed class hours found for the selected class.</div>
        </div>`;
      return;
    }

    const subjectRows = groupBySubject(entries);
    const thresholdInt = Math.round(attendanceThreshold * 100);
    const is75 = attendanceThreshold === 0.75;

    const leaveTypeLabel = {
      leave: { label: "Absent", color: "#dc2626" },
      approved_leave: { label: "Approved", color: "#059669" },
      duty_leave: { label: "Duty", color: "#d97706" }
    };

    const rowsHtml = subjectRows.map((entry, idx) => {
      const minTotal = minTotalForThreshold(entry.missedHours, attendanceThreshold);
      const totalHeld = totalClassesMap[entry.subject] || 0;
      const danger = totalHeld > 0 ? computeDangerZone(entry.missedHours, totalHeld, attendanceThreshold) : null;
      const delay = idx * 30;
      const subjectMeta = getSubjectDisplayMeta(entry.subject);

      const sessionListHtml = entry.sessions.map((s) => {
        const lt = leaveTypeLabel[s.leaveType] || leaveTypeLabel.leave;
        return `
          <div class="skiprexa-session-row">
            <span class="skiprexa-session-date">${s.date}</span>
            <span class="skiprexa-session-hour">H${s.hour}</span>
            <span class="skiprexa-session-type" style="color:${lt.color};">${lt.label}</span>
          </div>`;
      }).join("");

      // Breakdown pill: only show if there are any non-countable entries
      const breakdownHtml = entry.infoHours > 0
        ? `<div class="skiprexa-breakdown">
            <span class="skiprexa-breakdown-chip skiprexa-breakdown-red">${entry.missedHours} Absent</span>
            ${entry.infoHours > 0 ? `<span class="skiprexa-breakdown-chip skiprexa-breakdown-green">${entry.infoHours} Not Counted</span>` : ""}
          </div>`
        : "";

      return `
        <tr data-subject="${entry.subject}" data-missed="${entry.missedHours}" class="skiprexa-row${hasRenderedBefore ? " skiprexa-row-static" : ""}" style="${hasRenderedBefore ? "" : `animation-delay:${delay}ms;`} ">
          <td class="skiprexa-cell skiprexa-cell-subject">
            <div class="skiprexa-subject-top">
              <details class="skiprexa-details">
                <summary class="skiprexa-summary">
                  <span class="skiprexa-summary-main">
                    <span class="skiprexa-chevron"></span>
                    <span class="skiprexa-subject-heading">
                      <span class="skiprexa-subject-name">${escapeHtml(subjectMeta.name || entry.subject)}</span>
                      ${subjectMeta.name ? `<span class="skiprexa-subject-meta">(${escapeHtml(entry.subject)})</span>` : ""}
                    </span>
                  </span>
                  <button type="button" class="skiprexa-highlight-toggle" data-subject="${entry.subject}" aria-pressed="false" title="Highlight ${escapeHtml(subjectMeta.label)} on timetable">
                    <span class="skiprexa-highlight-toggle-track">
                      <span class="skiprexa-highlight-toggle-thumb"></span>
                    </span>
                    <span class="skiprexa-highlight-toggle-label">Pin</span>
                  </button>
                </summary>
                <div class="skiprexa-session-list">${sessionListHtml}</div>
              </details>
            </div>
            ${breakdownHtml}
            <div class="skiprexa-danger-slot">${dangerBadgeHtml(danger)}</div>
          </td>
          <td class="skiprexa-cell skiprexa-cell-num skiprexa-missed-val">${entry.missedHours}</td>
          <td class="skiprexa-cell skiprexa-cell-num skiprexa-min-total">${minTotal}</td>
          <td class="skiprexa-cell skiprexa-cell-num">
            <input type="number" min="1" class="skiprexa-total-input" data-subject="${entry.subject}"
              value="${totalHeld || ""}" placeholder="—" />
          </td>
        </tr>`;
    }).join("");

    panel.className = "";
    panel.innerHTML = `
      <style>
        /* ── Foundation ──────────────────────────────── */
        #${PANEL_ID} {
          --sx-font: 'DM Sans', system-ui, -apple-system, sans-serif;
          --sx-mono: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
          --sx-bg: #fdfdfd;
          --sx-surface: #ffffff;
          --sx-border: #e5e7eb;
          --sx-border-subtle: #f0f0f0;
          --sx-text: #111827;
          --sx-text-secondary: #6b7280;
          --sx-text-tertiary: #9ca3af;
          --sx-accent: #1e3a5f;
          --sx-accent-light: #e0ecf7;
          --sx-red: #b91c1c;
          --sx-red-bg: #fef2f2;
          --sx-red-border: #fee2e2;

          margin-top: 8px;
          padding: 0;
          border: 1px solid var(--sx-border);
          border-radius: 10px;
          background: var(--sx-bg);
          font-family: var(--sx-font);
          font-size: 13px;
          line-height: 1.45;
          max-width: 1120px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 6px 16px rgba(0,0,0,0.03);
          overflow: hidden;
        }

        /* ── Header ──────────────────────────────────── */
        #${PANEL_ID} .skiprexa-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 14px 18px;
          border-bottom: 1px solid var(--sx-border);
          background:
            radial-gradient(circle at top left, rgba(30,58,95,0.06), transparent 40%),
            var(--sx-surface);
          flex-wrap: wrap;
        }
        #${PANEL_ID} .skiprexa-title {
          font-size: 14px;
          font-weight: 700;
          letter-spacing: -0.03em;
          color: var(--sx-text);
        }
        #${PANEL_ID} .skiprexa-title span {
          color: var(--sx-text-tertiary);
          font-weight: 500;
          font-size: 12px;
          margin-left: 6px;
          letter-spacing: 0;
        }
        #${PANEL_ID} .skiprexa-controls {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        #${PANEL_ID} .skiprexa-highlight-help {
          width: 100%;
          margin-top: 2px;
          padding: 8px 10px;
          border: 1px dashed rgba(30,58,95,0.18);
          border-radius: 8px;
          background: rgba(224,236,247,0.42);
          color: var(--sx-text-secondary);
          font-size: 12px;
          line-height: 1.45;
        }
        #${PANEL_ID} .skiprexa-highlight-help strong {
          color: var(--sx-accent);
        }

        /* ── Threshold toggle ────────────────────────── */
        #${PANEL_ID} .skiprexa-toggle {
          display: inline-flex;
          border-radius: 6px;
          overflow: hidden;
          border: 1px solid var(--sx-border);
          background: #f9fafb;
        }
        #${PANEL_ID} .skiprexa-toggle-btn {
          padding: 4px 14px;
          font-family: var(--sx-mono);
          font-size: 11px;
          font-weight: 700;
          border: none;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.4,0,0.2,1);
          background: transparent;
          color: var(--sx-text-tertiary);
          position: relative;
        }
        #${PANEL_ID} .skiprexa-toggle-btn.active {
          background: var(--sx-accent);
          color: #fff;
          box-shadow: 0 1px 2px rgba(0,0,0,0.15);
        }
        #${PANEL_ID} .skiprexa-toggle-btn:hover:not(.active) {
          background: #f3f4f6;
          color: var(--sx-text-secondary);
        }

        /* ── Total missed pill ───────────────────────── */
        #${PANEL_ID} .skiprexa-total-pill {
          font-family: var(--sx-mono);
          font-size: 11px;
          font-weight: 700;
          padding: 4px 12px;
          border-radius: 999px;
          background: var(--sx-red-bg);
          color: var(--sx-red);
          border: 1px solid var(--sx-red-border);
          letter-spacing: 0.02em;
        }

        /* ── Table ───────────────────────────────────── */
        #${PANEL_ID} table {
          width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
        }
        #${PANEL_ID} thead th {
          padding: 9px 14px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--sx-text-tertiary);
          background: #fafbfc;
          border-bottom: 1px solid var(--sx-border);
          text-align: left;
        }
        #${PANEL_ID} thead th:not(:first-child) {
          text-align: center;
        }
        #${PANEL_ID} .skiprexa-cell {
          padding: 10px 14px;
          border-bottom: 1px solid var(--sx-border-subtle);
          vertical-align: top;
        }
        #${PANEL_ID} .skiprexa-cell-num {
          text-align: center;
          vertical-align: middle;
        }
        #${PANEL_ID} .skiprexa-missed-val {
          font-family: var(--sx-mono);
          font-weight: 700;
          font-size: 15px;
          color: var(--sx-red);
        }
        #${PANEL_ID} .skiprexa-min-total {
          font-family: var(--sx-mono);
          font-weight: 700;
          font-size: 14px;
          color: var(--sx-accent);
        }

        /* ── Row animation ───────────────────────────── */
        @keyframes skiprexa-row-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        #${PANEL_ID} .skiprexa-row {
          animation: skiprexa-row-in 0.25s cubic-bezier(0.4,0,0.2,1) both;
          transition: background-color 0.15s ease;
        }
        #${PANEL_ID} .skiprexa-row.skiprexa-row-static {
          animation: none;
        }
        #${PANEL_ID} .skiprexa-row:hover {
          background: #f8fafb;
        }
        #${PANEL_ID} .skiprexa-row.is-pinned-highlight {
          background: linear-gradient(90deg, rgba(22,163,74,0.06), rgba(22,163,74,0.015));
        }
        #${PANEL_ID} .skiprexa-row:last-child .skiprexa-cell {
          border-bottom: none;
        }

        /* ── Subject details ─────────────────────────── */
        #${PANEL_ID} .skiprexa-subject-top {
          display: block;
        }
        #${PANEL_ID} .skiprexa-details {
          display: block;
          min-width: 0;
        }
        #${PANEL_ID} .skiprexa-details > summary {
          cursor: pointer;
          font-weight: 600;
          color: var(--sx-text);
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          list-style: none;
          user-select: none;
        }
        #${PANEL_ID} .skiprexa-summary-main {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }
        #${PANEL_ID} .skiprexa-details > summary::-webkit-details-marker { display: none; }
        #${PANEL_ID} .skiprexa-details > summary::marker { content: ""; }

        #${PANEL_ID} .skiprexa-chevron {
          display: inline-block;
          width: 16px;
          height: 16px;
          border-radius: 3px;
          background: var(--sx-accent-light);
          position: relative;
          transition: transform 0.2s cubic-bezier(0.4,0,0.2,1), background 0.2s;
          flex-shrink: 0;
        }
        #${PANEL_ID} .skiprexa-chevron::after {
          content: "";
          position: absolute;
          top: 50%; left: 50%;
          width: 0; height: 0;
          border-style: solid;
          border-width: 3.5px 0 3.5px 5px;
          border-color: transparent transparent transparent var(--sx-accent);
          transform: translate(-30%, -50%);
          transition: border-color 0.2s;
        }
        #${PANEL_ID} .skiprexa-details[open] .skiprexa-chevron {
          transform: rotate(90deg);
          background: var(--sx-accent);
        }
        #${PANEL_ID} .skiprexa-details[open] .skiprexa-chevron::after {
          border-left-color: #fff;
        }
        #${PANEL_ID} .skiprexa-subject-heading {
          display: inline-flex;
          align-items: baseline;
          gap: 8px;
          min-width: 0;
          flex-wrap: wrap;
        }
        #${PANEL_ID} .skiprexa-subject-name {
          font-size: 13px;
          font-weight: 700;
          letter-spacing: -0.01em;
          color: var(--sx-text);
        }
        #${PANEL_ID} .skiprexa-subject-meta {
          font-family: var(--sx-mono);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.03em;
          color: var(--sx-text-tertiary);
        }
        #${PANEL_ID} .skiprexa-highlight-toggle {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 4px 10px 4px 8px;
          border: 1px solid #d5dde8;
          border-radius: 999px;
          background: linear-gradient(180deg, #ffffff, #f7fafc);
          color: #6b7280;
          font-family: var(--sx-mono);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          cursor: pointer;
          transition: transform 0.16s ease, border-color 0.16s ease, background-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
          box-shadow: 0 1px 2px rgba(15,23,42,0.04);
          flex: 0 0 auto;
          margin-top: 0;
        }
        #${PANEL_ID} .skiprexa-highlight-toggle:hover {
          transform: translateY(-1px);
          color: #334155;
          border-color: #c3d0df;
          background: linear-gradient(180deg, #ffffff, #f3f7fb);
        }
        #${PANEL_ID} .skiprexa-highlight-toggle:focus-visible {
          outline: none;
          box-shadow: 0 0 0 3px rgba(30,58,95,0.12);
        }
        #${PANEL_ID} .skiprexa-highlight-toggle-track {
          width: 34px;
          height: 20px;
          border-radius: 999px;
          background: #e7edf3;
          border: 1px solid #d4dde8;
          display: inline-flex;
          align-items: center;
          padding: 2px;
          transition: background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
          box-sizing: border-box;
        }
        #${PANEL_ID} .skiprexa-highlight-toggle-thumb {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: linear-gradient(180deg, #ffffff, #f8fafc);
          box-shadow: 0 1px 2px rgba(15,23,42,0.18);
          transform: translateX(0);
          transition: transform 0.18s cubic-bezier(0.4,0,0.2,1), background-color 0.16s ease;
        }
        #${PANEL_ID} .skiprexa-highlight-toggle-label {
          line-height: 1;
        }
        #${PANEL_ID} .skiprexa-highlight-toggle.is-active {
          background: linear-gradient(180deg, rgba(240,253,244,0.95), rgba(232,249,238,0.98));
          border-color: rgba(34,197,94,0.32);
          color: #15803d;
          box-shadow: 0 0 0 4px rgba(34,197,94,0.08);
        }
        #${PANEL_ID} .skiprexa-highlight-toggle.is-active .skiprexa-highlight-toggle-track {
          background: #dff7e7;
          border-color: #9ad9ae;
          box-shadow: inset 0 0 0 1px rgba(22,163,74,0.06);
        }
        #${PANEL_ID} .skiprexa-highlight-toggle.is-active .skiprexa-highlight-toggle-thumb {
          transform: translateX(14px);
          background: linear-gradient(180deg, #ffffff, #f0fdf4);
        }

        /* ── Session list ────────────────────────────── */
        #${PANEL_ID} .skiprexa-session-list {
          margin-top: 8px;
          padding: 8px 10px;
          border-radius: 6px;
          background: #f9fafb;
          border: 1px solid var(--sx-border-subtle);
        }
        #${PANEL_ID} .skiprexa-session-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 6px;
          padding: 3px 0;
          font-size: 12px;
          color: var(--sx-text-secondary);
        }
        #${PANEL_ID} .skiprexa-session-row:not(:last-child) {
          border-bottom: 1px solid #f0f0f0;
        }
        #${PANEL_ID} .skiprexa-session-date {
          font-weight: 500;
          flex: 1;
        }
        #${PANEL_ID} .skiprexa-session-hour {
          font-family: var(--sx-mono);
          font-size: 11px;
          font-weight: 500;
          color: var(--sx-text-tertiary);
        }
        #${PANEL_ID} .skiprexa-session-type {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          min-width: 52px;
          text-align: right;
        }
        /* ── Breakdown chips ─────────────────────────── */
        #${PANEL_ID} .skiprexa-breakdown {
          display: flex;
          gap: 5px;
          margin-top: 6px;
          flex-wrap: wrap;
        }
        #${PANEL_ID} .skiprexa-breakdown-chip {
          font-family: var(--sx-mono);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.04em;
          padding: 2px 8px;
          border-radius: 4px;
        }
        #${PANEL_ID} .skiprexa-breakdown-red {
          background: rgba(220,38,38,0.07);
          border: 1px solid rgba(220,38,38,0.2);
          color: #dc2626;
        }
        #${PANEL_ID} .skiprexa-breakdown-green {
          background: rgba(5,150,105,0.07);
          border: 1px solid rgba(5,150,105,0.2);
          color: #059669;
        }

        /* ── Danger badge ────────────────────────────── */
        #${PANEL_ID} .skiprexa-badge {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          margin-top: 7px;
          padding: 3px 10px;
          border-radius: 5px;
          font-size: 10.5px;
          font-weight: 600;
          font-family: var(--sx-mono);
          letter-spacing: 0.02em;
          background: var(--badge-bg);
          border: 1px solid var(--badge-border);
          color: var(--badge-color);
          animation: skiprexa-badge-in 0.3s cubic-bezier(0.4,0,0.2,1) both;
        }
        @keyframes skiprexa-badge-in {
          from { opacity: 0; transform: scale(0.92); }
          to { opacity: 1; transform: scale(1); }
        }
        #${PANEL_ID} .skiprexa-badge-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: currentColor;
          flex-shrink: 0;
        }
        #${PANEL_ID} .skiprexa-badge-label {
          font-weight: 800;
          font-size: 9px;
          letter-spacing: 0.08em;
        }
        #${PANEL_ID} .skiprexa-badge-sep {
          opacity: 0.25;
          font-weight: 400;
        }

        /* ── Total held input ────────────────────────── */
        #${PANEL_ID} .skiprexa-total-input {
          width: 52px;
          padding: 5px 4px;
          border: 1px solid var(--sx-border);
          border-radius: 5px;
          text-align: center;
          font-family: var(--sx-mono);
          font-size: 13px;
          font-weight: 600;
          color: var(--sx-text);
          background: var(--sx-surface);
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
          -moz-appearance: textfield;
        }
        #${PANEL_ID} .skiprexa-total-input:focus {
          border-color: var(--sx-accent);
          box-shadow: 0 0 0 3px rgba(30,58,95,0.08);
        }
        #${PANEL_ID} .skiprexa-total-input::placeholder {
          color: var(--sx-text-tertiary);
          font-weight: 400;
        }
        #${PANEL_ID} .skiprexa-total-input::-webkit-inner-spin-button,
        #${PANEL_ID} .skiprexa-total-input::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }

        /* ── Footer ─────────────────────────────── */
        #${PANEL_ID} .skiprexa-footer {
          padding: 14px 18px;
          border-top: 2px solid var(--sx-border);
          background: #f0f4f8;
          display: flex;
          align-items: stretch;
          gap: 1px;
          border-bottom-left-radius: 10px;
          border-bottom-right-radius: 10px;
          overflow: hidden;
        }
        #${PANEL_ID} .skiprexa-footer-block {
          flex: 1;
          padding: 8px 14px;
          display: flex;
          flex-direction: column;
          gap: 3px;
          background: #f0f4f8;
        }
        #${PANEL_ID} .skiprexa-footer-block:not(:last-child) {
          border-right: 1px solid var(--sx-border);
        }
        #${PANEL_ID} .skiprexa-footer-label {
          font-family: var(--sx-mono);
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--sx-text-tertiary);
        }
        #${PANEL_ID} .skiprexa-footer-value {
          font-size: 13px;
          font-weight: 500;
          color: var(--sx-text-secondary);
          line-height: 1.4;
        }
        #${PANEL_ID} .skiprexa-footer-value strong {
          color: var(--sx-accent);
          font-weight: 700;
        }
        #${PANEL_ID} .skiprexa-footer-value.is-green {
          color: #059669;
          font-weight: 600;
        }

        /* ── Tile highlight ──────────────────────────── */
        .${TILE_HIGHLIGHT_CLASS} {
          outline: 2px solid #16a34a !important;
          outline-offset: -2px;
          box-shadow: inset 0 0 0 999px rgba(34, 197, 94, 0.16);
          transition: box-shadow 0.16s ease, outline-color 0.16s ease;
        }
        .${TILE_HIGHLIGHT_INFO_CLASS} {
          outline: 2px solid #3b82f6 !important;
          outline-offset: -2px;
          box-shadow: inset 0 0 0 999px rgba(59, 130, 246, 0.1);
          transition: box-shadow 0.16s ease, outline-color 0.16s ease;
        }
      </style>

      <div class="skiprexa-header">
        <div class="skiprexa-title">SkipREXA <span>Attendance Analyzer</span></div>
        <div class="skiprexa-controls">
          <div class="skiprexa-toggle">
            <button class="skiprexa-toggle-btn ${is75 ? "active" : ""}" data-threshold="75">75%</button>
            <button class="skiprexa-toggle-btn ${!is75 ? "active" : ""}" data-threshold="80">80%</button>
          </div>
          <div class="skiprexa-total-pill">${subjectRows.reduce((s,r)=>s+r.missedHours,0)} absent</div>
        </div>
        <div class="skiprexa-highlight-help">Use <strong>Pin</strong> on a subject to keep its timetable cells highlighted while you scroll.</div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Subject</th>
            <th style="width:80px;">Missed</th>
            <th style="width:120px;">Min Total for ${thresholdInt}%</th>
            <th style="width:100px;">Total Held</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>

      <div class="skiprexa-footer">
        <div class="skiprexa-footer-block">
          <div class="skiprexa-footer-label">What is this column?</div>
          <div class="skiprexa-footer-value"><strong>Min Total for ${thresholdInt}%</strong> = the minimum number of total classes that must be held for your current absences to still be within ${thresholdInt}% attendance</div>
        </div>
        <div class="skiprexa-footer-block">
          <div class="skiprexa-footer-label">Unlock danger zone</div>
          <div class="skiprexa-footer-value">Type the classes held so far into <strong>Total Held</strong> — you'll see if you're safe, at risk, or over the limit</div>
        </div>
        <div class="skiprexa-footer-block" style="flex:0 0 auto;min-width:160px;">
          <div class="skiprexa-footer-label">Leave types</div>
          <div class="skiprexa-footer-value is-green">● Approved &amp; Duty leave<br>are NOT counted against you</div>
        </div>
      </div>
    `;

    panel.setAttribute("data-rendered", "true");
    patchSubjectLabels(panel);
    attachSubjectInteractions(panel);
    attachThresholdToggle(panel);
    attachTotalInputListeners(panel);
    if (pinnedHighlightSubjects.size) {
      const availableSubjects = new Set(
        Array.from(panel.querySelectorAll(".skiprexa-highlight-toggle[data-subject]")).map((button) => button.getAttribute("data-subject")).filter(Boolean)
      );
      const nextPinnedSubjects = new Set(Array.from(pinnedHighlightSubjects).filter((subject) => availableSubjects.has(subject)));
      setPinnedHighlightSubjects(nextPinnedSubjects, panel);
    }
  }

  function attachThresholdToggle(panel) {
    const buttons = panel.querySelectorAll(".skiprexa-toggle-btn");
    for (const btn of buttons) {
      btn.addEventListener("click", () => onThresholdChange(btn.getAttribute("data-threshold")));
    }
  }

  function attachTotalInputListeners(panel) {
    const inputs = panel.querySelectorAll(".skiprexa-total-input");
    for (const input of inputs) {
      const subject = input.getAttribute("data-subject");
      input.addEventListener("input", () => onTotalClassesInput(subject, input.value));
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  function scheduleRender(delay = 250) {
    if (!isSubmitTriggered) return;
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(renderSummary, delay);
  }

  function stopLateUpdateObserver() {
    if (lateUpdateObserver) {
      lateUpdateObserver.disconnect();
      lateUpdateObserver = null;
    }
    if (lateUpdateObserverTimer) {
      window.clearTimeout(lateUpdateObserverTimer);
      lateUpdateObserverTimer = null;
    }
  }

  function startLateUpdateObserver(windowMs = 8000) {
    stopLateUpdateObserver();

    lateUpdateObserver = new MutationObserver((mutations) => {
      const shouldRender = mutations.some((mutation) => {
        const target = mutation.target;
        if (target instanceof Element && target.closest(`#${PANEL_ID}`)) return false;
        for (const node of mutation.addedNodes) {
          if (node instanceof Element && node.closest?.(`#${PANEL_ID}`)) continue;
          return true;
        }
        for (const node of mutation.removedNodes) {
          if (node instanceof Element && node.closest?.(`#${PANEL_ID}`)) continue;
          return true;
        }
        return false;
      });
      if (shouldRender) scheduleRender(120);
    });

    lateUpdateObserver.observe(document.body, { childList: true, subtree: true });
    lateUpdateObserverTimer = window.setTimeout(stopLateUpdateObserver, windowMs);
  }

  function scheduleRenderBurst() {
    if (!isSubmitTriggered) return;
    startLateUpdateObserver();
    scheduleRender(250);
    window.setTimeout(() => renderSummary(), 700);
    window.setTimeout(() => renderSummary(), 1400);
    window.setTimeout(() => renderSummary(), 2500);
    window.setTimeout(() => renderSummary(), 4000);
  }

  function attachSubmitListeners() {
    document.addEventListener("submit", () => {
      isSubmitTriggered = true;
      scheduleRenderBurst();
    }, true);
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const submitTrigger = target.closest('input[type="submit"],button[type="submit"],button[name*="submit"],input[name*="submit"]');
      if (!submitTrigger) return;
      isSubmitTriggered = true;
      scheduleRenderBurst();
    }, true);
  }

  attachSubmitListeners();
  if (isSubmitTriggered) scheduleRenderBurst();
})();
