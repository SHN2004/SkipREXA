import { Paper } from "./usePapers";
import { Course } from "./useCourses";

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
  // @ts-ignore
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (pdfArg: any, knownTestIdList: any, containerSelectorList: any, fileInputSelectorList: any) => {
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

      const knownTestIds = new Set(Array.isArray(knownTestIdList) ? knownTestIdList : [])
      const containerSelectors = Array.isArray(containerSelectorList) ? containerSelectorList : []
      const fileInputSelectors = Array.isArray(fileInputSelectorList) ? fileInputSelectorList : []

      const getComposerContainer = () => {
        for (const selector of containerSelectors) {
          const el = document.querySelector(selector)
          if (el) return el
        }
        return document.body
      }

      const getAttachmentTestIds = () => {
        const container = getComposerContainer()
        const ids = new Set()
        const elements = container.querySelectorAll("[data-testid]")
        for (const el of elements) {
          const id = el.getAttribute("data-testid")
          if (!id) continue
          if (knownTestIds.has(id)) continue
          ids.add(id)
        }
        return Array.from(ids)
      }

      const isFileVisibleInUI = (fileName: string) => {
        const container = getComposerContainer()

        const ids = getAttachmentTestIds()
        if (ids.includes(fileName)) return true

        const baseName = fileName.replace(/\.[^/.]+$/, "")
        if (baseName && ids.includes(baseName)) return true

        const images = container.querySelectorAll("img[alt]")
        for (const img of images) {
          if ((img.getAttribute("alt") || "") === fileName) return true
        }

        return false
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
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i)
        }
        return new Uint8Array(byteNumbers)
      }

      const estimateBytesFromBase64 = (base64: string) => {
        const len = typeof base64 === "string" ? base64.length : 0
        const padding = base64?.endsWith("==") ? 2 : base64?.endsWith("=") ? 1 : 0
        return Math.max(0, Math.floor((len * 3) / 4) - padding)
      }

      try {
        if (!pdfArg || typeof pdfArg.name !== "string" || typeof pdfArg.data !== "string") {
          return { ok: false, error: "Invalid PDF payload for Claude upload" }
        }

        const fileName = pdfArg.name
        const base64Data = pdfArg.data

        const input = findClaudeFileInput()
        if (!input) {
          return { ok: false, error: "Claude file input not found. Make sure you're on an active chat." }
        }

        // Restore native property before we override it in the MAIN world.
        if (Object.prototype.hasOwnProperty.call(input, "files")) {
          try {
            delete input.files
          } catch (error) {
            // best-effort
          }
        }

        const previousIds = new Set(getAttachmentTestIds())

        const bytes = decodeBase64(base64Data)
        const blob = new Blob([bytes], { type: "application/pdf" })
        const file = new File([blob], fileName, { type: "application/pdf" })

        const dt = new DataTransfer()
        dt.items.add(file)

        Object.defineProperty(input, "files", {
          value: dt.files,
          writable: false,
          configurable: true,
        })

        input.dispatchEvent(new Event("change", { bubbles: true }))
        input.dispatchEvent(new Event("input", { bubbles: true }))

        const sizeBytes = estimateBytesFromBase64(base64Data)
        const sizeMb = Math.max(1, Math.ceil(sizeBytes / (1024 * 1024)))
        const timeoutMs = Math.min(120000, Math.max(15000, sizeMb * 12000))

        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
          if (isFileVisibleInUI(fileName)) {
            // Cleanup the override to avoid breaking future uploads.
            if (Object.prototype.hasOwnProperty.call(input, "files")) {
              try {
                delete input.files
              } catch (error) {
                // best-effort
              }
            }
            return { ok: true }
          }

          const currentIds = getAttachmentTestIds()
          const newIds = currentIds.filter((id) => !previousIds.has(id))
          if (newIds.length > 0) {
            // If Claude sanitized the name, treat a stable new attachment as success.
            await delay(600)
            const stableIds = getAttachmentTestIds().filter((id) => !previousIds.has(id))
            if (stableIds.length > 0) {
              if (Object.prototype.hasOwnProperty.call(input, "files")) {
                try {
                  delete input.files
                } catch (error) {
                  // best-effort
                }
              }
              return { ok: true, attachedAs: stableIds[0] }
            }
          }

          await delay(250)
        }

        const attachmentIds = getAttachmentTestIds()
        return {
          ok: false,
          error: `Claude did not show an attachment chip for ${fileName}`,
          attachmentIds: attachmentIds.slice(0, 6),
        }
      } catch (error) {
        return { ok: false, error: (error as any)?.message || String(error) }
      }
    },
    args: [pdf, CLAUDE_KNOWN_TEST_IDS, CLAUDE_COMPOSER_CONTAINER_SELECTORS, CLAUDE_FILE_INPUT_SELECTORS],
  });

  if (!result?.ok) {
    throw new Error((result as any)?.error || "Claude upload failed");
  }
  return result;
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

