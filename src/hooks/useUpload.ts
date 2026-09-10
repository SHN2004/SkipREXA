import { Paper } from "./usePapers";
import { Course } from "./useCourses";
import { getCourseId, normalizeCourseName } from "../data-client";

// These constants match the ones in old popup.js
const CLAUDE_KNOWN_TEST_IDS = [
  "chat-input-grid-container",
  "chat-input-grid-area",
  "prompt-input-ssr-interactive",
  "chat-input-ssr",
  "file-upload",
  "chat-input",
  "model-selector-dropdown",
];

const CLAUDE_COMPOSER_CONTAINER_SELECTORS = [
  '[data-testid="chat-input-grid-container"]',
  '[data-testid="chat-input"]',
  "main",
];

const CLAUDE_FILE_INPUT_SELECTORS = [
  'input[type="file"][data-testid="file-upload"]',
  'input[type="file"]#chat-input-file-upload-onpage',
  'input[type="file"][aria-label*="Upload"]',
  'input[type="file"][aria-label*="upload"]',
  'input[type="file"]',
];

const CLAUDE_COMPOSER_INPUT_SELECTORS = [
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"][aria-label="Write your prompt to Claude"]',
  '[contenteditable="true"][aria-label*="Write your prompt"]',
  'textarea[data-testid="chat-input-ssr"]',
  'textarea[aria-label="Write your prompt to Claude"]',
  'textarea[aria-label*="Write your prompt"]',
  'textarea[placeholder*="help you"]',
  "textarea",
];

type DownloadPdfResponse =
  | {
      success: true;
      base64Data?: string;
      source?: string;
      isNativeDownload?: boolean;
      downloadId?: number;
      code?: undefined;
      error?: undefined;
    }
  | {
      success?: false;
      code?: string;
      error?: string;
      details?: unknown;
      nativeDownload?: {
        downloadId?: number;
        filename?: string | null;
        finalUrl?: string | null;
      };
    };

export type UploadPaperStatus = "attached" | "failed" | "unconfirmed";
export type UploadPaperStage = "download" | "attachment";

export type UploadPaperOutcome = {
  paper: Paper;
  paperId: string;
  filename: string;
  status: UploadPaperStatus;
  stage: UploadPaperStage;
  reason?: string;
};

export type UploadPromptOutcome = {
  status: "inserted" | "failed" | "skipped";
  reason?: string;
};

export type UploadResult = {
  attemptedCount: number;
  attachedCount: number;
  outcomes: UploadPaperOutcome[];
  prompt: UploadPromptOutcome;
};

type DownloadedPdf = {
  key: string;
  paper: Paper;
  name: string;
  base64Data: string;
};

type UploadAdapterResponse = {
  success?: boolean;
  error?: string;
  uploadedCount?: number;
  outcomes?: unknown[];
};

type UploadAdapterOutcome = {
  paperId?: string;
  name?: string;
  status?: string;
  error?: string;
  reason?: string;
};

function getPaperKey(paper: Paper, index: number) {
  return paper.id || `selected-paper-${index}`;
}

function getPaperCourseId(paper: Paper) {
  const fallbackCode = (paper.actual_subject_code || paper.course_code || paper.question_paper_code || "").trim();
  return getCourseId(paper.course_name, fallbackCode);
}

function getCoursesForPapers(courses: Course[], papers: Paper[]) {
  const paperCourseIds = new Set(papers.map(getPaperCourseId));
  const paperCourseNames = new Set(papers.map((paper) => normalizeCourseName(paper.course_name).toLowerCase()));
  return courses.filter((course) => {
    const courseId = course.id || getCourseId(course.name, course.code);
    return paperCourseIds.has(courseId) || paperCourseNames.has(normalizeCourseName(course.name).toLowerCase());
  });
}

function createPaperOutcome(
  paper: Paper,
  filename: string,
  status: UploadPaperStatus,
  stage: UploadPaperStage,
  reason?: string,
): UploadPaperOutcome {
  return {
    paper,
    paperId: paper.id,
    filename,
    status,
    stage,
    ...(reason ? { reason } : {}),
  };
}

function normalizeAdapterStatus(status: unknown): UploadPaperStatus | null {
  return status === "attached" || status === "failed" || status === "unconfirmed" ? status : null;
}

