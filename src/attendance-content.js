(() => {
  const PANEL_ID = "skiprexa-attendance-summary";
  const IS_ATTENDANCE_PAGE = /\/Leave\.asp$/i.test(window.location.pathname);
  if (!IS_ATTENDANCE_PAGE) {
    document.getElementById(PANEL_ID)?.remove();
    return;
  }

  if (window.skiprexaAttendanceHelperLoaded) return;
  window.skiprexaAttendanceHelperLoaded = true;

  const TILE_HIGHLIGHT_CLASS = "skiprexa-subject-tile-highlight";
  const TILE_HIGHLIGHT_INFO_CLASS = "skiprexa-subject-tile-highlight-info";
  const STORAGE_KEY = "skiprexa-attendance-data";
  const ATTENDANCE_UI_STORAGE_KEY = "skiprexa_attendance_ui_enabled";
  const SUBJECT_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14;
  let lastDigest = "";
  let renderTimer = null;
  let lateUpdateObserver = null;
  let lateUpdateObserverTimer = null;
  let isSubmitTriggered = new URLSearchParams(window.location.search).has("code");
  let attendanceUiEnabled = true;
  let highlightedCells = [];
  let pinnedHighlightSubjects = new Set();
  let expandedSubjects = new Set();
  let analyzerCollapsed = false;
  let pinTipSeen = false;
  let infoDismissListenerAttached = false;
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
      if (Array.isArray(data.pinnedSubjects)) pinnedHighlightSubjects = new Set(data.pinnedSubjects.map(normalizeSubjectToken).filter(Boolean));
      if (Array.isArray(data.expandedSubjects)) expandedSubjects = new Set(data.expandedSubjects.map(normalizeSubjectToken).filter(Boolean));
      analyzerCollapsed = data.analyzerCollapsed === true;
      pinTipSeen = data.pinTipSeen === true;
    } catch { /* ignore */ }
  }

  function savePersistedState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        threshold: attendanceThreshold,
        totalClasses: totalClassesMap,
        subjectNameCache,
        pinnedSubjects: Array.from(pinnedHighlightSubjects),
        expandedSubjects: Array.from(expandedSubjects),
        analyzerCollapsed,
        pinTipSeen
      }));
    } catch { /* ignore */ }
  }

  loadPersistedState();

  async function loadAttendanceUiSetting() {
    try {
      if (typeof chrome === "undefined" || !chrome.storage?.local) return;
      const data = await chrome.storage.local.get([ATTENDANCE_UI_STORAGE_KEY]);
      attendanceUiEnabled = data[ATTENDANCE_UI_STORAGE_KEY] !== false;
    } catch {
      attendanceUiEnabled = true;
    }
  }

  function removeAttendancePanel() {
    window.clearTimeout(renderTimer);
    stopLateUpdateObserver();
    clearSubjectHighlight();
    document.getElementById(PANEL_ID)?.remove();
    lastDigest = "";
  }

  function subscribeAttendanceUiSetting() {
    if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[ATTENDANCE_UI_STORAGE_KEY]) return;
      attendanceUiEnabled = changes[ATTENDANCE_UI_STORAGE_KEY].newValue !== false;
      if (!attendanceUiEnabled) {
        removeAttendancePanel();
        return;
      }
      injectFont();
      if (isSubmitTriggered) scheduleRenderBurst();
    });
  }

  // ── Inject typography ────────────────────────────────────────────
  function injectFont() {
    if (document.getElementById("skiprexa-font-link")) return;
    const link = document.createElement("link");
    link.id = "skiprexa-font-link";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,500;0,9..40,700&family=JetBrains+Mono:wght@500;700&display=swap";
    document.head.appendChild(link);
  }

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

  async function fetchSubjectMapForClass(classCode, neededSubjects = null) {
    const examIds = await fetchExamIdsForClass(classCode);
    if (!examIds.length) return null;

    const subjects = {};
    const sourceExamIds = [];
    const hasNeededSubjects = () => (
      neededSubjects &&
      Array.from(neededSubjects).every((subject) => subjects[subject])
    );

    for (const examId of examIds) {
      const response = await fetch(`Mark.asp?code=${encodeURIComponent(classCode)}&E_ID=${encodeURIComponent(examId)}`, {
        credentials: "include",
        cache: "no-store"
      });
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const match = findSubjectMapTable(doc);
      if (!match) continue;

      let foundInExam = false;
      for (const row of match.rows) {
        const fullCode = normalizeSubjectToken(row[1]);
        const shortCode = extractSubject(fullCode);
        const name = cleanText(row[2]);
        if (!shortCode || !name) continue;
        subjects[shortCode] = { fullCode, name };
        foundInExam = true;
      }

      if (foundInExam) sourceExamIds.push(examId);
      if (hasNeededSubjects()) break;
    }

    if (!Object.keys(subjects).length) return null;

    return {
      fetchedAt: Date.now(),
      examId: sourceExamIds[0] || "",
      examIds: sourceExamIds,
      subjects
    };
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

    const promise = fetchSubjectMapForClass(classCode, neededSubjects)
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
        cell.classList.add(TILE_HIGHLIGHT_CLASS);       // electric cyan — selected subject
      } else {
        cell.classList.add(TILE_HIGHLIGHT_INFO_CLASS);  // violet — excluded leave
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
      button.setAttribute("aria-label", isActive ? `Unpin ${subjectLabel}` : `Pin ${subjectLabel}`);
      button.setAttribute("title", isActive ? `Unpin ${subjectLabel}` : `Pin ${subjectLabel} on timetable`);
      const label = button.querySelector(".skiprexa-highlight-toggle-label");
      if (label) label.textContent = isActive ? "Pinned" : "Pin subject";
    }
  }

  function setPinnedHighlightSubjects(subjects, panel) {
    pinnedHighlightSubjects = new Set(subjects || []);
    savePersistedState();
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
        if (!pinTipSeen) {
          pinTipSeen = true;
          panel.querySelector(".skiprexa-highlight-help")?.remove();
        }
        setPinnedHighlightSubjects(nextSubjects, panel);
      });
    }

    const details = panel.querySelectorAll("details.skiprexa-details[data-subject]");
    for (const detail of details) {
      detail.addEventListener("toggle", () => {
        const subject = detail.getAttribute("data-subject");
        if (!subject) return;
        if (detail.open) expandedSubjects.add(subject);
        else expandedSubjects.delete(subject);
        savePersistedState();
      });
    }

    syncPinnedHighlightButtons(panel);
  }

  // ── Attendance math ──────────────────────────────────────────────

  function minTotalForThreshold(missed, threshold) {
    return Math.ceil((missed / (1 - threshold)) - 1e-9);
  }

  function computeDangerZone(missed, totalHeld, threshold) {
    if (totalHeld === null || totalHeld === undefined) return null;
    if (!Number.isInteger(totalHeld) || totalHeld <= 0 || totalHeld < missed) {
      return {
        state: "invalid",
        title: "Check classes held",
        detail: `Enter a whole number of at least ${missed}`,
        attention: true,
        isValid: false
      };
    }

    const attended = totalHeld - missed;
    const currentPct = (attended / totalHeld) * 100;
    const canStillMiss = Math.floor(((attended / threshold) - totalHeld) + 1e-9);
    const totalNeeded = minTotalForThreshold(missed, threshold);
    const classesRequired = Math.max(0, totalNeeded - totalHeld);
    const pctLabel = `${currentPct.toFixed(1)}% attendance`;

    if (classesRequired > 0) {
      return {
        state: "below",
        title: `${classesRequired} more ${classesRequired === 1 ? "class" : "classes"} required`,
        detail: `Below target · ${pctLabel}`,
        attention: true,
        isValid: true,
        currentPct,
        canStillMiss
      };
    }

    if (canStillMiss === 0) {
      return {
        state: "limit",
        title: "At the limit",
        detail: `${pctLabel} · Attend the next class`,
        attention: true,
        isValid: true,
        currentPct,
        canStillMiss
      };
    }

    if (canStillMiss <= 2) {
      return {
        state: "risk",
        title: `${canStillMiss} ${canStillMiss === 1 ? "class" : "classes"} of buffer`,
        detail: `At risk · ${pctLabel}`,
        attention: true,
        isValid: true,
        currentPct,
        canStillMiss
      };
    }

    return {
      state: "safe",
      title: `Safe by ${canStillMiss} classes`,
      detail: `${pctLabel} · Still within the ${Math.round(threshold * 100)}% target`,
      attention: false,
      isValid: true,
      currentPct,
      canStillMiss
    };
  }

  function attendanceOutcomeHtml(outcome) {
    const result = outcome || {
      state: "pending",
      title: "Enter classes held",
      detail: "See what this subject needs",
      attention: false
    };
    return `
      <div class="skiprexa-outcome is-${result.state}" data-state="${result.state}" data-attention="${result.attention ? "true" : "false"}" aria-live="polite">
        <span class="skiprexa-outcome-title">${escapeHtml(result.title)}</span>
        <span class="skiprexa-outcome-detail">${escapeHtml(result.detail)}</span>
      </div>
    `;
  }

  function infoTipHtml(id, title, message, alignment = "") {
    const alignmentClass = alignment ? ` skiprexa-info-tip--${alignment}` : "";
    return `
      <span class="skiprexa-info-tip${alignmentClass}">
        <button type="button" class="skiprexa-info-button" aria-label="About ${escapeHtml(title)}" aria-describedby="${escapeHtml(id)}" aria-expanded="false">
          <span aria-hidden="true">i</span>
        </button>
        <span id="${escapeHtml(id)}" class="skiprexa-tooltip" role="tooltip">
          <span class="skiprexa-tooltip-title">${escapeHtml(title)}</span>
          <span class="skiprexa-tooltip-copy">${escapeHtml(message)}</span>
        </span>
      </span>`;
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
      anchor.insertAdjacentElement("beforebegin", panel);
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
    const trimmed = String(value || "").trim();
    if (!trimmed) delete totalClassesMap[subject];
    else {
      const num = Number(trimmed);
      if (Number.isNaN(num)) delete totalClassesMap[subject];
      else totalClassesMap[subject] = num;
    }
    savePersistedState();
    updateDangerBadges();
  }

  function getStoredTotal(subject) {
    return Object.prototype.hasOwnProperty.call(totalClassesMap, subject)
      ? Number(totalClassesMap[subject])
      : null;
  }

  function analyzerSummaryText(rows) {
    let entered = 0;
    let attention = 0;
    for (const row of rows) {
      const outcome = computeDangerZone(row.missedHours, getStoredTotal(row.subject), attendanceThreshold);
      if (!outcome) continue;
      entered += 1;
      if (outcome.attention) attention += 1;
    }

    if (!entered) return `Enter classes held for ${rows.length} ${rows.length === 1 ? "subject" : "subjects"}`;
    if (attention) return `${attention} ${attention === 1 ? "subject needs" : "subjects need"} attention`;
    if (entered < rows.length) {
      const remaining = rows.length - entered;
      return `${remaining} ${remaining === 1 ? "subject still needs" : "subjects still need"} totals`;
    }
    return "All subjects are on track";
  }

  function updatePanelSummary(panel) {
    const rows = Array.from(panel.querySelectorAll("tr[data-subject]")).map((row) => ({
      subject: row.getAttribute("data-subject") || "",
      missedHours: Number(row.getAttribute("data-missed") || 0)
    }));
    const summary = panel.querySelector(".skiprexa-title-summary");
    if (summary) summary.textContent = `· ${analyzerSummaryText(rows)}`;
  }

  function updateDangerBadges() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const rows = panel.querySelectorAll("tr[data-subject]");
    for (const row of rows) {
      // data-missed only contains countable (red) hours
      const missed = parseInt(row.getAttribute("data-missed") || "0", 10);
      const subject = row.getAttribute("data-subject");
      const totalHeld = getStoredTotal(subject);

      const minTotalCell = row.querySelector(".skiprexa-min-total");
      if (minTotalCell) minTotalCell.textContent = minTotalForThreshold(missed, attendanceThreshold);

      const outcome = computeDangerZone(missed, totalHeld, attendanceThreshold);
      const outcomeSlot = row.querySelector(".skiprexa-outcome-slot");
      if (outcomeSlot) {
        const nextHtml = attendanceOutcomeHtml(outcome);
        if (outcomeSlot.innerHTML !== nextHtml) outcomeSlot.innerHTML = nextHtml;
      }

      const input = row.querySelector(".skiprexa-total-input");
      if (input) {
        const hasValue = input.value.trim() !== "";
        const isInvalid = hasValue && outcome?.isValid === false;
        input.classList.toggle("is-valid", hasValue && outcome?.isValid === true);
        input.classList.toggle("is-invalid", isInvalid);
        input.setAttribute("aria-invalid", String(isInvalid));
        input.setCustomValidity(isInvalid ? `Enter a whole number of classes held that is at least ${missed}.` : "");
      }
    }
    updatePanelSummary(panel);
  }

  // ── Main render ──────────────────────────────────────────────────

  function renderSummary() {
    if (!attendanceUiEnabled) {
      removeAttendancePanel();
      return;
    }
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
    const analyzerSummary = analyzerSummaryText(subjectRows);
    const missedTotal = subjectRows.reduce((sum, row) => sum + row.missedHours, 0);

    const leaveTypeLabel = {
      leave: { label: "Absent", color: "#64748b" },
      approved_leave: { label: "Approved", color: "#2563a6" },
      duty_leave: { label: "Duty leave", color: "#2563a6" }
    };

    const rowsHtml = subjectRows.map((entry, idx) => {
      const minTotal = minTotalForThreshold(entry.missedHours, attendanceThreshold);
      const totalHeld = getStoredTotal(entry.subject);
      const outcome = computeDangerZone(entry.missedHours, totalHeld, attendanceThreshold);
      const delay = idx * 30;
      const subjectMeta = getSubjectDisplayMeta(entry.subject);
      const isExpanded = expandedSubjects.has(entry.subject);

      const sessionListHtml = entry.sessions.map((s) => {
        const lt = leaveTypeLabel[s.leaveType] || leaveTypeLabel.leave;
        return `
          <div class="skiprexa-session-row">
            <span class="skiprexa-session-date">${s.date}</span>
            <span class="skiprexa-session-hour">H${s.hour}</span>
            <span class="skiprexa-session-type" style="color:${lt.color};">${lt.label}</span>
          </div>`;
      }).join("");

      const breakdownHtml = entry.infoHours > 0
        ? `<div class="skiprexa-breakdown">${entry.infoHours} approved or duty ${entry.infoHours === 1 ? "leave is" : "leaves are"} excluded</div>`
        : "";

      return `
        <tr data-subject="${entry.subject}" data-missed="${entry.missedHours}" class="skiprexa-row${hasRenderedBefore ? " skiprexa-row-static" : ""}" style="${hasRenderedBefore ? "" : `animation-delay:${delay}ms;`} ">
          <td class="skiprexa-cell skiprexa-cell-subject">
            <div class="skiprexa-subject-top">
              <details class="skiprexa-details" data-subject="${escapeHtml(entry.subject)}"${isExpanded ? " open" : ""}>
                <summary class="skiprexa-summary">
                  <span class="skiprexa-summary-main">
                    <span class="skiprexa-chevron"></span>
                    <span class="skiprexa-subject-heading">
                      <span class="skiprexa-subject-name">${escapeHtml(subjectMeta.name || entry.subject)}</span>
                      ${subjectMeta.name ? `<span class="skiprexa-subject-meta">(${escapeHtml(entry.subject)})</span>` : ""}
                    </span>
                  </span>
                </summary>
                <div class="skiprexa-session-list">${sessionListHtml}</div>
              </details>
              <button type="button" class="skiprexa-highlight-toggle" data-subject="${escapeHtml(entry.subject)}" aria-pressed="false" title="Pin ${escapeHtml(subjectMeta.label)} on timetable">
                <svg class="skiprexa-pin-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M7.2 2.8h5.6l-.7 4 2.3 2.3v1.4H5.6V9.1l2.3-2.3-.7-4Zm2.1 7.7h1.4v6.7L10 18.4l-.7-1.2v-6.7Z"/></svg>
                <span class="skiprexa-highlight-toggle-label">Pin subject</span>
              </button>
            </div>
            ${breakdownHtml}
          </td>
          <td class="skiprexa-cell skiprexa-cell-status" data-label="Status"><div class="skiprexa-outcome-slot">${attendanceOutcomeHtml(outcome)}</div></td>
          <td class="skiprexa-cell skiprexa-cell-num skiprexa-missed-val" data-label="Missed classes">${entry.missedHours}</td>
          <td class="skiprexa-cell skiprexa-cell-num skiprexa-min-total" data-label="Total needed">${minTotal}</td>
          <td class="skiprexa-cell skiprexa-cell-num skiprexa-input-cell" data-label="Classes held so far">
            <input type="number" min="1" step="1" inputmode="numeric" class="skiprexa-total-input${outcome?.isValid === false ? " is-invalid" : outcome?.isValid === true ? " is-valid" : ""}" data-subject="${escapeHtml(entry.subject)}"
              aria-label="Classes held so far for ${escapeHtml(subjectMeta.label)}" aria-invalid="${outcome?.isValid === false ? "true" : "false"}"
              value="${totalHeld ?? ""}" placeholder="Enter total" />
          </td>
        </tr>`;
    }).join("");

    panel.className = analyzerCollapsed ? "is-collapsed" : "";
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
          width: 100%;
          box-sizing: border-box;
          margin: 12px 0 10px;
          padding: 0;
          border: 1px solid var(--sx-border);
          border-radius: 8px;
          background: var(--sx-bg);
          font-family: var(--sx-font);
          font-size: 13px;
          line-height: 1.45;
          max-width: none;
          box-shadow: 0 1px 3px rgba(15,23,42,0.05);
          overflow: visible;
        }

        /* ── Header ──────────────────────────────────── */
        #${PANEL_ID} .skiprexa-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 13px 16px;
          border-bottom: 1px solid var(--sx-border);
          border-radius: 8px 8px 0 0;
          background: var(--sx-surface);
          flex-wrap: wrap;
        }
        #${PANEL_ID} .skiprexa-title {
          display: flex;
          align-items: baseline;
          gap: 6px;
          min-width: 0;
          font-size: 16px;
          font-weight: 700;
          letter-spacing: -0.03em;
          color: var(--sx-text);
        }
        #${PANEL_ID} .skiprexa-brand {
          color: var(--sx-accent);
          font-size: 11px;
          letter-spacing: 0;
        }
        #${PANEL_ID} .skiprexa-title-summary {
          color: var(--sx-text-secondary);
          font-weight: 500;
          font-size: 12px;
          letter-spacing: 0;
        }
        #${PANEL_ID} .skiprexa-header-actions {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        #${PANEL_ID} .skiprexa-controls {
          display: flex;
          align-items: center;
          gap: 14px;
        }
        #${PANEL_ID} .skiprexa-control-group,
        #${PANEL_ID} .skiprexa-heading-label {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }
        #${PANEL_ID} .skiprexa-highlight-help {
          width: 100%;
          margin: -2px 0 0;
          color: var(--sx-text-secondary);
          font-size: 11.5px;
          line-height: 1.45;
        }
        #${PANEL_ID} .skiprexa-highlight-help strong {
          color: var(--sx-accent);
        }
        #${PANEL_ID} .skiprexa-collapse-button {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-height: 30px;
          padding: 4px 8px;
          border: 0;
          border-radius: 5px;
          background: transparent;
          color: var(--sx-text-secondary);
          font: 600 12px/1 var(--sx-font);
          cursor: pointer;
        }
        #${PANEL_ID} .skiprexa-collapse-button:hover {
          background: #f1f5f9;
          color: var(--sx-accent);
        }
        #${PANEL_ID} .skiprexa-collapse-button:focus-visible {
          outline: 2px solid rgba(30,58,95,0.35);
          outline-offset: 2px;
        }
        #${PANEL_ID} .skiprexa-collapse-icon {
          width: 14px;
          height: 14px;
          fill: currentColor;
          transition: transform 0.18s ease;
        }
        #${PANEL_ID}.is-collapsed .skiprexa-collapse-icon {
          transform: rotate(180deg);
        }
        #${PANEL_ID}.is-collapsed .skiprexa-analyzer-body,
        #${PANEL_ID}.is-collapsed .skiprexa-controls,
        #${PANEL_ID}.is-collapsed .skiprexa-highlight-help {
          display: none;
        }
        #${PANEL_ID}.is-collapsed .skiprexa-header {
          border-bottom: 0;
          border-radius: 8px;
        }

        /* ── Threshold toggle ────────────────────────── */
        #${PANEL_ID} .skiprexa-toggle {
          display: inline-flex;
          border-radius: 6px;
          overflow: hidden;
          border: 1px solid var(--sx-border);
          background: #f9fafb;
        }
        #${PANEL_ID} .skiprexa-target-label {
          color: var(--sx-text-secondary);
          font-size: 12px;
          font-weight: 600;
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

        #${PANEL_ID} .skiprexa-total-missed {
          color: var(--sx-text-secondary);
          font-size: 12px;
          font-weight: 600;
        }

        /* ── Context notes ───────────────────────────── */
        #${PANEL_ID} .skiprexa-info-tip {
          position: relative;
          display: inline-flex;
          align-items: center;
          flex: 0 0 auto;
          text-align: left;
          text-transform: none;
          letter-spacing: normal;
        }
        #${PANEL_ID} .skiprexa-info-button {
          width: 26px;
          height: 26px;
          padding: 0;
          border: 0;
          border-radius: 5px;
          background: transparent;
          color: #60758d;
          cursor: help;
          transition: color 0.16s ease, background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
        }
        #${PANEL_ID} .skiprexa-info-button > span {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 17px;
          height: 17px;
          box-sizing: border-box;
          border: 1px solid #cbd7e4;
          border-radius: 50%;
          background: #f5f8fb;
          font-family: Georgia, 'Times New Roman', serif;
          font-size: 11px;
          font-weight: 700;
          font-style: italic;
          line-height: 1;
        }
        #${PANEL_ID} .skiprexa-info-button:hover,
        #${PANEL_ID} .skiprexa-info-button:focus-visible,
        #${PANEL_ID} .skiprexa-info-tip.is-open .skiprexa-info-button {
          background: rgba(30,58,95,0.08);
          color: #fff;
          box-shadow: 0 0 0 3px rgba(30,58,95,0.11);
          transform: translateY(-1px);
          outline: none;
        }
        #${PANEL_ID} .skiprexa-info-button:hover > span,
        #${PANEL_ID} .skiprexa-info-button:focus-visible > span,
        #${PANEL_ID} .skiprexa-info-tip.is-open .skiprexa-info-button > span {
          border-color: var(--sx-accent);
          background: var(--sx-accent);
        }
        #${PANEL_ID} .skiprexa-tooltip {
          position: absolute;
          z-index: 30;
          top: calc(100% + 9px);
          left: 50%;
          width: 226px;
          max-width: calc(100vw - 32px);
          padding: 11px 12px 12px;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 8px;
          background: #172b46;
          color: #edf4fb;
          font-family: var(--sx-font);
          text-align: left;
          text-transform: none;
          letter-spacing: normal;
          line-height: 1.4;
          box-shadow: 0 12px 28px rgba(15,23,42,0.22), 0 2px 8px rgba(15,23,42,0.12);
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transform: translate(-50%, -4px);
          transform-origin: top center;
          transition: opacity 0.16s ease, transform 0.16s ease;
        }
        #${PANEL_ID} .skiprexa-tooltip::before {
          content: "";
          position: absolute;
          top: -5px;
          left: 50%;
          width: 9px;
          height: 9px;
          background: #172b46;
          border-top: 1px solid rgba(255,255,255,0.12);
          border-left: 1px solid rgba(255,255,255,0.12);
          transform: translateX(-50%) rotate(45deg);
        }
        #${PANEL_ID} .skiprexa-info-tip--end .skiprexa-tooltip {
          right: -6px;
          left: auto;
          transform: translateY(-4px);
          transform-origin: top right;
        }
        #${PANEL_ID} .skiprexa-info-tip--end .skiprexa-tooltip::before {
          right: 10px;
          left: auto;
          transform: rotate(45deg);
        }
        #${PANEL_ID} .skiprexa-info-tip--above .skiprexa-tooltip {
          top: auto;
          bottom: calc(100% + 9px);
          transform: translate(-50%, 4px);
          transform-origin: bottom center;
        }
        #${PANEL_ID} .skiprexa-info-tip--above.skiprexa-info-tip--end .skiprexa-tooltip {
          transform: translateY(4px);
          transform-origin: bottom right;
        }
        #${PANEL_ID} .skiprexa-info-tip--above .skiprexa-tooltip::before {
          top: auto;
          bottom: -5px;
          border-top: 0;
          border-left: 0;
          border-right: 1px solid rgba(255,255,255,0.12);
          border-bottom: 1px solid rgba(255,255,255,0.12);
        }
        #${PANEL_ID} .skiprexa-info-tip:hover:not(.is-dismissed) .skiprexa-tooltip,
        #${PANEL_ID} .skiprexa-info-tip:not(.is-dismissed) .skiprexa-info-button:focus-visible + .skiprexa-tooltip,
        #${PANEL_ID} .skiprexa-info-tip.is-open:not(.is-dismissed) .skiprexa-tooltip {
          opacity: 1;
          visibility: visible;
          transform: translate(-50%, 0);
        }
        #${PANEL_ID} .skiprexa-info-tip--end:hover:not(.is-dismissed) .skiprexa-tooltip,
        #${PANEL_ID} .skiprexa-info-tip--end:not(.is-dismissed) .skiprexa-info-button:focus-visible + .skiprexa-tooltip,
        #${PANEL_ID} .skiprexa-info-tip--end.is-open:not(.is-dismissed) .skiprexa-tooltip {
          transform: translateY(0);
        }
        #${PANEL_ID} .skiprexa-info-tip--above:hover:not(.is-dismissed) .skiprexa-tooltip,
        #${PANEL_ID} .skiprexa-info-tip--above:not(.is-dismissed) .skiprexa-info-button:focus-visible + .skiprexa-tooltip,
        #${PANEL_ID} .skiprexa-info-tip--above.is-open:not(.is-dismissed) .skiprexa-tooltip {
          transform: translate(-50%, 0);
        }
        #${PANEL_ID} .skiprexa-info-tip--above.skiprexa-info-tip--end:hover:not(.is-dismissed) .skiprexa-tooltip,
        #${PANEL_ID} .skiprexa-info-tip--above.skiprexa-info-tip--end:not(.is-dismissed) .skiprexa-info-button:focus-visible + .skiprexa-tooltip,
        #${PANEL_ID} .skiprexa-info-tip--above.skiprexa-info-tip--end.is-open:not(.is-dismissed) .skiprexa-tooltip {
          transform: translateY(0);
        }
        #${PANEL_ID} .skiprexa-info-tip.is-dismissed .skiprexa-tooltip {
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
        }
        #${PANEL_ID} .skiprexa-tooltip-title,
        #${PANEL_ID} .skiprexa-tooltip-copy {
          display: block;
        }
        #${PANEL_ID} .skiprexa-tooltip-title {
          margin-bottom: 4px;
          color: #fff;
          font-family: var(--sx-font);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0;
        }
        #${PANEL_ID} .skiprexa-tooltip-copy {
          color: #d8e4f0;
          font-size: 11.5px;
          font-weight: 500;
        }

        /* ── Table ───────────────────────────────────── */
        #${PANEL_ID} table {
          width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
        }
        #${PANEL_ID} thead th {
          padding: 9px 14px;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0;
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
        #${PANEL_ID} .skiprexa-cell-status {
          vertical-align: middle;
        }
        #${PANEL_ID} .skiprexa-missed-val {
          font-family: var(--sx-mono);
          font-weight: 600;
          font-size: 13px;
          color: #475569;
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
          background: linear-gradient(90deg, rgba(6,182,212,0.10), rgba(6,182,212,0.02));
        }
        #${PANEL_ID} .skiprexa-row:last-child .skiprexa-cell {
          border-bottom: none;
        }

        /* ── Subject details ─────────────────────────── */
        #${PANEL_ID} .skiprexa-subject-top {
          display: flex;
          align-items: flex-start;
          gap: 10px;
        }
        #${PANEL_ID} .skiprexa-details {
          display: block;
          min-width: 0;
          flex: 1 1 auto;
        }
        #${PANEL_ID} .skiprexa-details > summary {
          cursor: pointer;
          font-weight: 600;
          color: var(--sx-text);
          display: flex;
          align-items: center;
          gap: 10px;
          list-style: none;
          user-select: none;
        }
        #${PANEL_ID} .skiprexa-summary-main {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
          flex: 1 1 auto;
          padding: 5px 0;
        }
        #${PANEL_ID} .skiprexa-details > summary::-webkit-details-marker { display: none; }
        #${PANEL_ID} .skiprexa-details > summary::marker { content: ""; }

        #${PANEL_ID} .skiprexa-chevron {
          display: inline-block;
          width: 26px;
          height: 26px;
          border-radius: 5px;
          background: #edf3f8;
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
          font-size: 14px;
          font-weight: 700;
          letter-spacing: -0.01em;
          color: var(--sx-text);
        }
        #${PANEL_ID} .skiprexa-subject-meta {
          font-family: var(--sx-mono);
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0;
          color: var(--sx-text-tertiary);
        }
        #${PANEL_ID} .skiprexa-highlight-toggle {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          min-height: 30px;
          padding: 4px 7px;
          border: 0;
          border-radius: 5px;
          background: transparent;
          color: var(--sx-text-secondary);
          font-family: var(--sx-font);
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0;
          cursor: pointer;
          transition: transform 0.16s ease, border-color 0.16s ease, background-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
          box-shadow: none;
          flex: 0 0 auto;
          margin-top: 3px;
        }
        #${PANEL_ID} .skiprexa-highlight-toggle:hover {
          color: var(--sx-accent);
          background: #edf3f8;
        }
        #${PANEL_ID} .skiprexa-highlight-toggle:focus-visible {
          outline: none;
          box-shadow: 0 0 0 3px rgba(30,58,95,0.12);
        }
        #${PANEL_ID} .skiprexa-pin-icon {
          width: 14px;
          height: 14px;
          fill: currentColor;
        }
        #${PANEL_ID} .skiprexa-highlight-toggle-label {
          line-height: 1;
        }
        #${PANEL_ID} .skiprexa-highlight-toggle.is-active {
          background: linear-gradient(180deg, #cffafe, #a5f3fc);
          color: #0e7490;
          box-shadow: 0 0 0 3px rgba(6,182,212,0.16);
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
        #${PANEL_ID} .skiprexa-breakdown {
          margin-top: 6px;
          color: #2563a6;
          font-size: 11px;
          font-weight: 500;
        }

        /* ── Actionable status ───────────────────────── */
        #${PANEL_ID} .skiprexa-outcome {
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding-left: 10px;
          border-left: 3px solid #d8e1ea;
        }
        #${PANEL_ID} .skiprexa-outcome-title,
        #${PANEL_ID} .skiprexa-outcome-detail {
          display: block;
        }
        #${PANEL_ID} .skiprexa-outcome-title {
          color: var(--sx-text);
          font-size: 14px;
          font-weight: 700;
          letter-spacing: -0.01em;
        }
        #${PANEL_ID} .skiprexa-outcome-detail {
          color: var(--sx-text-secondary);
          font-size: 11px;
        }
        #${PANEL_ID} .skiprexa-outcome.is-safe { border-left-color: #059669; }
        #${PANEL_ID} .skiprexa-outcome.is-safe .skiprexa-outcome-title { color: #047857; }
        #${PANEL_ID} .skiprexa-outcome.is-risk,
        #${PANEL_ID} .skiprexa-outcome.is-limit { border-left-color: #d97706; }
        #${PANEL_ID} .skiprexa-outcome.is-risk .skiprexa-outcome-title,
        #${PANEL_ID} .skiprexa-outcome.is-limit .skiprexa-outcome-title { color: #b45309; }
        #${PANEL_ID} .skiprexa-outcome.is-below,
        #${PANEL_ID} .skiprexa-outcome.is-invalid { border-left-color: #dc2626; }
        #${PANEL_ID} .skiprexa-outcome.is-below .skiprexa-outcome-title,
        #${PANEL_ID} .skiprexa-outcome.is-invalid .skiprexa-outcome-title { color: #b91c1c; }

        /* ── Total held input ────────────────────────── */
        #${PANEL_ID} .skiprexa-total-input {
          width: 100%;
          max-width: 112px;
          min-height: 34px;
          box-sizing: border-box;
          padding: 6px 9px;
          border: 1px solid #cbd5e1;
          border-radius: 6px;
          text-align: left;
          font-family: var(--sx-mono);
          font-size: 13px;
          font-weight: 600;
          color: var(--sx-text);
          background: var(--sx-surface);
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s, background-color 0.15s;
          -moz-appearance: textfield;
        }
        #${PANEL_ID} .skiprexa-total-input:hover {
          border-color: #94a3b8;
        }
        #${PANEL_ID} .skiprexa-total-input:focus-visible {
          border-color: var(--sx-accent);
          box-shadow: 0 0 0 3px rgba(30,58,95,0.12);
        }
        #${PANEL_ID} .skiprexa-total-input.is-valid:not(:focus) {
          border-color: #8da6be;
          background: #f8fbff;
        }
        #${PANEL_ID} .skiprexa-total-input.is-invalid {
          border-color: #dc2626;
          background: #fff7f7;
          box-shadow: 0 0 0 3px rgba(220,38,38,0.08);
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

        @media (prefers-reduced-motion: reduce) {
          #${PANEL_ID} .skiprexa-info-button,
          #${PANEL_ID} .skiprexa-tooltip,
          #${PANEL_ID} .skiprexa-collapse-icon,
          #${PANEL_ID} .skiprexa-row {
            transition: none;
            animation: none;
          }
        }
        @media (max-width: 840px) {
          #${PANEL_ID} {
            width: calc(100vw - 16px);
            max-width: calc(100vw - 16px);
            border-right: 0;
            border-left: 0;
            border-radius: 0;
          }
          #${PANEL_ID} .skiprexa-header {
            align-items: flex-start;
            border-radius: 0;
          }
          #${PANEL_ID} .skiprexa-title {
            flex-wrap: wrap;
            row-gap: 1px;
          }
          #${PANEL_ID} .skiprexa-header-actions {
            width: 100%;
            justify-content: space-between;
          }
          #${PANEL_ID} table,
          #${PANEL_ID} tbody,
          #${PANEL_ID} tr,
          #${PANEL_ID} td {
            display: block;
            width: 100%;
            box-sizing: border-box;
          }
          #${PANEL_ID} table {
            padding: 10px;
            background: #f3f6f9;
          }
          #${PANEL_ID} thead {
            display: none;
          }
          #${PANEL_ID} .skiprexa-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 0;
            margin-bottom: 10px;
            border: 1px solid #dfe6ee;
            border-radius: 8px;
            background: var(--sx-surface);
            overflow: hidden;
          }
          #${PANEL_ID} .skiprexa-row:last-child {
            margin-bottom: 0;
          }
          #${PANEL_ID} .skiprexa-row:hover {
            background: var(--sx-surface);
          }
          #${PANEL_ID} .skiprexa-row.is-pinned-highlight {
            border-color: rgba(6,182,212,0.58);
            background: var(--sx-surface);
            box-shadow: inset 3px 0 0 #06b6d4;
          }
          #${PANEL_ID} .skiprexa-cell {
            min-width: 0;
            padding: 10px 12px;
            border: 0;
          }
          #${PANEL_ID} .skiprexa-cell-subject,
          #${PANEL_ID} .skiprexa-cell-status {
            grid-column: 1 / -1;
          }
          #${PANEL_ID} .skiprexa-cell-status {
            order: 2;
            padding-top: 2px;
            padding-bottom: 12px;
          }
          #${PANEL_ID} .skiprexa-cell-subject { order: 1; }
          #${PANEL_ID} .skiprexa-input-cell { order: 3; }
          #${PANEL_ID} .skiprexa-missed-val { order: 4; }
          #${PANEL_ID} .skiprexa-min-total { display: none; }
          #${PANEL_ID} .skiprexa-cell[data-label]::before {
            content: attr(data-label);
            display: block;
            margin-bottom: 4px;
            color: var(--sx-text-tertiary);
            font-size: 10px;
            font-weight: 600;
          }
          #${PANEL_ID} .skiprexa-cell-status::before,
          #${PANEL_ID} .skiprexa-cell-subject::before {
            display: none !important;
          }
          #${PANEL_ID} .skiprexa-cell-num {
            text-align: left;
          }
          #${PANEL_ID} .skiprexa-total-input {
            max-width: 100%;
          }
          #${PANEL_ID} .skiprexa-details > summary {
            flex-wrap: nowrap;
          }
          #${PANEL_ID} .skiprexa-highlight-toggle-label {
            display: none;
          }
          #${PANEL_ID} .skiprexa-highlight-toggle {
            width: 32px;
            justify-content: center;
          }
          #${PANEL_ID} .skiprexa-tooltip,
          #${PANEL_ID} .skiprexa-info-tip--end .skiprexa-tooltip {
            position: fixed;
            top: auto;
            right: 14px;
            bottom: 14px;
            left: 14px;
            width: auto;
            max-width: none;
            transform: translateY(8px);
            transform-origin: bottom center;
          }
          #${PANEL_ID} .skiprexa-tooltip::before,
          #${PANEL_ID} .skiprexa-info-tip--end .skiprexa-tooltip::before {
            display: none;
          }
          #${PANEL_ID} .skiprexa-info-tip:hover:not(.is-dismissed) .skiprexa-tooltip,
          #${PANEL_ID} .skiprexa-info-tip:not(.is-dismissed) .skiprexa-info-button:focus-visible + .skiprexa-tooltip,
          #${PANEL_ID} .skiprexa-info-tip.is-open:not(.is-dismissed) .skiprexa-tooltip,
          #${PANEL_ID} .skiprexa-info-tip--end:hover:not(.is-dismissed) .skiprexa-tooltip,
          #${PANEL_ID} .skiprexa-info-tip--end:not(.is-dismissed) .skiprexa-info-button:focus-visible + .skiprexa-tooltip,
          #${PANEL_ID} .skiprexa-info-tip--end.is-open:not(.is-dismissed) .skiprexa-tooltip {
            transform: translateY(0);
          }
        }

        /* ── Tile highlight ──────────────────────────── */
        .${TILE_HIGHLIGHT_CLASS} {
          outline: 2px solid #22d3ee !important;
          outline-offset: -2px;
          box-shadow: inset 0 0 0 999px rgba(34,211,238,0.24), 0 0 0 1px rgba(8,145,178,0.92);
          transition: box-shadow 0.16s ease, outline-color 0.16s ease;
        }
        .${TILE_HIGHLIGHT_INFO_CLASS} {
          outline: 2px solid #d946ef !important;
          outline-offset: -2px;
          box-shadow: inset 0 0 0 999px rgba(217,70,239,0.18), 0 0 0 1px rgba(162,28,175,0.82);
          transition: box-shadow 0.16s ease, outline-color 0.16s ease;
        }
      </style>

      <div class="skiprexa-header">
        <div class="skiprexa-title"><span class="skiprexa-brand">SkipREXA</span> Attendance Analyzer <span class="skiprexa-title-summary">· ${escapeHtml(analyzerSummary)}</span></div>
        <div class="skiprexa-header-actions">
          <div class="skiprexa-controls">
            <div class="skiprexa-control-group">
              <span class="skiprexa-target-label">Target</span>
              <div class="skiprexa-toggle" role="group" aria-label="Attendance target">
                <button type="button" class="skiprexa-toggle-btn ${is75 ? "active" : ""}" data-threshold="75" aria-pressed="${is75}">75%</button>
                <button type="button" class="skiprexa-toggle-btn ${!is75 ? "active" : ""}" data-threshold="80" aria-pressed="${!is75}">80%</button>
              </div>
              ${infoTipHtml("skiprexa-tip-threshold", "Attendance target", "Changing the target recalculates the total needed and every subject status.", "end")}
            </div>
            <div class="skiprexa-control-group">
              <span class="skiprexa-total-missed">${missedTotal} missed classes</span>
              ${infoTipHtml("skiprexa-tip-leave-types", "What counts as missed", "Only unapproved absences count here. Approved leave, duty leave, and duty attendance are excluded.", "end")}
            </div>
          </div>
          <button type="button" class="skiprexa-collapse-button" aria-expanded="${!analyzerCollapsed}" aria-controls="skiprexa-analyzer-body">
            <span>${analyzerCollapsed ? "Expand" : "Collapse"}</span>
            <svg class="skiprexa-collapse-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 7.5 4.5 4.5 4.5-4.5 1.4 1.4-5.9 5.9-5.9-5.9 1.4-1.4Z"/></svg>
          </button>
        </div>
        ${pinTipSeen ? "" : '<div class="skiprexa-highlight-help">Pin a subject to keep its timetable cells highlighted while you scroll.</div>'}
      </div>

      <div id="skiprexa-analyzer-body" class="skiprexa-analyzer-body">
        <table>
          <thead>
            <tr>
              <th>Subject</th>
              <th style="width:230px;">Attendance status</th>
              <th style="width:90px;">Missed classes</th>
              <th style="width:126px;"><span class="skiprexa-heading-label">Total needed ${infoTipHtml("skiprexa-tip-total-needed", `Total needed for ${thresholdInt}%`, `The minimum total classes needed for your current missed classes to equal ${thresholdInt}% attendance.`)}</span></th>
              <th style="width:140px;">Classes held so far</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;

    panel.setAttribute("data-rendered", "true");
    patchSubjectLabels(panel);
    attachSubjectInteractions(panel);
    attachThresholdToggle(panel);
    attachTotalInputListeners(panel);
    attachInfoTips(panel);
    attachCollapseButton(panel);
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
    updateDangerBadges();
  }

  function attachCollapseButton(panel) {
    const button = panel.querySelector(".skiprexa-collapse-button");
    if (!button) return;
    button.addEventListener("click", () => {
      analyzerCollapsed = !analyzerCollapsed;
      panel.classList.toggle("is-collapsed", analyzerCollapsed);
      button.setAttribute("aria-expanded", String(!analyzerCollapsed));
      const label = button.querySelector("span");
      if (label) label.textContent = analyzerCollapsed ? "Expand" : "Collapse";
      closeInfoTips(panel);
      savePersistedState();
    });
  }

  function closeInfoTips(panel, except = null) {
    const tips = panel.querySelectorAll(".skiprexa-info-tip");
    for (const tip of tips) {
      if (tip === except) continue;
      tip.classList.remove("is-open", "is-dismissed");
      tip.querySelector(".skiprexa-info-button")?.setAttribute("aria-expanded", "false");
    }
  }

  function attachInfoTips(panel) {
    const tips = panel.querySelectorAll(".skiprexa-info-tip");
    for (const tip of tips) {
      const button = tip.querySelector(".skiprexa-info-button");
      if (!button) continue;
      tip.classList.toggle("skiprexa-info-tip--above", Boolean(tip.closest(".skiprexa-header, thead")));

      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const shouldOpen = !tip.classList.contains("is-open");
        closeInfoTips(panel, shouldOpen ? tip : null);
        tip.classList.toggle("is-dismissed", !shouldOpen);
        tip.classList.toggle("is-open", shouldOpen);
        button.setAttribute("aria-expanded", String(shouldOpen));
      });

      button.addEventListener("focus", () => tip.classList.remove("is-dismissed"));
      tip.addEventListener("mouseenter", () => tip.classList.remove("is-dismissed"));
      button.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        tip.classList.remove("is-open");
        tip.classList.add("is-dismissed");
        button.setAttribute("aria-expanded", "false");
        event.stopPropagation();
      });
    }

    if (!infoDismissListenerAttached) {
      infoDismissListenerAttached = true;
      document.addEventListener("click", (event) => {
        const currentPanel = document.getElementById(PANEL_ID);
        if (!currentPanel) return;
        if (event.target instanceof Element && event.target.closest(`#${PANEL_ID} .skiprexa-info-tip`)) return;
        closeInfoTips(currentPanel);
      });
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  function scheduleRender(delay = 250) {
    if (!attendanceUiEnabled) return;
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
    if (!attendanceUiEnabled) return;
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

  async function initialize() {
    await loadAttendanceUiSetting();
    subscribeAttendanceUiSetting();
    attachSubmitListeners();
    if (!attendanceUiEnabled) {
      removeAttendancePanel();
      return;
    }
    injectFont();
    if (isSubmitTriggered) scheduleRenderBurst();
  }

  initialize();
})();