export async function processUpload(selectedPapers: Paper[], selectedCourses: Course[], studyIntent: string, updateProgress: (msg: string) => void) {
  updateProgress("Initializing...");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) throw new Error("Could not access current tab.");

  if (!tab.url.includes("chatgpt.com") && !tab.url.includes("chat.openai.com") && !tab.url.includes("claude.ai")) {
    throw new Error("Please open ChatGPT or Claude first");
  }

  // Wake up background script
  try {
    await chrome.runtime.sendMessage({ action: 'healthCheck' });
  } catch (e) {
    // Ignore timeout error
  }

  const pdfData = [];

  for (let i = 0; i < selectedPapers.length; i++) {
    const paper = selectedPapers[i];
    updateProgress(`Downloading (${i + 1}/${selectedPapers.length}): ${paper.course_name}`);
    const targetFilename = `${paper.course_name}_${paper.exam_type}_${paper.exam_month}_${paper.exam_year}.pdf`;

    // Use background script to download PDF bytes for upload
    const response = await chrome.runtime.sendMessage({
      action: 'downloadPDF',
      url: (paper as any).download_url,
      mode: 'buffer',
      filename: targetFilename
    });

    if (response?.success && response.base64Data) {
      pdfData.push({
        name: targetFilename,
        base64Data: response.base64Data,
        info: paper,
      });
    }
  }

  if (pdfData.length === 0) {
    throw new Error("No papers were downloaded successfully.");
  }

  updateProgress("Injecting into LLM...");

  const pdfsToSend = pdfData.map((pdf) => ({
    name: pdf.name,
    info: pdf.info,
    data: pdf.base64Data,
  }));

  if (tab.url.includes("claude.ai") && tab.id) {
    updateProgress("Uploading to Claude...");
    for (const pdf of pdfsToSend) {
      try {
        await uploadPdfToClaudeMainWorld(tab.id, pdf);
      } catch (e) {
        console.error("Claude upload failed for", pdf.name, e);
      }
    }
  } else if (tab.id) {
    // ChatGPT flow
    await new Promise(r => setTimeout(r, 1000));

    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: "uploadPDFs",
        pdfs: pdfsToSend,
      });
    } catch (e: any) {
      if (e.message && e.message.includes("Receiving end does not exist")) {
        throw new Error("Could not connect. Please refresh the ChatGPT page to load the extension.");
      }
      throw e;
    }
  }

  const customPrompt = generateCustomPrompt(studyIntent, selectedCourses, selectedPapers);
  if (customPrompt && tab.id) {
    updateProgress("Injecting study prompt...");
    if (tab.url.includes("claude.ai")) {
      await injectPromptToClaudeMainWorld(tab.id, customPrompt).catch(e => console.log("Claude Prompt inject error.", e));
    } else {
      await chrome.tabs.sendMessage(tab.id, {
        action: "injectPrompt",
        prompt: customPrompt,
      }).catch(e => console.log("Prompt inject error. Assuming success.", e));
    }
  }

  return pdfData.length;
}

export async function processDirectDownload(selectedPapers: Paper[], updateProgress: (msg: string) => void) {
  let successfulDownloads = 0;

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
      });

      if (response?.success) {
        successfulDownloads++;
      }
    } catch (error) {
      console.error(error);
    }
  }

  return successfulDownloads;
}