function normalizeAttachmentOutcomes(
  downloadedPapers: DownloadedPdf[],
  response: UploadAdapterResponse | null | undefined,
): UploadPaperOutcome[] {
  const rawOutcomes = Array.isArray(response?.outcomes)
    ? response.outcomes as UploadAdapterOutcome[]
    : [];
  const outcomesByPaperId = new Map(rawOutcomes.filter((outcome) => outcome?.paperId).map((outcome) => [outcome.paperId, outcome]));
  const fallbackStatus: UploadPaperStatus = response == null || response.success !== false ? "unconfirmed" : "failed";
  const fallbackReason = response?.error || (
    response == null
      ? "The upload response was unavailable, so the attachment could not be confirmed."
      : "The upload adapter did not return a per-paper outcome."
  );

  return downloadedPapers.map((downloaded, index) => {
    const rawOutcome = outcomesByPaperId.get(downloaded.paper.id) || rawOutcomes[index];
    const status = normalizeAdapterStatus(rawOutcome?.status) || fallbackStatus;
    const reason = rawOutcome?.error || rawOutcome?.reason || (status === "attached" ? undefined : fallbackReason);
    return createPaperOutcome(downloaded.paper, downloaded.name, status, "attachment", reason);
  });
}

function formatDownloadFailureMessage(fileName: string, response: DownloadPdfResponse | null | undefined) {
  const prefix = fileName ? `${fileName}: ` : "";

  if (!response) {
    return `${prefix}Download failed with no response from the background script.`;
  }

  if (response.code === "CERT_ERROR") {
    return `${prefix}Chrome blocked the PDF because the source site certificate is invalid. Open the PDF in a normal tab, accept the warning only if you trust the site, then attach the downloaded file manually.`;
  }

  if (response.code === "NATIVE_DOWNLOAD_ONLY") {
    return `${prefix}${response.error || "Chrome could only save the file to Downloads, not attach it directly."}`;
  }

  if (typeof response.error === "string" && response.error.trim()) {
    return `${prefix}${response.error}`;
  }

  return `${prefix}Download failed.`;
}

