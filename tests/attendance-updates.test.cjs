const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.resolve(__dirname, "..");
const attendanceSource = fs.readFileSync(
  path.join(repoRoot, "src/attendance-content.js"),
  "utf8"
);

const HIGHLIGHT_CLASS = "skiprexa-subject-tile-highlight";
const INFO_HIGHLIGHT_CLASS = "skiprexa-subject-tile-highlight-info";
const STORAGE_KEY = "skiprexa-attendance-data";
const SETTINGS_KEY = "skiprexa_attendance_ui_enabled";

function createClock(window) {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  window.setTimeout = (callback, delay = 0) => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, Number(delay) || 0), callback });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);

  function advance(milliseconds) {
    now += milliseconds;
    while (true) {
      const due = Array.from(timers.entries())
        .filter(([, timer]) => timer.at <= now)
        .sort(([, first], [, second]) => first.at - second.at);
      if (!due.length) return;
      for (const [id, timer] of due) {
        if (!timers.has(id)) continue;
        timers.delete(id);
        timer.callback();
      }
    }
  }

  return {
    advance,
    pendingCount: () => timers.size,
  };
}

function tableHtml({ subject = "COURSE/CS101", date = "01-Jan-2026", id = "attendance", hasLeave = true } = {}) {
  return `<table id="${id}">
    <tbody>
      <tr><th>Date/Hours</th><th>1</th><th>2</th><th>3</th><th>4</th></tr>
      ${hasLeave ? `<tr><td>${date}</td><td bgcolor="#b00000">${subject}</td><td></td><td></td><td></td></tr>` : ""}
    </tbody>
  </table>`;
}

function createHarness({
  code = "CLASS1",
  includeCodeInUrl = true,
  subjectCache = {},
  fetch: fetchImpl,
} = {}) {
  const url = `https://student.rajagiritech.ac.in/stud/demo/Student/Leave.asp${includeCodeInUrl ? `?code=${code}` : ""}`;
  const dom = new JSDOM(
    `<form id="class-form"><input name="code" value="${code}"><button type="submit">Submit</button></form>${tableHtml()}`,
    { url, runScripts: "outside-only", pretendToBeVisual: true }
  );
  const { window } = dom;
  const clock = createClock(window);
  const storageChanges = [];
  const storage = {
    [SETTINGS_KEY]: true,
  };
  const changeListeners = [];

  window.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, storage[key]]));
          }
          return { ...storage };
        },
        async set(values) {
          Object.assign(storage, values);
        },
      },
      onChanged: {
        addListener(listener) {
          changeListeners.push(listener);
        },
      },
    },
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ subjectNameCache: subjectCache }));
  window.fetch = fetchImpl || (async () => ({ text: async () => "" }));
  window.eval(attendanceSource);

  async function settle() {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  async function renderInitial() {
    await settle();
    clock.advance(250);
    await settle();
  }

  async function reconcileAfterMutation(delay = 120) {
    await settle();
    clock.advance(delay);
    await settle();
  }

  function setAttendanceUiEnabled(enabled) {
    storage[SETTINGS_KEY] = enabled;
    const change = { [SETTINGS_KEY]: { newValue: enabled, oldValue: !enabled } };
    storageChanges.push(change);
    for (const listener of changeListeners) listener(change, "local");
  }

  return {
    dom,
    window,
    clock,
    storage,
    storageChanges,
    renderInitial,
    reconcileAfterMutation,
    setAttendanceUiEnabled,
    settle,
  };
}

function currentTableCell(window) {
  return window.document.querySelector("#attendance tr:nth-child(2) td:nth-child(2)");
}

function panel(window) {
  return window.document.getElementById("skiprexa-attendance-summary");
}

