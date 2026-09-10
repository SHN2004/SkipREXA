const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const typescript = require("typescript");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");

function loadUploadModule(chrome, globals = {}) {
  const source = fs.readFileSync(path.join(repoRoot, "src/hooks/useUpload.ts"), "utf8");
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {};
  const context = {
    exports,
    chrome,
    console: { log() {}, warn() {}, error() {} },
    setTimeout(callback) {
      callback();
      return 0;
    },
    clearTimeout() {},
    require(moduleName) {
      if (moduleName === "../data-client") {
        return {
          getCourseId: (name, fallbackCode = "") => `${String(name).toLowerCase()}::${fallbackCode}`,
          normalizeCourseName: (name) => String(name).replace(/\s+/g, " ").trim(),
        };
      }
      return {};
    },
    ...globals,
  };
  vm.runInNewContext(output, context, { filename: "useUpload.ts" });
  return exports;
}

function createChrome({ uploadResponse, promptResponse = { success: true }, downloads = [] } = {}) {
  const sentMessages = [];
  let downloadIndex = 0;
  const chrome = {
    tabs: {
      async query() {
        return [{ id: 7, url: "https://chatgpt.com/c/test" }];
      },
      async sendMessage(tabId, message) {
        sentMessages.push(message);
        if (message.action === "uploadPDFs") return uploadResponse;
        if (message.action === "injectPrompt") return promptResponse;
        return { success: true };
      },
    },
    runtime: {
      async sendMessage(message) {
        if (message.action === "downloadPDF") {
          return downloads[downloadIndex++] || { success: false, error: "Download failed" };
        }
        return { success: true };
      },
    },
    scripting: {
      async executeScript() {
        return [{ result: { ok: true } }];
      },
    },
  };
  chrome.sentMessages = sentMessages;
  return chrome;
}

function paper(id, courseName = "Course") {
  return {
    id,
    course_name: courseName,
    exam_type: "Regular",
    exam_month: "June",
    exam_year: 2025,
    download_url: `https://example.test/${id}.pdf`,
  };
}

test("processUpload reports partial attachment outcomes and prompts only for confirmed papers", async () => {
  const chrome = createChrome({
    downloads: [
      { success: true, base64Data: "JVBERg==" },
      { success: true, base64Data: "JVBERg==" },
    ],
    uploadResponse: {
      success: true,
      outcomes: [
        { paperId: "p1", status: "attached" },
        { paperId: "p2", status: "unconfirmed", error: "No stable attachment" },
      ],
    },
  });
  const { processUpload } = loadUploadModule(chrome);

  const courses = [
    { id: "course one::", name: "Course One", code: "", semesters: [], searchText: "course one" },
    { id: "course two::", name: "Course Two", code: "", semesters: [], searchText: "course two" },
  ];
  const result = await processUpload([paper("p1", "Course One"), paper("p2", "Course Two")], courses, "model", () => {});

  assert.equal(result.attachedCount, 1);
  assert.deepEqual(result.outcomes.map((outcome) => outcome.status), ["attached", "unconfirmed"]);
  assert.equal(result.prompt.status, "inserted");
  const promptMessage = chrome.sentMessages.find((message) => message.action === "injectPrompt");
  assert.match(promptMessage.prompt, /uploaded 1 question papers/);
  assert.match(promptMessage.prompt, /Course One/);
  assert.doesNotMatch(promptMessage.prompt, /Course Two/);
  assert.doesNotMatch(promptMessage.prompt, /uploaded 2 question papers/);
});

test("processUpload returns download failures without attempting attachment or prompt injection", async () => {
  const chrome = createChrome({
    downloads: [
      { success: false, code: "CERT_ERROR", error: "Certificate validation failed" },
      { success: false, error: "Offline" },
    ],
    uploadResponse: { success: true },
  });
  const { processUpload } = loadUploadModule(chrome);

  const result = await processUpload([paper("p1"), paper("p2")], [], "model", () => {});

  assert.equal(result.attachedCount, 0);
  assert.deepEqual(result.outcomes.map((outcome) => outcome.status), ["failed", "failed"]);
  assert.equal(result.outcomes[0].stage, "download");
  assert.equal(result.prompt.status, "skipped");
  assert.equal(chrome.sentMessages.some((message) => message.action === "uploadPDFs"), false);
  assert.equal(chrome.sentMessages.some((message) => message.action === "injectPrompt"), false);
});

test("processUpload treats a missing upload response as unconfirmed", async () => {
  const chrome = createChrome({
    downloads: [{ success: true, base64Data: "JVBERg==" }],
    uploadResponse: undefined,
  });
  const { processUpload } = loadUploadModule(chrome);

  const result = await processUpload([paper("p1")], [], "model", () => {});

  assert.equal(result.attachedCount, 0);
  assert.equal(result.outcomes[0].status, "unconfirmed");
  assert.equal(result.prompt.status, "skipped");
});