function formatDownloadFailureReason(fileName: string, response: DownloadPdfResponse | null | undefined) {
  const message = formatDownloadFailureMessage(fileName, response);
  const prefix = `${fileName}: `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

export function generateCustomPrompt(studyPurpose: string, selectedCourses: Course[], selectedPapers: Paper[]) {
  if (studyPurpose === "general") return "";

  const courseName = selectedCourses.length > 0
    ? selectedCourses.map(c => c.name).join(", ")
    : "these courses";

  const paperCount = selectedPapers.length;

  const promptTemplates: Record<string, string> = {
    internal_1: `I'm studying for my Internal 1 exam and have uploaded ${paperCount} end semester question papers for ${courseName} for reference. My Internal 1 will have:
- Section A: 4 questions (5 marks each) 
- Section B: 4 questions (2 main questions, each with OR options, 15 marks each)

Internal 1 typically covers Modules 1 and 2, but my teacher may have assigned different modules.

Before we start, please ask me:
1. Which specific modules are covered in my Internal 1 exam?
2. How much time do I have to prepare for this exam?
3. What's my preferred study approach: (a) Practice solving questions, (b) Understand concepts through questions, (c) Create study notes from questions, or (d) Mixed approach?

Since I've uploaded end semester question papers, I need you to filter the relevant questions based on my modules. The end semester paper structure is: Section A has questions 1-2 (Module 1), 3-4 (Module 2), 5-6 (Module 3), 7-8 (Module 4), 9-10 (Module 5). Section B has questions 11-12 (Module 1 with OR), 13-14 (Module 2 with OR), 15-16 (Module 3 with OR), 17-18 (Module 4 with OR), 19-20 (Module 5 with OR). Please identify and focus on questions from my specified modules only.`,
    internal_2: `I'm studying for my Internal 2 exam and have uploaded ${paperCount} end semester question papers for ${courseName} for reference. My Internal 2 will have:
- Section A: 4 questions (5 marks each)
- Section B: 4 questions (2 main questions, each with OR options, 15 marks each)

Internal 2 typically covers Modules 3 and 4, but my teacher may have assigned different modules.

Before we start, please ask me:
1. Which specific modules are covered in my Internal 2 exam?
2. How much time do I have to prepare for this exam?
3. What's my preferred study approach: (a) Practice solving questions, (b) Understand concepts through questions, (c) Create study notes from questions, or (d) Mixed approach?

Since I've uploaded end semester question papers, I need you to filter the relevant questions based on my modules.`,
    model: `I'm studying for my End Semester exam and have uploaded ${paperCount} question papers for ${courseName} for reference. My End Semester exam will have:
- Section A: 10 questions (2 from each of the 5 modules)
- Section B: 10 questions (5 main questions, each with OR options)

Before we start, please ask me:
1. Are there any specific modules I want to focus on more, or should we cover all 5 modules equally?
2. How much time do I have to prepare for this exam?
3. What's my preferred study approach: (a) Practice solving questions, (b) Understand concepts through questions, (c) Create study notes from questions, (d) Focus on frequently asked questions, or (e) Mixed approach?

Once you know this, please help me create a comprehensive study plan covering all modules according to my study approach and time constraint, using the uploaded question papers as reference.`,
  };

  return promptTemplates[studyPurpose] || "";
}

async function uploadPdfToClaudeMainWorld(tabId: number, pdf: any) {
  let response: any;
  try {
    // @ts-ignore
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (pdfArg: any, knownTestIdList: any, containerSelectorList: any, fileInputSelectorList: any) => {
        const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
        const knownTestIds = new Set(Array.isArray(knownTestIdList) ? knownTestIdList : [])
        const containerSelectors = Array.isArray(containerSelectorList) ? containerSelectorList : []
        const fileInputSelectors = Array.isArray(fileInputSelectorList) ? fileInputSelectorList : []
        const cardSelectors = [
          '[data-testid*="attachment"]',
          '[data-testid*="file"]',
          '[data-testid*="upload"]',
          '[data-filename]',
          '[data-file-name]',
          '[role="listitem"]',
          '[class*="attachment"]',
          '[class*="file"]',
          '[aria-label]',
          '[title]',
          'img[alt]'
        ]
        const processingPattern = /\b(uploading|processing|queued|loading|finalizing)\b/i
        const failurePattern = /\b(upload failed|failed|error|couldn['’]?t upload|try again|not supported)\b/i
        let input: any = null
        let dispatchAttempted = false

        const getComposerContainer = () => {
          for (const selector of containerSelectors) {
            const el = document.querySelector(selector)
            if (el) return el
          }
          return document.body
        }

        const normalize = (value: any) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
        const markerFor = (element: any) => normalize([
          element?.getAttribute?.('data-testid'),
          element?.getAttribute?.('class'),
          element?.getAttribute?.('role'),
          element?.getAttribute?.('data-filename'),
          element?.getAttribute?.('data-file-name')
        ].filter(Boolean).join(' '))
        const isLabel = (element: any) => /(?:filename|file[-_ ]?name|attachment[-_ ]?name|file[-_ ]?(?:icon|remove|button)|attachment[-_ ]?(?:icon|remove|button))/.test(markerFor(element))
        const isCard = (element: any) => {
          if (!element || isLabel(element)) return false
          return element.getAttribute?.('role') === 'listitem' || /attachment|file|upload/.test(markerFor(element))
        }
        const labelFor = (element: any) => normalize([
          element?.getAttribute?.('data-filename'),
          element?.getAttribute?.('data-file-name'),
          element?.getAttribute?.('aria-label'),
          element?.getAttribute?.('title'),
          element?.getAttribute?.('alt'),
          element?.textContent
        ].filter(Boolean).join(' '))
        const matchesName = (label: string, fileName: string) => {
          const target = normalize(fileName)
          const baseName = target.replace(/\.[^/.]+$/, '')
          return Boolean(target && (label.includes(target) || (baseName.length >= 6 && label.includes(baseName))))
        }
        const getSnapshot = (fileName: string) => {
          const container = getComposerContainer()
          const records: any[] = []
          const seenCards = new Set<any>()
          for (const candidate of container.querySelectorAll(cardSelectors.join(', '))) {
            const testId = candidate.getAttribute?.('data-testid')
            if (testId && knownTestIds.has(testId)) continue
            if (!matchesName(labelFor(candidate), fileName)) continue

            let card = candidate
            if (!isCard(card)) {
              let current = candidate.parentElement
              while (current && current !== container) {
                if (isCard(current)) {
                  card = current
                  break
                }
                current = current.parentElement
              }
            }
            if (!card || seenCards.has(card)) continue
            seenCards.add(card)
            const statusText = normalize([
              labelFor(card),
              card.getAttribute?.('data-status'),
              card.getAttribute?.('aria-busy'),
              card.getAttribute?.('class')
            ].filter(Boolean).join(' '))
            records.push({
              label: labelFor(card) || labelFor(candidate),
              processing: processingPattern.test(statusText),
              error: failurePattern.test(statusText)
            })
          }

          // Claude can render its attachment strip outside the text composer.
          // Only removable thumbnails belong to an editable upload; do not use
          // arbitrary images from conversation history as attachment evidence.
          for (const card of document.querySelectorAll('[data-testid="file-thumbnail"]')) {
            if (seenCards.has(card)) continue
            const target = normalize(fileName)
            const matchingImage = Array.from(card.querySelectorAll('img[alt]')).some(
              (img) => normalize(img.getAttribute('alt')) === target
            )
            const matchingRemove = Array.from(card.querySelectorAll('button[aria-label]')).some(
              (button) => normalize(button.getAttribute('aria-label')) === `remove ${target}`
            )
            if (!matchingImage || !matchingRemove) continue
            seenCards.add(card)
            const status = normalize([
              card.textContent, card.getAttribute('data-status'), card.getAttribute('class')
            ].filter(Boolean).join(' '))
            records.push({
              label: target,
              processing: card.getAttribute('aria-busy') === 'true' ||
                card.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-status="uploading"], [data-status="processing"]').length > 0 ||
                processingPattern.test(status),
              error: failurePattern.test(status)
            })
          }

          const eligibleRecords = records.filter((record) => !record.processing && !record.error)
          return {
            count: records.length,
            eligibleCount: eligibleRecords.length,
            signature: records.map((record) => `${record.label}|${record.processing ? 'processing' : record.error ? 'error' : 'ready'}`).sort().join('||'),
            records
          }
        }
        const findClaudeFileInput = () => {
          for (const selector of fileInputSelectors) {
            const el = document.querySelector(selector)
            if (el && !el.disabled) return el
          }
          return null
        }
        const decodeBase64 = (base64: string) => {
          const byteCharacters = atob(base64)
          const byteNumbers = new Array(byteCharacters.length)
          for (let i = 0; i < byteCharacters.length; i++) byteNumbers[i] = byteCharacters.charCodeAt(i)
          return new Uint8Array(byteNumbers)
        }
        const estimateBytesFromBase64 = (base64: string) => {
          const len = typeof base64 === 'string' ? base64.length : 0
          const padding = base64?.endsWith('==') ? 2 : base64?.endsWith('=') ? 1 : 0
          return Math.max(0, Math.floor((len * 3) / 4) - padding)
        }
        const restoreInput = () => {
          if (!input || !Object.prototype.hasOwnProperty.call(input, 'files')) return
          try {
            delete input.files
          } catch (error) {
            // Best-effort cleanup.
          }
        }

        try {
          if (!pdfArg || typeof pdfArg.name !== 'string' || typeof pdfArg.data !== 'string') {
            return { ok: false, status: 'failed', error: 'Invalid PDF payload for Claude upload' }
          }

          const fileName = pdfArg.name
          const base64Data = pdfArg.data
          input = findClaudeFileInput()
          if (!input) {
            return { ok: false, status: 'failed', error: 'Claude file input not found. Make sure you\'re on an active chat.' }
          }

          restoreInput()
          const previousSnapshot = getSnapshot(fileName)
          const bytes = decodeBase64(base64Data)
          const blob = new Blob([bytes], { type: 'application/pdf' })
          const file = new File([blob], fileName, { type: 'application/pdf' })
          const dt = new DataTransfer()
          dt.items.add(file)
          Object.defineProperty(input, 'files', {
            value: dt.files,
            writable: false,
            configurable: true
          })

          dispatchAttempted = true
          input.dispatchEvent(new Event('change', { bubbles: true }))
          input.dispatchEvent(new Event('input', { bubbles: true }))

          const sizeBytes = estimateBytesFromBase64(base64Data)
          const sizeMb = Math.max(1, Math.ceil(sizeBytes / (1024 * 1024)))
          const timeoutMs = Math.min(120000, Math.max(15000, sizeMb * 12000))
          const start = Date.now()
          let stableSignature: string | null = null

          while (Date.now() - start < timeoutMs) {
            const current = getSnapshot(fileName)
            const hasNewEligibleCard = current.count > previousSnapshot.count && current.eligibleCount > previousSnapshot.eligibleCount
            const hasUnfinishedTarget = current.records.some((record) => record.processing || record.error)
            const signature = `${current.count}:${current.eligibleCount}:${current.signature}`
            if (hasNewEligibleCard && !hasUnfinishedTarget) {
              if (stableSignature === signature) return { ok: true, status: 'attached' }
              stableSignature = signature
              await delay(600)
            } else {
              stableSignature = null
            }
            await delay(250)
          }

          return {
            ok: false,
            status: 'unconfirmed',
            error: `Claude did not show a stable attachment for ${fileName}`,
            attachmentIds: getSnapshot(fileName).records.slice(0, 6).map((record) => record.label)
          }
        } catch (error) {
          return {
            ok: false,
            status: dispatchAttempted ? 'unconfirmed' : 'failed',
            error: (error as any)?.message || String(error)
          }
        } finally {
          restoreInput()
        }
      },
      args: [pdf, CLAUDE_KNOWN_TEST_IDS, CLAUDE_COMPOSER_CONTAINER_SELECTORS, CLAUDE_FILE_INPUT_SELECTORS],
    });
    response = result;
  } catch (error: any) {
    return {
      status: "unconfirmed",
      reason: error?.message || "Claude upload response was unavailable; attachment could not be confirmed.",
    };
  }

  if (response?.ok) return { status: "attached" };
  return {
    status: response?.status === "unconfirmed" ? "unconfirmed" : "failed",
    reason: response?.error || "Claude upload failed.",
  };
}