function pinSubject(window) {
  const button = panel(window).querySelector('.skiprexa-highlight-toggle[data-subject="CS101"]');
  assert.ok(button, "expected a pin button for CS101");
  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

test("identical table replacement clears detached highlights and highlights current cells", async (t) => {
  const harness = createHarness();
  t.after(() => harness.dom.window.close());
  await harness.renderInitial();

  pinSubject(harness.window);
  const oldCell = currentTableCell(harness.window);
  assert.equal(oldCell.classList.contains(HIGHLIGHT_CLASS), true);

  const oldTable = harness.window.document.getElementById("attendance");
  oldTable.outerHTML = tableHtml({ id: "attendance" });
  await harness.reconcileAfterMutation();

  const newCell = currentTableCell(harness.window);
  assert.notEqual(newCell, oldCell);
  assert.equal(oldCell.classList.contains(HIGHLIGHT_CLASS), false);
  assert.equal(oldCell.classList.contains(INFO_HIGHLIGHT_CLASS), false);
  assert.equal(newCell.classList.contains(HIGHLIGHT_CLASS), true);

  harness.window.document.getElementById("attendance").outerHTML = tableHtml({ id: "attendance", hasLeave: false });
  await harness.reconcileAfterMutation();
  assert.equal(newCell.classList.contains(HIGHLIGHT_CLASS), false);
  assert.match(panel(harness.window).textContent, /No missed class hours/);
});

test("replacing cells in place preserves the summary input and focus", async (t) => {
  const harness = createHarness();
  t.after(() => harness.dom.window.close());
  await harness.renderInitial();

  const input = panel(harness.window).querySelector(".skiprexa-total-input");
  input.value = "20";
  pinSubject(harness.window);
  input.focus();
  const oldCell = currentTableCell(harness.window);
  oldCell.outerHTML = '<td bgcolor="#b00000">COURSE/CS101</td>';
  await harness.reconcileAfterMutation();

  assert.equal(panel(harness.window).querySelector(".skiprexa-total-input"), input);
  assert.equal(input.value, "20");
  assert.equal(harness.window.document.activeElement, input);
  assert.equal(currentTableCell(harness.window).classList.contains(HIGHLIGHT_CLASS), true);
});

test("hover state is reconciled onto replacement cells and mouseleave clears it", async (t) => {
  const harness = createHarness();
  t.after(() => harness.dom.window.close());
  await harness.renderInitial();

  const row = panel(harness.window).querySelector('tr[data-subject="CS101"]');
  row.dispatchEvent(new harness.window.MouseEvent("mouseenter", { bubbles: true }));
  const oldCell = currentTableCell(harness.window);
  assert.equal(oldCell.classList.contains(HIGHLIGHT_CLASS), true);

  harness.window.document.getElementById("attendance").outerHTML = tableHtml({ id: "attendance" });
  await harness.reconcileAfterMutation();
  const newCell = currentTableCell(harness.window);
  assert.equal(newCell.classList.contains(HIGHLIGHT_CLASS), true);

  row.dispatchEvent(new harness.window.MouseEvent("mouseleave", { bubbles: true }));
  assert.equal(newCell.classList.contains(HIGHLIGHT_CLASS), false);

  const button = panel(harness.window).querySelector('.skiprexa-highlight-toggle[data-subject="CS101"]');
  button.dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(newCell.classList.contains(HIGHLIGHT_CLASS), true);
  button.dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(newCell.classList.contains(HIGHLIGHT_CLASS), false);
});

test("a cached class switch rebuilds labels even when entries are unchanged", async (t) => {
  const subjectCache = {
    CLASS1: { fetchedAt: Date.now(), subjects: { CS101: { name: "Class One" } } },
    CLASS2: { fetchedAt: Date.now(), subjects: { CS101: { name: "Class Two" } } },
  };
  const harness = createHarness({ includeCodeInUrl: false, subjectCache });
  t.after(() => harness.dom.window.close());
  await harness.settle();
  harness.window.document.querySelector("form").dispatchEvent(new harness.window.Event("submit", { bubbles: true }));
  await harness.renderInitial();

  assert.match(panel(harness.window).querySelector(".skiprexa-subject-name").textContent, /Class One/);
  const input = harness.window.document.querySelector('input[name="code"]');
  input.value = "CLASS2";
  input.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  await harness.reconcileAfterMutation();

  assert.match(panel(harness.window).querySelector(".skiprexa-subject-name").textContent, /Class Two/);
});

test("changed attendance data and target threshold rebuild the summary", async (t) => {
  const harness = createHarness();
  t.after(() => harness.dom.window.close());
  await harness.renderInitial();

  const originalPanel = panel(harness.window);
  const originalInput = originalPanel.querySelector(".skiprexa-total-input");
  assert.equal(originalPanel.querySelector(".skiprexa-min-total").textContent, "4");
  originalPanel.querySelector('.skiprexa-toggle-btn[data-threshold="80"]').dispatchEvent(
    new harness.window.MouseEvent("click", { bubbles: true })
  );
  await harness.settle();

  const thresholdPanel = panel(harness.window);
  assert.equal(thresholdPanel, originalPanel);
  assert.notEqual(thresholdPanel.querySelector(".skiprexa-total-input"), originalInput);
  assert.equal(thresholdPanel.querySelector(".skiprexa-min-total").textContent, "5");

  harness.window.document.getElementById("attendance").outerHTML = tableHtml({ subject: "COURSE/CS102", id: "attendance" });
  await harness.reconcileAfterMutation();
  assert.equal(panel(harness.window).querySelector('tr[data-subject="CS102"]') !== null, true);
  assert.equal(panel(harness.window).querySelector('tr[data-subject="CS101"]'), null);
});

test("late subject lookups are rendered for the current class and stop when disabled", async (t) => {
  const pendingMarkRequests = new Map();
  const harness = createHarness({
    includeCodeInUrl: false,
    fetch: async (url) => {
      if (url.startsWith("gethint4.asp")) return { text: async () => '<option value="EXAM1">Exam</option>' };
      const classCode = new URL(url, "https://student.rajagiritech.ac.in/").searchParams.get("code");
      return new Promise((resolve) => pendingMarkRequests.set(classCode, resolve));
    },
  });
  t.after(() => harness.dom.window.close());
  await harness.settle();
  harness.window.document.querySelector("form").dispatchEvent(new harness.window.Event("submit", { bubbles: true }));
  await harness.renderInitial();
  assert.ok(pendingMarkRequests.has("CLASS1"));

  const input = harness.window.document.querySelector('input[name="code"]');
  input.value = "CLASS2";
  input.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  await harness.reconcileAfterMutation();
  assert.ok(pendingMarkRequests.has("CLASS2"));

  pendingMarkRequests.get("CLASS1")({
    text: async () => '<table><tr><th>#</th><th>Code</th><th>Subject</th></tr><tr><td>1</td><td>COURSE/CS101</td><td>Class One</td></tr></table>',
  });
  await harness.settle();
  assert.match(panel(harness.window).querySelector(".skiprexa-subject-name").textContent, /CS101/);

  harness.setAttendanceUiEnabled(false);
  assert.equal(panel(harness.window), null);
  pendingMarkRequests.get("CLASS2")({
    text: async () => '<table><tr><th>#</th><th>Code</th><th>Subject</th></tr><tr><td>1</td><td>COURSE/CS101</td><td>Class Two</td></tr></table>',
  });
  await harness.settle();
  assert.equal(panel(harness.window), null);
});

test("removed panels recover during the active observation window and disabling cancels work", async (t) => {
  const harness = createHarness();
  t.after(() => harness.dom.window.close());
  await harness.renderInitial();
  const originalPanel = panel(harness.window);
  originalPanel.remove();
  await harness.reconcileAfterMutation();

  const restoredPanel = panel(harness.window);
  assert.ok(restoredPanel);
  assert.notEqual(restoredPanel, originalPanel);

  harness.setAttendanceUiEnabled(false);
  assert.equal(panel(harness.window), null);
  harness.clock.advance(10000);
  await harness.settle();
  assert.equal(panel(harness.window), null);

  harness.setAttendanceUiEnabled(true);
  await harness.settle();
  harness.clock.advance(250);
  await harness.settle();
  assert.ok(panel(harness.window));
});

test("the late update observer expires after eight seconds", async (t) => {
  const harness = createHarness();
  t.after(() => harness.dom.window.close());
  await harness.renderInitial();
  pinSubject(harness.window);
  harness.clock.advance(8000);
  await harness.settle();
  assert.equal(harness.clock.pendingCount(), 0);

  harness.window.document.getElementById("attendance").outerHTML = tableHtml({ id: "attendance" });
  await harness.settle();
  assert.equal(currentTableCell(harness.window).classList.contains(HIGHLIGHT_CLASS), false);
});