test("processUpload does not trust a success response without per-paper evidence", async () => {
  const chrome = createChrome({
    downloads: [{ success: true, base64Data: "JVBERg==" }],
    uploadResponse: { success: true },
  });
  const { processUpload } = loadUploadModule(chrome);

  const result = await processUpload([paper("p1")], [], "model", () => {});

  assert.equal(result.attachedCount, 0);
  assert.equal(result.outcomes[0].status, "unconfirmed");
  assert.equal(result.prompt.status, "skipped");
});

test("processUpload keeps attachment success when prompt insertion fails", async () => {
  const chrome = createChrome({
    downloads: [{ success: true, base64Data: "JVBERg==" }],
    uploadResponse: {
      success: true,
      outcomes: [{ paperId: "p1", status: "attached" }],
    },
    promptResponse: { success: false, error: "Composer was unavailable" },
  });
  const { processUpload } = loadUploadModule(chrome);

  const result = await processUpload([paper("p1")], [], "model", () => {});

  assert.equal(result.attachedCount, 1);
  assert.equal(result.outcomes[0].status, "attached");
  assert.equal(result.prompt.status, "failed");
  assert.match(result.prompt.reason, /Composer was unavailable/);
});

class FakeElement {
  constructor({ attributes = {}, textContent = "", className = "", onDispatch } = {}) {
    this.attributes = { ...attributes };
    this.textContent = textContent;
    this.className = className;
    this.parentElement = null;
    this.offsetParent = {};
    this.offsetLeft = 0;
    this.offsetTop = 0;
    this.onDispatch = onDispatch;
  }

  getAttribute(name) {
    if (name === "class") return this.className;
    return this.attributes[name] ?? null;
  }

  querySelectorAll() {
    return [];
  }

  dispatchEvent(event) {
    this.onDispatch?.(event);
    return true;
  }
}

function loadContentListener({ addCardOnDrop = true, initialCards = [] } = {}) {
  let simulatedNow = 0;
  let listener;
  let composer;
  const cards = [...initialCards];
  const addCard = (fileName) => {
    const card = new FakeElement({
      attributes: { "data-testid": "file-attachment" },
      className: "file-card",
      textContent: fileName,
    });
    card.parentElement = composer;
    cards.push(card);
  };

  composer = new FakeElement({ attributes: { "data-testid": "chat-input" } });
  composer.querySelectorAll = () => cards;
  composer.onDispatch = (event) => {
    if (event.type === "drop" && addCardOnDrop) addCard(event.dataTransfer?.items?.fileName || "paper.pdf");
  };
  for (const card of cards) card.parentElement = composer;

  const document = {
    body: composer,
    querySelector(selector) {
      return selector === '[data-testid="chat-input"]' ? composer : null;
    },
    querySelectorAll(selector) {
      return selector === '[data-testid="chat-input"]' ? [composer] : [];
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const chrome = {
    runtime: {
      onMessage: {
        addListener(callback) {
          listener = callback;
        },
      },
    },
  };
  class DataTransfer {
    constructor() {
      this.items = {
        fileName: "paper.pdf",
        add: (file) => {
          this.items.fileName = file.name;
        },
      };
    }
  }
  class DragEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.dataTransfer = options.dataTransfer;
    }
    preventDefault() {}
  }
  class Event {
    constructor(type) {
      this.type = type;
    }
    preventDefault() {}
  }
  const context = {
    window: { location: { hostname: "chatgpt.com" } },
    document,
    chrome,
    console: { log() {}, warn() {}, error() {} },
    DataTransfer,
    DragEvent,
    Event,
    File,
    Blob,
    Uint8Array,
    atob,
    setTimeout(callback, delay = 0) {
      simulatedNow += delay;
      callback();
      return 0;
    },
    clearTimeout() {},
    Date: { now: () => simulatedNow },
  };
  vm.runInNewContext(fs.readFileSync(path.join(repoRoot, "src/content.js"), "utf8"), context, {
    filename: "content.js",
  });
  return {
    async upload(pdf) {
      return new Promise((resolve) => {
        listener({ action: "uploadPDFs", pdfs: [pdf] }, {}, resolve);
      });
    },
  };
}