export async function injectPromptToClaudeMainWorld(tabId: number, promptText: string) {
  // @ts-ignore
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (text: string, knownTestIdList: any, containerSelectorList: any, composerInputSelectorList: any) => {
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      const normalize = (value: any) =>
        String(value || "")
          .replace(/\r/g, "")
          .replace(/\n{2,}/g, "\n")
          .trim()

      // If the user starts editing while we're validating stability, don't fight them by re-inserting.
      let userInteracted = false
      const userEventTypes = ["keydown", "mousedown", "pointerdown", "touchstart", "paste", "cut"]
      const onUserEvent = (event: any) => {
        if (event?.isTrusted) userInteracted = true
      }
      for (const type of userEventTypes) {
        document.addEventListener(type, onUserEvent, true)
      }

      try {
        const isVisible = (el: any) => {
          if (!el || !el.isConnected) return false
          const style = window.getComputedStyle(el)
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
            return false
          }
          const rect = el.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }

        const knownTestIds = new Set(Array.isArray(knownTestIdList) ? knownTestIdList : [])
        const containerSelectors = Array.isArray(containerSelectorList) ? containerSelectorList : []
        const composerInputSelectors = Array.isArray(composerInputSelectorList) ? composerInputSelectorList : []

        const getComposerContainer = () => {
          for (const selector of containerSelectors) {
            const el = document.querySelector(selector)
            if (el) return el
          }
          return document.body
        }

        const hasAttachmentProcessing = () => {
          const container = getComposerContainer()
          if (!container) return false

          if (
            container.querySelector(
              [
                '[role="progressbar"]',
                '[aria-busy="true"]',
                ".animate-spin",
                '[data-state="loading"]',
                '[data-status="uploading"]',
              ].join(","),
            )
          ) {
            return true
          }

          const textContent = (container.textContent || "").toLowerCase()
          return /uploading|processing|finalizing/.test(textContent)
        }

        const isUsableComposerInput = (el: any) => {
          if (!el || !isVisible(el)) return false

          if (el.tagName === "TEXTAREA") {
            return !el.disabled && !el.readOnly
          }

          if (el.isContentEditable) {
            if ((el.getAttribute("contenteditable") || "").toLowerCase() === "false") return false
            if ((el.getAttribute("aria-disabled") || "").toLowerCase() === "true") return false
            return true
          }

          return false
        }

        const getComposerValue = (el: any) => {
          if (!el) return ""
          if (el.tagName === "TEXTAREA") return el.value || ""
          if (el.isContentEditable) return el.innerText || ""
          return el.textContent || ""
        }

        const waitForComposerQuiet = async () => {
          let stableTicks = 0
          for (let i = 0; i < 48; i++) {
            if (userInteracted) return false
            const input = findComposerInput()
            const quiet = !hasAttachmentProcessing()
            const usable = isUsableComposerInput(input)

            if (quiet && usable) {
              stableTicks++
              if (stableTicks >= 5) return true
            } else {
              stableTicks = 0
            }

            await delay(250)
          }
          return false
        }

        const getAttachmentIds = () => {
          const container = getComposerContainer()
          const ids = new Set()
          container.querySelectorAll("[data-testid]").forEach((el: any) => {
            const id = el.getAttribute("data-testid")
            if (!id || knownTestIds.has(id)) return
            ids.add(id)
          })
          return Array.from(ids).sort()
        }

        const waitForComposerStability = async () => {
          // Claude can re-render the composer right after attachment; wait until attachment IDs stop changing.
          let stableTicks = 0
          let previous = JSON.stringify(getAttachmentIds())

          for (let i = 0; i < 24; i++) {
            if (userInteracted) return false
            await delay(250)
            const current = JSON.stringify(getAttachmentIds())
            if (current === previous) {
              stableTicks++
              if (stableTicks >= 4) return
            } else {
              stableTicks = 0
              previous = current
            }
          }
        }

        const findComposerInput = () => {
          const container = getComposerContainer()
          const roots = [container, document].filter(Boolean)

          const candidates: any[] = []
          for (const root of roots) {
            for (const selector of composerInputSelectors) {
              const elements = Array.from(root.querySelectorAll(selector))
              for (const el of elements as any[]) {
                if (!isUsableComposerInput(el)) continue
                const rect = el.getBoundingClientRect()
                const area = rect.width * rect.height
                const priority = el.isContentEditable ? 2 : 1
                candidates.push({ el, area, priority })
              }
            }
          }

          if (candidates.length === 0) return null
          candidates.sort((a, b) => b.priority - a.priority || b.area - a.area)
          return candidates[0].el
        }

        const expected = normalize(text)

        let input = null
        for (let i = 0; i < 80; i++) {
          if (userInteracted) {
            return { ok: true, interrupted: true, reason: "User edited composer before injection" }
          }
          input = findComposerInput()
          if (input) break
          await delay(250)
        }

        if (!input) {
          return { ok: false, error: "Could not find Claude composer input to inject prompt" }
        }

        await waitForComposerStability()
        await waitForComposerQuiet()

        if (userInteracted) {
          return { ok: true, interrupted: true, reason: "User edited composer before injection" }
        }

        const textareaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set
        const applyText = (target: any) => {
          if (!target) return
          target.focus()

          if (target.tagName === "TEXTAREA") {
            if (typeof target.select === "function") {
              target.select()
            }

            if (textareaValueSetter) {
              textareaValueSetter.call(target, text)
            } else {
              target.value = text
            }

            try {
              target.dispatchEvent(
                new InputEvent("beforeinput", {
                  bubbles: true,
                  cancelable: true,
                  inputType: "insertText",
                  data: text,
                }),
              )
            } catch (error) {
              // InputEvent may not be fully supported; ignore and continue.
            }

            try {
              target.dispatchEvent(
                new InputEvent("input", {
                  bubbles: true,
                  inputType: "insertText",
                  data: text,
                }),
              )
            } catch (error) {
              target.dispatchEvent(new Event("input", { bubbles: true }))
            }

            target.dispatchEvent(new Event("change", { bubbles: true }))

            if (typeof target.setSelectionRange === "function") {
              const end = text.length
              target.setSelectionRange(end, end)
            }
            return
          }

          if (target.isContentEditable) {
            // Use execCommand to trigger the same code paths as real typing.
            let applied = false
            try {
              document.execCommand("selectAll")
              applied = document.execCommand("insertText", false, text)
            } catch (error) {
              applied = false
            }

            if (!applied) {
              // Fallback: directly set content and dispatch an input event.
              target.textContent = text
              target.dispatchEvent(new Event("input", { bubbles: true }))
            }
            return
          }
        }

        const waitForPersistence = async () => {
          const observed = []
          for (let i = 0; i < 16; i++) {
            if (userInteracted) {
              return { ok: true, interrupted: true, observed: observed.slice(0, 8) }
            }
            const current = findComposerInput()
            const value = normalize(getComposerValue(current))
            observed.push(value.length)

            if (!current || value !== expected) {
              return {
                ok: false,
                reason: `changed at check ${i + 1} (${value.length}/${expected.length})`,
                observed: observed.slice(0, 8),
              }
            }
            await delay(250)
          }
          return { ok: true, observed: observed.slice(0, 8) }
        }

        // Retry to survive late Claude re-renders that clear the composer value.
        let lastReason = "unknown"
        for (let attempt = 0; attempt < 5; attempt++) {
          input = findComposerInput()
          if (!input) {
            return { ok: false, error: "Claude composer re-rendered and input was lost" }
          }

          applyText(input)
          await delay(220)
          const persistence = await waitForPersistence()
          if (persistence.ok) {
            return {
              ok: true,
              length: expected.length,
              attempts: attempt + 1,
              observed: persistence.observed,
              kind: (input as any).isContentEditable ? "contenteditable" : (input as any).tagName === "TEXTAREA" ? "textarea" : "unknown",
              interrupted: !!persistence.interrupted,
            }
          }
          lastReason = persistence.reason || "value changed"

          await waitForComposerQuiet()
        }

        input = findComposerInput()
        const finalLen = normalize(getComposerValue(input)).length
        return {
          ok: false,
          error: `Claude prompt did not stick (${finalLen}/${expected.length} chars, ${lastReason})`,
        }
      } finally {
        for (const type of userEventTypes) {
          document.removeEventListener(type, onUserEvent, true)
        }
      }
    },
    args: [promptText, CLAUDE_KNOWN_TEST_IDS, CLAUDE_COMPOSER_CONTAINER_SELECTORS, CLAUDE_COMPOSER_INPUT_SELECTORS],
  });

  if (!result?.ok) {
    throw new Error((result as any)?.error || "Failed to inject prompt into Claude");
  }
  return result;
}

