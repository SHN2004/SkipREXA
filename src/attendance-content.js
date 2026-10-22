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
  // The update owner keeps summary invalidation separate from live timetable
  // reconciliation.  The latter must run even when the parsed entries are
  // unchanged because RSMS replaces DOM nodes during a refresh.
  let lastRenderKey = "";
  let attendancePanel = null;
  let renderTimer = null;
  let burstRenderTimers = [];
  let lateUpdateObserver = null;
  let lateUpdateObserverTimer = null;
  let isSubmitTriggered = new URLSearchParams(window.location.search).has("code");
  let attendanceUiEnabled = true;
  let highlightedCells = [];
  let activeHoverSubject = null;
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
    clearScheduledUpdateTimers();
    stopLateUpdateObserver();
    clearSubjectHighlight();
    activeHoverSubject = null;
    attendancePanel?.remove();
    document.getElementById(PANEL_ID)?.remove();
    attendancePanel = null;
    lastRenderKey = "";
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
    link.href = "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=JetBrains+Mono:wght@500;600;700&family=Space+Grotesk:wght@600;700&display=swap";
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

    const requestedClassCode = classCode;
    const promise = fetchSubjectMapForClass(requestedClassCode, neededSubjects)
      .then((result) => {
        if (!result) return;
        subjectNameCache[requestedClassCode] = result;
        savePersistedState();
        // The class may have changed while the lookup was in flight.  Let the
        // update owner resolve the current class and panel before patching.
        if (!attendanceUiEnabled || !isSubmitTriggered) return;
        renderSummary();
      })
      .catch(() => {
        subjectMapFailureTimestamps.set(requestedClassCode, Date.now());
        // silent fallback to subject codes
      })
      .finally(() => {
        subjectMapPromises.delete(requestedClassCode);
      });

    subjectMapPromises.set(requestedClassCode, promise);
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

  function getActiveHighlightSubjects() {
    if (pinnedHighlightSubjects.size) return pinnedHighlightSubjects;
    return activeHoverSubject ? new Set([activeHoverSubject]) : new Set();
  }

  function reconcileSubjectHighlights() {
    applySubjectHighlights(getActiveHighlightSubjects());
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
    // A pin toggle is an explicit interaction.  Preserve the existing
    // behavior where unpinning the final subject clears the hover highlight.
    activeHoverSubject = null;
    savePersistedState();
    reconcileSubjectHighlights();
    if (panel) syncPinnedHighlightButtons(panel);
  }

  function attachSubjectInteractions(panel) {
    const rows = panel.querySelectorAll("tr[data-subject]");
    for (const row of rows) {
      const subject = row.getAttribute("data-subject");
      row.addEventListener("mouseenter", () => {
        if (pinnedHighlightSubjects.size) return;
        if (!subject) return;
        activeHoverSubject = subject;
        reconcileSubjectHighlights();
      });
      row.addEventListener("mouseleave", () => {
        if (pinnedHighlightSubjects.size) return;
        if (activeHoverSubject !== subject) return;
        activeHoverSubject = null;
        reconcileSubjectHighlights();
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
      title: "Add classes held",
      detail: "We’ll calculate your attendance buffer",
      attention: false
    };
    const targetPct = Math.round(attendanceThreshold * 100);
    const hasProgress = result.isValid === true && Number.isFinite(result.currentPct);
    const progressPct = hasProgress ? Math.max(0, Math.min(100, result.currentPct)) : 0;
    const meterLabel = hasProgress
      ? `Current attendance ${result.currentPct.toFixed(1)}%. Target ${targetPct}%.`
      : `Enter classes held to compare with the ${targetPct}% target.`;
    return `
      <div class="skiprexa-outcome is-${result.state}" data-state="${result.state}" data-attention="${result.attention ? "true" : "false"}" aria-live="polite">
        <span class="skiprexa-outcome-copy">
          <span class="skiprexa-status-dot" aria-hidden="true"></span>
          <span>
            <span class="skiprexa-outcome-title">${escapeHtml(result.title)}</span>
            <span class="skiprexa-outcome-detail">${escapeHtml(result.detail)}</span>
          </span>
        </span>
        <span class="skiprexa-meter${hasProgress ? " has-value" : ""}" role="img" aria-label="${escapeHtml(meterLabel)}">
          <span class="skiprexa-meter-fill" style="width:${progressPct.toFixed(1)}%"></span>
          <span class="skiprexa-meter-target" style="left:${targetPct}%"></span>
        </span>
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
    attendancePanel = panel;

    if (!anchor || anchor === document.body) {
      if (panel.parentNode !== document.body) document.body.appendChild(panel);
    } else if (panel.parentNode !== anchor.parentNode || panel.nextElementSibling !== anchor) {
      anchor.insertAdjacentElement("beforebegin", panel);
    }
    return panel;
  }

  function syncPinnedSubjectsToPanel(panel) {
    if (!panel) return;

    const availableSubjects = new Set(
      Array.from(panel.querySelectorAll(".skiprexa-highlight-toggle[data-subject]"))
        .map((button) => button.getAttribute("data-subject"))
        .filter(Boolean)
    );
    const nextPinnedSubjects = new Set(
      Array.from(pinnedHighlightSubjects).filter((subject) => availableSubjects.has(subject))
    );
    const hasChanged = nextPinnedSubjects.size !== pinnedHighlightSubjects.size
      || Array.from(nextPinnedSubjects).some((subject) => !pinnedHighlightSubjects.has(subject));
    if (hasChanged) {
      pinnedHighlightSubjects = nextPinnedSubjects;
      savePersistedState();
    }
    syncPinnedHighlightButtons(panel);
  }

  // ── Handlers ─────────────────────────────────────────────────────

  function onThresholdChange(value) {
    attendanceThreshold = value === "80" ? 0.80 : 0.75;
    savePersistedState();
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
    renderSummary();
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
    if (summary) summary.textContent = analyzerSummaryText(rows);
  }

  function updateDangerBadges(panel = document.getElementById(PANEL_ID)) {
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

  // ── Main update owner ────────────────────────────────────────────

  function renderSummary() {
    if (!attendanceUiEnabled) {
      removeAttendancePanel();
      return;
    }
    if (!isSubmitTriggered) return;

    const entries = parseLeaveEntries();
    ensureSubjectNamesForCurrentClass(entries);
    const classCode = getCurrentClassCode();
    const renderKey = JSON.stringify({
      classCode,
      threshold: attendanceThreshold,
      entries
    });
    const existingPanel = document.getElementById(PANEL_ID);

    // The render key gates only summary replacement.  Timetable nodes are
    // independently reconciled on every pass because RSMS can replace them
    // without changing the parsed attendance data.
    if (existingPanel && renderKey === lastRenderKey) {
      // Recheck placement without moving an already-correct panel.  This also
      // repairs a table that was moved by RSMS while preserving panel nodes.
      const panel = getOrCreatePanel(findAnchorElement());
      patchSubjectLabels(panel);
      updateDangerBadges(panel);
      reconcileSubjectHighlights();
      return;
    }

    // Rebuilding the summary invalidates a transient hover row.  Pinned
    // subjects remain authoritative and are reapplied after the rebuild.
    activeHoverSubject = null;
    clearSubjectHighlight();
    const panel = getOrCreatePanel(findAnchorElement());

    if (!entries.length) {
      panel.innerHTML = `
        <div style="font-family:'DM Sans',system-ui,sans-serif;padding:20px;">
          <div style="font-size:15px;font-weight:700;letter-spacing:-0.02em;">SkipREXA</div>
          <div style="margin-top:6px;color:#6b7280;font-size:13px;">No missed class hours found for the selected class.</div>
        </div>`;
      reconcileSubjectHighlights();
      lastRenderKey = renderKey;
      return;
    }

    const subjectRows = groupBySubject(entries);
    const thresholdInt = Math.round(attendanceThreshold * 100);
    const is75 = attendanceThreshold === 0.75;
    const analyzerSummary = analyzerSummaryText(subjectRows);
    const missedTotal = subjectRows.reduce((sum, row) => sum + row.missedHours, 0);

    const leaveTypeLabel = {
      leave: { label: "Absent", color: "#c94f5c" },
      approved_leave: { label: "Approved", color: "#147d73" },
      duty_leave: { label: "Duty leave", color: "#147d73" }
    };

    const rowsHtml = subjectRows.map((entry) => {
      const minTotal = minTotalForThreshold(entry.missedHours, attendanceThreshold);
      const totalHeld = getStoredTotal(entry.subject);
      const outcome = computeDangerZone(entry.missedHours, totalHeld, attendanceThreshold);
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
        <tr data-subject="${entry.subject}" data-missed="${entry.missedHours}" class="skiprexa-row">
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
          <td class="skiprexa-cell skiprexa-cell-status" data-label="Distance to target"><div class="skiprexa-outcome-slot">${attendanceOutcomeHtml(outcome)}</div></td>
          <td class="skiprexa-cell skiprexa-cell-num skiprexa-missed-val" data-label="Missed classes">${entry.missedHours}</td>
          <td class="skiprexa-cell skiprexa-cell-num skiprexa-min-total" data-label="Needed total">${minTotal}</td>
          <td class="skiprexa-cell skiprexa-cell-num skiprexa-input-cell" data-label="Classes held">
            <input type="number" min="1" step="1" inputmode="numeric" class="skiprexa-total-input${outcome?.isValid === false ? " is-invalid" : outcome?.isValid === true ? " is-valid" : ""}" data-subject="${escapeHtml(entry.subject)}"
              aria-label="Classes held so far for ${escapeHtml(subjectMeta.label)}" aria-invalid="${outcome?.isValid === false ? "true" : "false"}"
              value="${totalHeld ?? ""}" placeholder="Total" autocomplete="off" />
          </td>
        </tr>`;
    }).join("");

    panel.className = analyzerCollapsed ? "is-collapsed" : "";
    panel.innerHTML = `
      <style>
        /* ── Foundation ──────────────────────────────── */
        #${PANEL_ID} {
          --sx-font: 'DM Sans', system-ui, -apple-system, sans-serif;
          --sx-display: 'Space Grotesk', 'DM Sans', system-ui, sans-serif;
          --sx-mono: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
          --sx-bg: #f3f6fa;
          --sx-surface: #ffffff;
          --sx-border: #d3dce8;
          --sx-border-subtle: #e2e8f0;
          --sx-text: #17213a;
          --sx-text-secondary: #4d5b70;
          --sx-text-tertiary: #68778d;
          --sx-accent: #17213a;
          --sx-accent-light: #e9eef6;
          --sx-safe: #0e7169;
          --sx-watch: #995b0d;
          --sx-risk: #b94150;
          --sx-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
          width: 100%;
          box-sizing: border-box;
          margin: 30px 0 14px !important;
          padding: 0;
          border: 1px solid var(--sx-border);
          border-radius: 16px;
          background: var(--sx-bg);
          font-family: var(--sx-font);
          font-size: 13px;
          line-height: 1.45;
          max-width: none;
          color: var(--sx-text);
          box-shadow: 0 14px 34px rgba(23,33,58,0.08), 0 2px 6px rgba(23,33,58,0.04);
          overflow: visible;
          clear: both;
        }

        /* ── Header ──────────────────────────────────── */
        #${PANEL_ID} .skiprexa-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 18px 24px;
          padding: 20px 22px 18px;
          border-bottom: 1px solid var(--sx-border);
          border-radius: 16px 16px 0 0;
          background: var(--sx-surface);
          flex-wrap: wrap;
        }
        #${PANEL_ID} .skiprexa-heading {
          min-width: 260px;
          flex: 1 1 340px;
        }
        #${PANEL_ID} .skiprexa-eyebrow {
          display: flex;
          align-items: center;
          gap: 7px;
          margin-bottom: 5px;
          color: var(--sx-text-secondary);
          font: 600 9px/1 var(--sx-mono);
          letter-spacing: 0.1em;
          text-transform: uppercase;
        }
        #${PANEL_ID} .skiprexa-brand-mark {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 21px;
          height: 21px;
          border-radius: 6px;
          background: var(--sx-accent);
          color: #ffffff;
          font: 700 11px/1 var(--sx-display);
          letter-spacing: -0.04em;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.12);
        }
        #${PANEL_ID} .skiprexa-eyebrow-divider {
          color: #c2cad5;
        }
        #${PANEL_ID} .skiprexa-title {
          font-family: var(--sx-display);
          font-size: 22px;
          line-height: 1.1;
          font-weight: 700;
          letter-spacing: -0.045em;
          color: var(--sx-text);
        }
        #${PANEL_ID} .skiprexa-title-summary {
          margin-top: 5px;
          color: var(--sx-text-secondary);
          font-weight: 600;
          font-size: 12.5px;
          line-height: 1.35;
          letter-spacing: 0;
        }
        #${PANEL_ID} .skiprexa-header-actions {
          display: flex;
          align-items: center;
          gap: 10px;
          flex: 0 1 auto;
        }
        #${PANEL_ID} .skiprexa-controls {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        #${PANEL_ID} .skiprexa-control-group,
        #${PANEL_ID} .skiprexa-heading-label {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }
        #${PANEL_ID} .skiprexa-highlight-help {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          box-sizing: border-box;
          margin: 0;
          padding: 9px 11px;
          border: 1px solid #d8e1ec;
          border-radius: 9px;
          background: #f7f9fc;
          color: var(--sx-text-secondary);
          font-size: 11px;
          font-weight: 600;
          line-height: 1.45;
        }
        #${PANEL_ID} .skiprexa-help-icon {
          color: var(--sx-accent);
          font: 700 14px/1 var(--sx-mono);
        }
        #${PANEL_ID} .skiprexa-collapse-button {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-height: 36px;
          padding: 7px 9px;
          border: 1px solid transparent;
          border-radius: 8px;
          background: #f7f9fc;
          color: var(--sx-text-secondary);
          font: 600 12px/1 var(--sx-font);
          cursor: pointer;
          transition: transform 140ms var(--sx-ease-out), color 160ms ease, background-color 160ms ease, border-color 160ms ease;
        }
        #${PANEL_ID} .skiprexa-collapse-button:focus-visible {
          outline: 2px solid rgba(23,33,58,0.35);
          outline-offset: 2px;
        }
        #${PANEL_ID} .skiprexa-collapse-button:active {
          transform: scale(0.97);
        }
        #${PANEL_ID} .skiprexa-collapse-icon {
          width: 14px;
          height: 14px;
          fill: currentColor;
          transition: transform 180ms var(--sx-ease-out);
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
          border-radius: 16px;
        }

        /* ── Threshold toggle ────────────────────────── */
        #${PANEL_ID} .skiprexa-toggle {
          display: inline-flex;
          padding: 3px;
          border-radius: 10px;
          overflow: hidden;
          border: 1px solid var(--sx-border);
          background: #f5f7fa;
        }
        #${PANEL_ID} .skiprexa-target-label {
          color: var(--sx-text-secondary);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        #${PANEL_ID} .skiprexa-toggle-btn {
          min-height: 28px;
          padding: 4px 12px;
          font-family: var(--sx-mono);
          font-size: 10px;
          font-weight: 700;
          border: none;
          border-radius: 7px;
          cursor: pointer;
          transition: transform 140ms var(--sx-ease-out), background-color 160ms ease, color 160ms ease, box-shadow 160ms ease;
          background: transparent;
          color: var(--sx-text-tertiary);
          position: relative;
        }
        #${PANEL_ID} .skiprexa-toggle-btn.active {
          background: var(--sx-accent);
          color: #fff;
          box-shadow: 0 2px 5px rgba(23,33,58,0.18);
        }
        #${PANEL_ID} .skiprexa-toggle-btn:focus-visible {
          outline: 2px solid rgba(23,33,58,0.36);
          outline-offset: 2px;
        }
        #${PANEL_ID} .skiprexa-toggle-btn:active {
          transform: scale(0.97);
        }

        #${PANEL_ID} .skiprexa-total-missed {
          display: inline-flex;
          align-items: baseline;
          gap: 5px;
          min-height: 36px;
          box-sizing: border-box;
          padding: 7px 10px;
          border: 1px solid #f0d7da;
          border-radius: 10px;
          background: #fff7f8;
          color: #8c4750;
          font-size: 10.5px;
          font-weight: 700;
          white-space: nowrap;
        }
        #${PANEL_ID} .skiprexa-total-missed strong {
          color: var(--sx-risk);
          font: 700 15px/1 var(--sx-mono);
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
          width: 28px;
          height: 28px;
          padding: 0;
          border: 0;
          border-radius: 7px;
          background: transparent;
          color: #68758a;
          cursor: help;
          transition: color 160ms ease, background-color 160ms ease, box-shadow 160ms ease, transform 140ms var(--sx-ease-out);
        }
        #${PANEL_ID} .skiprexa-info-button > span {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 17px;
          height: 17px;
          box-sizing: border-box;
          border: 1px solid #cbd5e1;
          border-radius: 50%;
          background: #f8fafc;
          font-family: Georgia, 'Times New Roman', serif;
          font-size: 11px;
          font-weight: 700;
          font-style: italic;
          line-height: 1;
        }
        #${PANEL_ID} .skiprexa-info-button:focus-visible,
        #${PANEL_ID} .skiprexa-info-tip.is-open .skiprexa-info-button {
          background: rgba(23,33,58,0.08);
          color: #fff;
          box-shadow: 0 0 0 3px rgba(23,33,58,0.1);
          outline: none;
        }
        #${PANEL_ID} .skiprexa-info-button:focus-visible > span,
        #${PANEL_ID} .skiprexa-info-tip.is-open .skiprexa-info-button > span {
          border-color: var(--sx-accent);
          background: var(--sx-accent);
        }
        #${PANEL_ID} .skiprexa-info-button:active {
          transform: scale(0.96);
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
          border-radius: 10px;
          background: #17213a;
          color: #edf4fb;
          font-family: var(--sx-font);
          text-align: left;
          text-transform: none;
          letter-spacing: normal;
          line-height: 1.4;
          box-shadow: 0 16px 36px rgba(23,33,58,0.24), 0 3px 10px rgba(23,33,58,0.14);
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transform: translate(-50%, -3px) scale(0.97);
          transform-origin: top center;
          transition: opacity 160ms ease, transform 160ms var(--sx-ease-out), visibility 0s linear 160ms;
        }
        #${PANEL_ID} .skiprexa-tooltip::before {
          content: "";
          position: absolute;
          top: -5px;
          left: 50%;
          width: 9px;
          height: 9px;
          background: #17213a;
          border-top: 1px solid rgba(255,255,255,0.12);
          border-left: 1px solid rgba(255,255,255,0.12);
          transform: translateX(-50%) rotate(45deg);
        }
        #${PANEL_ID} .skiprexa-info-tip--end .skiprexa-tooltip {
          right: -6px;
          left: auto;
          transform: translateY(-3px) scale(0.97);
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
          transform: translate(-50%, 3px) scale(0.97);
          transform-origin: bottom center;
        }
        #${PANEL_ID} .skiprexa-info-tip--above.skiprexa-info-tip--end .skiprexa-tooltip {
          transform: translateY(3px) scale(0.97);
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
        #${PANEL_ID} .skiprexa-info-tip:not(.is-dismissed) .skiprexa-info-button:focus-visible + .skiprexa-tooltip,
        #${PANEL_ID} .skiprexa-info-tip.is-open:not(.is-dismissed) .skiprexa-tooltip {
          opacity: 1;
          visibility: visible;
          transform: translate(-50%, 0);
          transition-delay: 0s;
        }
        #${PANEL_ID} .skiprexa-info-tip--end:not(.is-dismissed) .skiprexa-info-button:focus-visible + .skiprexa-tooltip,
        #${PANEL_ID} .skiprexa-info-tip--end.is-open:not(.is-dismissed) .skiprexa-tooltip {
          transform: translateY(0);
          transition-delay: 0s;
        }
        #${PANEL_ID} .skiprexa-info-tip--above:not(.is-dismissed) .skiprexa-info-button:focus-visible + .skiprexa-tooltip,
        #${PANEL_ID} .skiprexa-info-tip--above.is-open:not(.is-dismissed) .skiprexa-tooltip {
          transform: translate(-50%, 0);
          transition-delay: 0s;
        }
        #${PANEL_ID} .skiprexa-info-tip--above.skiprexa-info-tip--end:not(.is-dismissed) .skiprexa-info-button:focus-visible + .skiprexa-tooltip,
        #${PANEL_ID} .skiprexa-info-tip--above.skiprexa-info-tip--end.is-open:not(.is-dismissed) .skiprexa-tooltip {
          transform: translateY(0);
          transition-delay: 0s;
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
        #${PANEL_ID} .skiprexa-analyzer-body {
          padding: 8px 10px 10px;
        }
        #${PANEL_ID} table {
          width: 100%;
          border-collapse: separate;
          border-spacing: 0 7px;
          table-layout: fixed;
        }
        #${PANEL_ID} thead th {
          padding: 8px 14px;
          border: 0;
          border-top: 1px solid #d6dfeb;
          border-bottom: 1px solid #cbd6e3;
          font: 700 10px/1.25 var(--sx-mono);
          letter-spacing: 0.055em;
          text-transform: uppercase;
          color: #3f4d63;
          background: #e9eef5;
          text-align: left;
        }
        #${PANEL_ID} thead th:first-child {
          border-left: 1px solid #d6dfeb;
          border-radius: 8px 0 0 8px;
        }
        #${PANEL_ID} thead th:last-child {
          border-right: 1px solid #d6dfeb;
          border-radius: 0 8px 8px 0;
        }
        #${PANEL_ID} thead th:not(:first-child) {
          text-align: center;
        }
        #${PANEL_ID} .skiprexa-cell {
          padding: 12px 14px;
          border-top: 1px solid var(--sx-border-subtle);
          border-bottom: 1px solid var(--sx-border-subtle);
          background: var(--sx-surface);
          vertical-align: middle;
          transition: background-color 160ms ease, border-color 160ms ease;
        }
        #${PANEL_ID} .skiprexa-cell:first-child {
          border-left: 1px solid var(--sx-border-subtle);
          border-radius: 10px 0 0 10px;
        }
        #${PANEL_ID} .skiprexa-cell:last-child {
          border-right: 1px solid var(--sx-border-subtle);
          border-radius: 0 10px 10px 0;
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
          font-weight: 700;
          font-size: 14px;
          color: var(--sx-risk);
        }
        #${PANEL_ID} .skiprexa-min-total {
          font-family: var(--sx-mono);
          font-weight: 700;
          font-size: 15px;
          color: var(--sx-accent);
        }

        /* ── Row states ──────────────────────────────── */
        #${PANEL_ID} .skiprexa-row {
          background: transparent;
        }
        #${PANEL_ID} .skiprexa-row.is-pinned-highlight .skiprexa-cell {
          border-color: rgba(24,125,157,0.34);
          background: #f2fbfd;
        }
        #${PANEL_ID} .skiprexa-row.is-pinned-highlight .skiprexa-cell:first-child {
          box-shadow: inset 3px 0 0 #187d9d;
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
          outline: none;
          border-radius: 8px;
        }
        #${PANEL_ID} .skiprexa-details > summary:focus-visible {
          box-shadow: 0 0 0 3px rgba(23,33,58,0.12);
        }
        #${PANEL_ID} .skiprexa-summary-main {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
          flex: 1 1 auto;
          padding: 3px 0;
        }
        #${PANEL_ID} .skiprexa-details > summary::-webkit-details-marker { display: none; }
        #${PANEL_ID} .skiprexa-details > summary::marker { content: ""; }

        #${PANEL_ID} .skiprexa-chevron {
          display: inline-block;
          width: 28px;
          height: 28px;
          box-sizing: border-box;
          border: 1px solid #e1e7ef;
          border-radius: 8px;
          background: #f7f9fc;
          position: relative;
          transition: transform 180ms var(--sx-ease-out), background-color 160ms ease, border-color 160ms ease;
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
          border-color: var(--sx-accent);
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
          letter-spacing: -0.015em;
          line-height: 1.3;
          color: var(--sx-text);
        }
        #${PANEL_ID} .skiprexa-subject-meta {
          font-family: var(--sx-mono);
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0;
          color: var(--sx-text-tertiary);
        }
        #${PANEL_ID} .skiprexa-highlight-toggle {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          min-height: 32px;
          padding: 5px 8px;
          border: 1px solid transparent;
          border-radius: 8px;
          background: transparent;
          color: var(--sx-text-secondary);
          font-family: var(--sx-font);
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0;
          cursor: pointer;
          transition: transform 140ms var(--sx-ease-out), border-color 160ms ease, background-color 160ms ease, color 160ms ease, box-shadow 160ms ease;
          box-shadow: none;
          flex: 0 0 auto;
          margin-top: 0;
        }
        #${PANEL_ID} .skiprexa-highlight-toggle:focus-visible {
          outline: none;
          box-shadow: 0 0 0 3px rgba(23,33,58,0.12);
        }
        #${PANEL_ID} .skiprexa-highlight-toggle:active {
          transform: scale(0.97);
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
          border-color: #b9dce5;
          background: #e9f8fb;
          color: #187d9d;
          box-shadow: 0 0 0 3px rgba(24,125,157,0.1);
        }

        /* ── Session list ────────────────────────────── */
        #${PANEL_ID} .skiprexa-session-list {
          margin: 8px 0 2px 38px;
          padding: 7px 10px;
          border-radius: 8px;
          background: #f7f9fc;
          border: 1px solid #e6ebf2;
        }
        #${PANEL_ID} .skiprexa-session-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 6px;
          padding: 4px 0;
          font-size: 12px;
          color: var(--sx-text-secondary);
        }
        #${PANEL_ID} .skiprexa-session-row:not(:last-child) {
          border-bottom: 1px solid #e8edf3;
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
          margin: 5px 0 0 38px;
          color: var(--sx-safe);
          font-size: 11px;
          font-weight: 600;
        }

        /* ── Actionable status ───────────────────────── */
        #${PANEL_ID} .skiprexa-outcome {
          display: flex;
          flex-direction: column;
          gap: 8px;
          --sx-state-color: #637188;
        }
        #${PANEL_ID} .skiprexa-outcome-copy {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          min-width: 0;
        }
        #${PANEL_ID} .skiprexa-status-dot {
          width: 8px;
          height: 8px;
          margin-top: 5px;
          border-radius: 50%;
          background: var(--sx-state-color);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--sx-state-color) 14%, transparent);
          flex: 0 0 auto;
        }
        #${PANEL_ID} .skiprexa-outcome-title,
        #${PANEL_ID} .skiprexa-outcome-detail {
          display: block;
        }
        #${PANEL_ID} .skiprexa-outcome-title {
          color: var(--sx-state-color);
          font-size: 13px;
          font-weight: 700;
          letter-spacing: -0.015em;
          line-height: 1.3;
        }
        #${PANEL_ID} .skiprexa-outcome-detail {
          margin-top: 1px;
          color: var(--sx-text-secondary);
          font-size: 11px;
          font-weight: 600;
          line-height: 1.35;
        }
        #${PANEL_ID} .skiprexa-outcome.is-safe { --sx-state-color: var(--sx-safe); }
        #${PANEL_ID} .skiprexa-outcome.is-risk,
        #${PANEL_ID} .skiprexa-outcome.is-limit { --sx-state-color: var(--sx-watch); }
        #${PANEL_ID} .skiprexa-outcome.is-below,
        #${PANEL_ID} .skiprexa-outcome.is-invalid { --sx-state-color: var(--sx-risk); }
        #${PANEL_ID} .skiprexa-meter {
          position: relative;
          display: block;
          width: 100%;
          height: 4px;
          border-radius: 999px;
          background: #e7ebf1;
        }
        #${PANEL_ID} .skiprexa-meter-fill {
          position: absolute;
          inset: 0 auto 0 0;
          max-width: 100%;
          border-radius: inherit;
          background: var(--sx-state-color);
          opacity: 0;
          transition: width 180ms var(--sx-ease-out), opacity 160ms ease;
        }
        #${PANEL_ID} .skiprexa-meter.has-value .skiprexa-meter-fill {
          opacity: 1;
        }
        #${PANEL_ID} .skiprexa-meter-target {
          position: absolute;
          top: -3px;
          bottom: -3px;
          width: 2px;
          border-radius: 2px;
          background: var(--sx-accent);
          box-shadow: 0 0 0 2px #ffffff;
          transform: translateX(-1px);
        }

        /* ── Total held input ────────────────────────── */
        #${PANEL_ID} .skiprexa-total-input {
          width: 100%;
          max-width: 108px;
          min-height: 38px;
          box-sizing: border-box;
          padding: 7px 9px;
          border: 1px solid #cdd6e2;
          border-radius: 9px;
          text-align: center;
          font-family: var(--sx-mono);
          font-size: 13px;
          font-weight: 700;
          color: var(--sx-text);
          background: #fbfcfe;
          outline: none;
          transition: border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease;
          -moz-appearance: textfield;
        }
        #${PANEL_ID} .skiprexa-total-input:focus-visible {
          border-color: var(--sx-accent);
          background: #ffffff;
          box-shadow: 0 0 0 3px rgba(23,33,58,0.12);
        }
        #${PANEL_ID} .skiprexa-total-input.is-valid:not(:focus) {
          border-color: #9bc8c3;
          background: #f4fbfa;
        }
        #${PANEL_ID} .skiprexa-total-input.is-invalid {
          border-color: #dc9099;
          background: #fff7f8;
          box-shadow: 0 0 0 3px rgba(201,79,92,0.08);
        }
        #${PANEL_ID} .skiprexa-total-input::placeholder {
          color: var(--sx-text-tertiary);
          font-weight: 600;
        }
        #${PANEL_ID} .skiprexa-total-input::-webkit-inner-spin-button,
        #${PANEL_ID} .skiprexa-total-input::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }

        @media (hover: hover) and (pointer: fine) {
          #${PANEL_ID} .skiprexa-collapse-button:hover {
            border-color: #e1e7ef;
            background: #eef2f7;
            color: var(--sx-accent);
          }
          #${PANEL_ID} .skiprexa-toggle-btn:hover:not(.active) {
            background: #e9edf3;
            color: var(--sx-text-secondary);
          }
          #${PANEL_ID} .skiprexa-info-button:hover {
            background: rgba(23,33,58,0.08);
            color: #ffffff;
            box-shadow: 0 0 0 3px rgba(23,33,58,0.1);
          }
          #${PANEL_ID} .skiprexa-info-button:hover > span {
            border-color: var(--sx-accent);
            background: var(--sx-accent);
          }
          #${PANEL_ID} .skiprexa-info-tip:hover:not(.is-dismissed) .skiprexa-tooltip {
            opacity: 1;
            visibility: visible;
            transform: translate(-50%, 0);
            transition-delay: 0s;
          }
          #${PANEL_ID} .skiprexa-info-tip--end:hover:not(.is-dismissed) .skiprexa-tooltip,
          #${PANEL_ID} .skiprexa-info-tip--above.skiprexa-info-tip--end:hover:not(.is-dismissed) .skiprexa-tooltip {
            transform: translateY(0);
          }
          #${PANEL_ID} .skiprexa-row:hover .skiprexa-cell {
            border-color: #dbe3ed;
            background: #fbfcfe;
          }
          #${PANEL_ID} .skiprexa-details > summary:hover .skiprexa-chevron {
            border-color: #cbd5e1;
            background: #eef2f7;
          }
          #${PANEL_ID} .skiprexa-details[open] > summary:hover .skiprexa-chevron {
            border-color: var(--sx-accent);
            background: var(--sx-accent);
          }
          #${PANEL_ID} .skiprexa-highlight-toggle:hover {
            border-color: #dce3ec;
            background: #eef2f7;
            color: var(--sx-accent);
          }
          #${PANEL_ID} .skiprexa-total-input:hover {
            border-color: #98a6b8;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          #${PANEL_ID} .skiprexa-info-button,
          #${PANEL_ID} .skiprexa-tooltip,
          #${PANEL_ID} .skiprexa-collapse-icon,
          #${PANEL_ID} .skiprexa-chevron,
          #${PANEL_ID} .skiprexa-meter-fill,
          #${PANEL_ID} .skiprexa-highlight-toggle,
          #${PANEL_ID} .skiprexa-toggle-btn,
          #${PANEL_ID} .skiprexa-collapse-button {
            transition: none;
            animation: none;
          }
        }
        @media (max-width: 840px) {
          #${PANEL_ID} {
            width: 100%;
            max-width: 100%;
            margin: 20px 0 12px !important;
            border-radius: 12px;
          }
          #${PANEL_ID} .skiprexa-header {
            align-items: flex-start;
            padding: 16px;
            border-radius: 12px 12px 0 0;
          }
          #${PANEL_ID}.is-collapsed .skiprexa-header {
            border-radius: 12px;
          }
          #${PANEL_ID} .skiprexa-heading {
            min-width: 0;
            flex-basis: 100%;
          }
          #${PANEL_ID} .skiprexa-header-actions {
            width: 100%;
            justify-content: space-between;
            align-items: flex-start;
          }
          #${PANEL_ID} .skiprexa-controls {
            flex-wrap: wrap;
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
            padding: 0;
            border-spacing: 0;
            background: transparent;
          }
          #${PANEL_ID} thead {
            display: none;
          }
          #${PANEL_ID} .skiprexa-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 0;
            margin-bottom: 10px;
            border: 1px solid var(--sx-border-subtle);
            border-radius: 10px;
            background: var(--sx-surface);
            overflow: hidden;
          }
          #${PANEL_ID} .skiprexa-row:last-child {
            margin-bottom: 0;
          }
          #${PANEL_ID} .skiprexa-row.is-pinned-highlight {
            border-color: rgba(24,125,157,0.5);
            background: var(--sx-surface);
            box-shadow: inset 3px 0 0 #187d9d;
          }
          #${PANEL_ID} .skiprexa-cell {
            min-width: 0;
            padding: 11px 12px;
            border: 0;
            border-radius: 0;
            background: transparent;
          }
          #${PANEL_ID} .skiprexa-cell:first-child,
          #${PANEL_ID} .skiprexa-cell:last-child {
            border: 0;
            border-radius: 0;
          }
          #${PANEL_ID} .skiprexa-row.is-pinned-highlight .skiprexa-cell {
            border-color: transparent;
            background: transparent;
          }
          #${PANEL_ID} .skiprexa-row.is-pinned-highlight .skiprexa-cell:first-child {
            box-shadow: none;
          }
          #${PANEL_ID} .skiprexa-cell-subject,
          #${PANEL_ID} .skiprexa-cell-status {
            grid-column: 1 / -1;
          }
          #${PANEL_ID} .skiprexa-cell-status {
            order: 2;
            padding-top: 4px;
            padding-bottom: 13px;
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
            font: 700 10px/1.2 var(--sx-mono);
            letter-spacing: 0.04em;
            text-transform: uppercase;
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
            width: 34px;
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
          #${PANEL_ID} .skiprexa-info-tip:not(.is-dismissed) .skiprexa-info-button:focus-visible + .skiprexa-tooltip,
          #${PANEL_ID} .skiprexa-info-tip.is-open:not(.is-dismissed) .skiprexa-tooltip,
          #${PANEL_ID} .skiprexa-info-tip--end:not(.is-dismissed) .skiprexa-info-button:focus-visible + .skiprexa-tooltip,
          #${PANEL_ID} .skiprexa-info-tip--end.is-open:not(.is-dismissed) .skiprexa-tooltip {
            transform: translateY(0);
          }
        }
        @media (max-width: 540px) {
          #${PANEL_ID} .skiprexa-title {
            font-size: 20px;
          }
          #${PANEL_ID} .skiprexa-header-actions,
          #${PANEL_ID} .skiprexa-controls {
            gap: 8px;
          }
          #${PANEL_ID} .skiprexa-header-actions {
            flex-wrap: wrap;
          }
          #${PANEL_ID} .skiprexa-control-group:last-child {
            order: 3;
          }
          #${PANEL_ID} .skiprexa-total-missed span {
            font-size: 0;
          }
          #${PANEL_ID} .skiprexa-total-missed span::after {
            content: "missed";
            font-size: 10.5px;
          }
          #${PANEL_ID} .skiprexa-session-list,
          #${PANEL_ID} .skiprexa-breakdown {
            margin-left: 0;
          }
        }

        /* ── Tile highlight ──────────────────────────── */
        .${TILE_HIGHLIGHT_CLASS} {
          outline: 2px solid #38b7d6 !important;
          outline-offset: -2px;
          box-shadow: inset 0 0 0 999px rgba(56,183,214,0.22), 0 0 0 1px rgba(24,125,157,0.9);
          transition: box-shadow 160ms ease, outline-color 160ms ease;
        }
        .${TILE_HIGHLIGHT_INFO_CLASS} {
          outline: 2px solid #8b73cf !important;
          outline-offset: -2px;
          box-shadow: inset 0 0 0 999px rgba(139,115,207,0.18), 0 0 0 1px rgba(102,78,174,0.82);
          transition: box-shadow 160ms ease, outline-color 160ms ease;
        }
      </style>

      <div class="skiprexa-header">
        <div class="skiprexa-heading">
          <div class="skiprexa-eyebrow"><span class="skiprexa-brand-mark" aria-hidden="true">S</span><span>SkipREXA</span><span class="skiprexa-eyebrow-divider">/</span><span>Semester view</span></div>
          <div class="skiprexa-title">Attendance analyzer</div>
          <div class="skiprexa-title-summary">${escapeHtml(analyzerSummary)}</div>
        </div>
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
              <span class="skiprexa-total-missed"><strong>${missedTotal}</strong><span>missed classes</span></span>
              ${infoTipHtml("skiprexa-tip-leave-types", "What counts as missed", "Only unapproved absences count here. Approved leave, duty leave, and duty attendance are excluded.", "end")}
            </div>
          </div>
          <button type="button" class="skiprexa-collapse-button" aria-expanded="${!analyzerCollapsed}" aria-controls="skiprexa-analyzer-body">
            <span>${analyzerCollapsed ? "Expand" : "Collapse"}</span>
            <svg class="skiprexa-collapse-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 7.5 4.5 4.5 4.5-4.5 1.4 1.4-5.9 5.9-5.9-5.9 1.4-1.4Z"/></svg>
          </button>
        </div>
        ${pinTipSeen ? "" : '<div class="skiprexa-highlight-help"><span class="skiprexa-help-icon" aria-hidden="true">↳</span><span>Pin a subject to trace its missed classes in the timetable below.</span></div>'}
      </div>

      <div id="skiprexa-analyzer-body" class="skiprexa-analyzer-body">
        <table>
          <thead>
            <tr>
              <th>Subject</th>
              <th style="width:280px;">Distance to target</th>
              <th style="width:96px;">Missed</th>
              <th style="width:132px;"><span class="skiprexa-heading-label">Needed total ${infoTipHtml("skiprexa-tip-total-needed", `Total needed for ${thresholdInt}%`, `The minimum total classes needed for your current missed classes to equal ${thresholdInt}% attendance.`)}</span></th>
              <th style="width:144px;">Classes held</th>
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
    syncPinnedSubjectsToPanel(panel);
    reconcileSubjectHighlights();
    // Commit only after the panel has been rebuilt and its listeners have
    // been attached.  A failed render therefore remains eligible for retry.
    lastRenderKey = renderKey;
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

  function clearScheduledBurstRenders() {
    for (const timerId of burstRenderTimers) window.clearTimeout(timerId);
    burstRenderTimers = [];
  }

  function clearScheduledUpdateTimers() {
    if (renderTimer !== null) {
      window.clearTimeout(renderTimer);
      renderTimer = null;
    }
    clearScheduledBurstRenders();
  }

  function scheduleRender(delay = 250) {
    if (!attendanceUiEnabled) return;
    if (!isSubmitTriggered) return;
    if (renderTimer !== null) window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => {
      renderTimer = null;
      renderSummary();
    }, delay);
  }

  function stopLateUpdateObserver() {
    if (lateUpdateObserver) {
      lateUpdateObserver.disconnect();
      lateUpdateObserver = null;
    }
    if (lateUpdateObserverTimer !== null) {
      window.clearTimeout(lateUpdateObserverTimer);
      lateUpdateObserverTimer = null;
    }
  }

  function startLateUpdateObserver(windowMs = 8000) {
    stopLateUpdateObserver();

    lateUpdateObserver = new MutationObserver((mutations) => {
      if (attendancePanel && !attendancePanel.isConnected) {
        scheduleRender(120);
        return;
      }

      const shouldRender = mutations.some((mutation) => {
        const target = mutation.target;
        if (target instanceof Element && target.closest(`#${PANEL_ID}`)) return false;
        for (const node of mutation.addedNodes) {
          if (node instanceof Element && node.closest?.(`#${PANEL_ID}`)) continue;
          return true;
        }
        for (const node of mutation.removedNodes) {
          if (node === attendancePanel || node.querySelector?.(`#${PANEL_ID}`)) return true;
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
    clearScheduledUpdateTimers();
    startLateUpdateObserver();
    scheduleRender(250);
    for (const delay of [700, 1400, 2500, 4000]) {
      burstRenderTimers.push(window.setTimeout(() => renderSummary(), delay));
    }
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
    document.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.matches('select[name="code"], input[name="code"], select#list1, input#list1')) return;
      if (isSubmitTriggered) scheduleRender(120);
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