function loadClaudeUpload({ addCardOnChange = true, thumbnailOutsideComposer = false, existingThumbnail = false, removable = true, busy = false } = {}) {
  let simulatedNow = 0;
  const cards = [];
  const composer = new FakeElement({
    attributes: { "data-testid": "chat-input-grid-container" },
  });
  const input = new FakeElement({
    attributes: { type: "file", "data-testid": "file-upload" },
  });
  input.files = [];
  const thumbnails = [];
  const addThumbnail = (name) => {
    // Captured Claude markup: filename lives on img.alt and the remove button,
    // while the file-thumbnail wrapper's textContent is only "pdf".
    const card = new FakeElement({ attributes: { "data-testid": "file-thumbnail", "aria-busy": busy ? "true" : "false" }, className: "group/thumbnail relative", textContent: "pdf" });
    const img = new FakeElement({ attributes: { alt: name, src: "/api/test/files/test/thumbnail" }, className: "w-full h-full object-contain transition duration-400 opacity-100" });
    const remove = new FakeElement({ attributes: { "aria-label": `Remove ${name}` } });
    img.parentElement = card;
    remove.parentElement = card;
    card.querySelectorAll = (selector) => selector === 'img[alt]' ? [img] : selector === 'button[aria-label]' ? (removable ? [remove] : []) : [];
    thumbnails.push(card);
  };
  if (existingThumbnail) addThumbnail("Course_Regular_June_2025.pdf");
  composer.querySelectorAll = () => cards;
  input.dispatchEvent = (event) => {
    if (event.type !== "change" || !addCardOnChange) return true;
    const file = input.files?.[0];
    if (thumbnailOutsideComposer) {
      addThumbnail(file.name);
      return true;
    }
    const card = new FakeElement({
      attributes: { "data-testid": "file-attachment" },
      className: "file-card",
      textContent: file?.name || "paper.pdf",
    });
    card.parentElement = composer;
    cards.push(card);
    return true;
  };

  const document = {
    body: composer,
    querySelector(selector) {
      if (selector === '[data-testid="chat-input-grid-container"]') return composer;
      if (selector.startsWith('input[type="file"]')) return input;
      return null;
    },
    querySelectorAll(selector) {
      return selector === '[data-testid="file-thumbnail"]' ? thumbnails : [];
    },
  };
  const chrome = {
    tabs: {
      async query() {
        return [{ id: 8, url: "https://claude.ai/chat/test" }];
      },
      async sendMessage() {
        return { success: true };
      },
    },
    runtime: {
      async sendMessage(message) {
        return message.action === "downloadPDF"
          ? { success: true, base64Data: "JVBERg==" }
          : { success: true };
      },
    },
    scripting: {
      async executeScript(options) {
        return [{ result: await options.func(...options.args) }];
      },
    },
  };
  class DataTransfer {
    constructor() {
      this.items = {
        file: null,
        add: (file) => {
          this.items.file = file;
        },
      };
      Object.defineProperty(this, "files", {
        get: () => this.items.file ? [this.items.file] : [],
      });
    }
  }
  class Event {
    constructor(type) {
      this.type = type;
    }
  }

  const exports = loadUploadModule(chrome, {
    document,
    DataTransfer,
    Event,
    File,
    Blob,
    Uint8Array,
    atob,
    setTimeout(callback, delay = 0) {
      simulatedNow += delay;
      callback();
      return 0;
    },
    Date: { now: () => simulatedNow },
  });
  return { exports, input, cards };
}

test("ChatGPT content adapter confirms a new matching attachment", async () => {
  const content = loadContentListener();
  const result = await content.upload({ id: "p1", name: "paper.pdf", data: "JVBERg==" });

  assert.equal(result.success, true);
  assert.equal(result.uploadedCount, 1);
  assert.equal(result.outcomes[0].status, "attached");
});

test("ChatGPT content adapter marks dispatch without matching evidence unconfirmed", async () => {
  const content = loadContentListener({ addCardOnDrop: false });
  const result = await content.upload({ id: "p1", name: "paper.pdf", data: "JVBERg==" });

  assert.equal(result.success, false);
  assert.equal(result.uploadedCount, 0);
  assert.equal(result.outcomes[0].status, "unconfirmed");
});

test("ChatGPT content adapter does not count a pre-existing same-name attachment", async () => {
  const existing = new FakeElement({
    attributes: { "data-testid": "file-attachment" },
    className: "file-card",
    textContent: "paper.pdf",
  });
  const content = loadContentListener({ addCardOnDrop: false, initialCards: [existing] });
  const result = await content.upload({ id: "p1", name: "paper.pdf", data: "JVBERg==" });

  assert.equal(result.outcomes[0].status, "unconfirmed");
});

test("Claude MAIN-world adapter confirms an attachment and restores the file input", async () => {
  const harness = loadClaudeUpload();
  const result = await harness.exports.processUpload([paper("p1")], [], "general", () => {});

  assert.equal(result.attachedCount, 1);
  assert.equal(result.outcomes[0].status, "attached");
  assert.equal(Object.prototype.hasOwnProperty.call(harness.input, "files"), false);
  assert.equal(harness.cards.length, 1);
});

test("Claude MAIN-world adapter marks missing evidence unconfirmed and still restores the file input", async () => {
  const harness = loadClaudeUpload({ addCardOnChange: false });
  const result = await harness.exports.processUpload([paper("p1")], [], "general", () => {});

  assert.equal(result.attachedCount, 0);
  assert.equal(result.outcomes[0].status, "unconfirmed");
  assert.equal(Object.prototype.hasOwnProperty.call(harness.input, "files"), false);
});