export async function processUpload(
  selectedPapers: Paper[],
  selectedCourses: Course[],
  studyIntent: string,
  updateProgress: (msg: string) => void,
): Promise<UploadResult> {
  updateProgress("Initializing...");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) throw new Error("Could not access current tab.");

  if (!tab.url.includes("chatgpt.com") && !tab.url.includes("chat.openai.com") && !tab.url.includes("claude.ai")) {
    throw new Error("Please open ChatGPT or Claude first");
  }

  try {
    await chrome.runtime.sendMessage({ action: "healthCheck" });
  } catch (error) {
    // The service worker may wake between calls; the actual download reports its own errors.
  }

  const outcomesByPaperKey = new Map<string, UploadPaperOutcome>();
  const downloadedPapers: DownloadedPdf[] = [];

  for (let i = 0; i < selectedPapers.length; i++) {
    const paper = selectedPapers[i];
    const key = getPaperKey(paper, i);
    updateProgress(`Downloading (${i + 1}/${selectedPapers.length}): ${paper.course_name}`);
    const targetFilename = `${paper.course_name}_${paper.exam_type}_${paper.exam_month}_${paper.exam_year}.pdf`;

    try {
      const response = await chrome.runtime.sendMessage({
        action: "downloadPDF",
        url: (paper as any).download_url,
        mode: "buffer",
        filename: targetFilename,
      }) as DownloadPdfResponse;

      if (response?.success && typeof response.base64Data === "string" && response.base64Data.length > 0) {
        downloadedPapers.push({ key, paper, name: targetFilename, base64Data: response.base64Data });
      } else {
        outcomesByPaperKey.set(
          key,
          createPaperOutcome(paper, targetFilename, "failed", "download", formatDownloadFailureReason(targetFilename, response)),
        );
      }
    } catch (error: any) {
      outcomesByPaperKey.set(
        key,
        createPaperOutcome(
          paper,
          targetFilename,
          "failed",
          "download",
          `${targetFilename}: ${error?.message || "Unexpected download error."}`,
        ),
      );
    }
  }

  if (downloadedPapers.length > 0) {
    updateProgress("Injecting into LLM...");

    if (!tab.id) {
      for (const downloaded of downloadedPapers) {
        outcomesByPaperKey.set(
          downloaded.key,
          createPaperOutcome(downloaded.paper, downloaded.name, "failed", "attachment", "The active tab has no usable id."),
        );
      }
    } else if (tab.url.includes("claude.ai")) {
      updateProgress("Uploading to Claude...");
      for (const downloaded of downloadedPapers) {
        try {
          const response = await uploadPdfToClaudeMainWorld(tab.id, {
            id: downloaded.paper.id,
            name: downloaded.name,
            info: downloaded.paper,
            data: downloaded.base64Data,
          });
          const status = normalizeAdapterStatus(response?.status) || "unconfirmed";
          outcomesByPaperKey.set(
            downloaded.key,
            createPaperOutcome(downloaded.paper, downloaded.name, status, "attachment", response?.reason),
          );
        } catch (error: any) {
          outcomesByPaperKey.set(
            downloaded.key,
            createPaperOutcome(
              downloaded.paper,
              downloaded.name,
              "unconfirmed",
              "attachment",
              error?.message || "Claude upload response was unavailable; attachment could not be confirmed.",
            ),
          );
        }
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      let response: UploadAdapterResponse | null = null;

      try {
        const rawResponse = await chrome.tabs.sendMessage(tab.id, {
          action: "uploadPDFs",
          pdfs: downloadedPapers.map((downloaded) => ({
            id: downloaded.paper.id,
            name: downloaded.name,
            info: downloaded.paper,
            data: downloaded.base64Data,
          })),
        });
        response = rawResponse && typeof rawResponse === "object" ? rawResponse as UploadAdapterResponse : null;
      } catch (error: any) {
        if (error?.message?.includes("Receiving end does not exist")) {
          response = { success: false, error: "Could not connect. Please refresh the ChatGPT page to load the extension." };
        } else {
          console.error("ChatGPT upload response was unavailable:", error);
        }
      }

      const attachmentOutcomes = normalizeAttachmentOutcomes(downloadedPapers, response);
      for (let i = 0; i < downloadedPapers.length; i++) {
        outcomesByPaperKey.set(downloadedPapers[i].key, attachmentOutcomes[i]);
      }
    }
  }

  const outcomes = selectedPapers.map((paper, index) => {
    const existing = outcomesByPaperKey.get(getPaperKey(paper, index));
    if (existing) return existing;
    const filename = `${paper.course_name}_${paper.exam_type}_${paper.exam_month}_${paper.exam_year}.pdf`;
    return createPaperOutcome(paper, filename, "failed", "download", "The paper was not downloaded.");
  });

  const attachedPapers = outcomes.filter((outcome) => outcome.status === "attached").map((outcome) => outcome.paper);
  const attachedCourses = getCoursesForPapers(selectedCourses, attachedPapers);
  const customPrompt = generateCustomPrompt(studyIntent, attachedCourses, attachedPapers);
  let prompt: UploadPromptOutcome;

  if (attachedPapers.length === 0) {
    prompt = { status: "skipped", reason: "No attachments were confirmed." };
  } else if (!customPrompt) {
    prompt = { status: "skipped", reason: "No study prompt was requested." };
  } else if (!tab.id) {
    prompt = { status: "failed", reason: "The active tab has no usable id." };
  } else {
    updateProgress("Injecting study prompt...");
    try {
      if (tab.url.includes("claude.ai")) {
        const response = await injectPromptToClaudeMainWorld(tab.id, customPrompt);
        if (response?.interrupted) {
          prompt = { status: "skipped", reason: "Prompt injection stopped because the composer was edited." };
        } else {
          prompt = { status: "inserted" };
        }
      } else {
        const response = await chrome.tabs.sendMessage(tab.id, {
          action: "injectPrompt",
          prompt: customPrompt,
        }) as UploadAdapterResponse | null;
        if (!response?.success) {
          throw new Error(response?.error || "ChatGPT did not confirm prompt insertion.");
        }
        prompt = { status: "inserted" };
      }
    } catch (error: any) {
      prompt = { status: "failed", reason: error?.message || "Prompt insertion failed." };
    }
  }

  return {
    attemptedCount: selectedPapers.length,
    attachedCount: attachedPapers.length,
    outcomes,
    prompt,
  };
}

export async function processDirectDownload(selectedPapers: Paper[], updateProgress: (msg: string) => void) {
  let successfulDownloads = 0;
  const downloadFailures: string[] = [];

  for (let i = 0; i < selectedPapers.length; i++) {
    const paper = selectedPapers[i];
    updateProgress(`Downloading to PC (${i + 1}/${selectedPapers.length}): ${paper.course_name}`);

    const targetFilename = `${paper.course_name}_${paper.exam_type}_${paper.exam_month}_${paper.exam_year}.pdf`;

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'downloadPDF',
        url: (paper as any).download_url,
        mode: 'save',
        filename: targetFilename
      }) as DownloadPdfResponse;

      if (response?.success) {
        successfulDownloads++;
      } else {
        downloadFailures.push(formatDownloadFailureMessage(targetFilename, response));
      }
    } catch (error: any) {
      console.error(error);
      downloadFailures.push(`${targetFilename}: ${error?.message || "Unexpected download error."}`);
    }
  }

  if (successfulDownloads === 0 && downloadFailures.length > 0) {
    throw new Error(downloadFailures[0]);
  }

  return successfulDownloads;
}
