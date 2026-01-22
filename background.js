// Background script for Chrome extension
console.log('🚀 Background script loaded at:', new Date().toISOString());

// Add service worker startup listener
chrome.runtime.onStartup.addListener(() => {
    console.log('🔄 Background service worker started');
});

// Add suspend listener to debug service worker termination
chrome.runtime.onSuspend.addListener(() => {
    console.log('💤 Background service worker suspending');
});

chrome.runtime.onInstalled.addListener((details) => {
    console.log('Question Paper Helper extension installed');
    
    if (details.reason === 'install') {
        // Show welcome message or open options page
        console.log('Extension installed for the first time');
    }
    
    // Create context menu item only on install/enable
    chrome.contextMenus.create({
        id: "upload-papers",
        title: "Upload Question Papers",
        contexts: ["page"],
        documentUrlPatterns: ["*://chatgpt.com/*", "*://chat.openai.com/*", "*://gemini.google.com/*"]
    });
});

// Listen for tab updates to check if user navigates to supported LLM platforms
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        const isSupportedPlatform = tab.url.includes('chatgpt.com') || 
                                    tab.url.includes('chat.openai.com') ||
                                    tab.url.includes('gemini.google.com');
        
        if (isSupportedPlatform) {
            // Inject content script if not already injected
            chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js']
            }).catch((error) => {
                // Script might already be injected, ignore error
                console.log('Content script injection skipped:', error.message);
            });
        }
    }
});

// Handle messages from content scripts or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Background received message:', message);
    
    if (message.action === 'healthCheck') {
        // Respond to health check from popup
        console.log('Background script health check - responding OK');
        sendResponse({ success: true, status: 'healthy', timestamp: Date.now() });
        return true;
    }
    
    if (message.action === 'downloadPDF') {
        // Handle PDF download
        downloadPDF(message.url)
            .then(async blob => {
                // Convert blob to base64 for message passing
                const reader = new FileReader();
                reader.onloadend = () => {
                    const base64Data = reader.result.split(',')[1];
                    sendResponse({ success: true, base64Data });
                };
                reader.readAsDataURL(blob);
            })
            .catch(error => {
                console.error('Background PDF download error:', error);
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }
    
    if (message.action === 'injectContentScript') {
        // Handle content script injection from background
        console.log('Background injecting content script for tab:', message.tabId);
        chrome.scripting.executeScript({
            target: { tabId: message.tabId },
            files: ['content.js']
        })
        .then(() => {
            console.log('Background injection successful');
            sendResponse({ success: true });
        })
        .catch(error => {
            console.error('Background injection failed:', error);
            sendResponse({ success: false, error: error.message });
        });
        return true;
    }

    if (message.action === 'geminiAttachFiles') {
        geminiAttachFiles(message.tabId, message.filePaths)
            .then(() => sendResponse({ success: true }))
            .catch(error => {
                console.error('Gemini attach files error:', error)
                sendResponse({
                    success: false,
                    error: error?.message || String(error),
                    stack: error?.stack || null
                })
            })
        return true
    }

    if (message.action === 'saveGeminiPdf') {
        saveGeminiPdfToDisk(message.base64Data, message.filename)
            .then((downloadId) => sendResponse({ success: true, downloadId }))
            .catch(error => {
                console.error('Gemini save PDF error:', error)
                sendResponse({
                    success: false,
                    error: error?.message || String(error),
                    stack: error?.stack || null
                })
            })
        return true
    }
    
    // Handle active tab requests
    if (message.action === 'getActiveTab') {
        chrome.tabs.query({active: true, currentWindow: true})
            .then(tabs => sendResponse(tabs[0]))
            .catch(error => sendResponse({error: error.message}));
        return true; // keep channel open
    }
    
    
});

async function geminiAttachFiles(tabId, filePaths) {
  if (!tabId) throw new Error('Missing tabId for Gemini attach')
  if (!Array.isArray(filePaths) || filePaths.length === 0) throw new Error('No files to attach to Gemini')

  const debuggee = { tabId }
  const send = (method, params = {}) => chrome.debugger.sendCommand(debuggee, method, params)
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const evaluate = async (expression, { awaitPromise = true } = {}) => {
    const result = await send('Runtime.evaluate', {
      awaitPromise,
      returnByValue: true,
      expression,
    })

    if (result?.exceptionDetails) {
      const message = result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'Runtime.evaluate exception'
      throw new Error(message)
    }

    return result?.result?.value
  }

  const getFrameIds = async () => {
    const frames = []
    const tree = await send('Page.getFrameTree')
    const walk = (node) => {
      if (!node) return
      if (node.frame?.id) frames.push(node.frame.id)
      if (node.childFrames?.length) node.childFrames.forEach(walk)
    }
    walk(tree?.frameTree)
    return frames
  }

  const getRootNodeId = async (frameId) => {
    const doc = await send('DOM.getDocument', frameId ? { depth: 2, frameId } : { depth: 2 })
    const rootNodeId = doc?.root?.nodeId
    if (!rootNodeId) throw new Error('Could not resolve Gemini document root')
    return rootNodeId
  }

  const queryNodeId = async (rootNodeId, selector) => {
    const query = await send('DOM.querySelector', { nodeId: rootNodeId, selector })
    return query?.nodeId || null
  }

  const queryNodeIdInFrames = async (selector) => {
    const frameIds = await getFrameIds()
    for (const frameId of frameIds) {
      const rootNodeId = await getRootNodeId(frameId)
      const nodeId = await queryNodeId(rootNodeId, selector)
      if (nodeId) return { nodeId, frameId }
    }
    return null
  }

  const waitForNodeInFrames = async (selector, { timeoutMs = 2000, intervalMs = 200 } = {}) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const match = await queryNodeIdInFrames(selector)
      if (match?.nodeId) return match
      await delay(intervalMs)
    }
    return null
  }

  const getNodeAttribute = async (nodeId, attrName) => {
    const attrs = await send('DOM.getAttributes', { nodeId })
    const list = attrs?.attributes || []
    for (let i = 0; i < list.length; i += 2) {
      if (list[i] === attrName) return list[i + 1]
    }
    return null
  }

  const clickNode = async (nodeId) => {
    const box = await send('DOM.getBoxModel', { nodeId })
    const quad = box?.model?.border || box?.model?.content
    if (!quad || quad.length < 8) throw new Error('Could not resolve node box for click')

    const xs = [quad[0], quad[2], quad[4], quad[6]]
    const ys = [quad[1], quad[3], quad[5], quad[7]]
    const x = xs.reduce((a, b) => a + b, 0) / xs.length
    const y = ys.reduce((a, b) => a + b, 0) / ys.length

    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  }

  try {
    await chrome.debugger.attach(debuggee, '1.3')
    await send('DOM.enable')
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Page.bringToFront')

    const fileInputSelector = 'input[type="file"][name="Filedata"]'
    const menuButtonSelector = 'button[aria-label="Open upload file menu"],button[aria-label="Close upload file menu"]'
    const uploadItemSelector = 'button[aria-label^="Upload files"],button[aria-label^="Upload file"]'

    // Best case: file input already exists
    let nodeIdMatch = await queryNodeIdInFrames(fileInputSelector)

    if (!nodeIdMatch?.nodeId) {
      // Ensure menu opens with a trusted click (CDP Input), then create the hidden file input
      const menuBtnMatch = await waitForNodeInFrames(menuButtonSelector, { timeoutMs: 4000 })
      if (!menuBtnMatch?.nodeId) throw new Error('Could not prepare Gemini file input: missing upload menu button')

      // If menu is closed, open it (Gemini can ignore non-trusted JS clicks)
      const menuLabel = await getNodeAttribute(menuBtnMatch.nodeId, 'aria-label')
      if (typeof menuLabel === 'string' && menuLabel.includes('Open')) {
        await clickNode(menuBtnMatch.nodeId)
        await delay(200)
      }

      // Block any programmatic file picker opening while we click the upload item
      await evaluate(`(() => {
        if (window.__skiprexaFilePickerBlocked) return true
        window.__skiprexaFilePickerBlocked = true
        const orig = HTMLInputElement.prototype.click
        const origShowPicker = HTMLInputElement.prototype.showPicker
        Object.defineProperty(window, '__skiprexaOrigInputClick', { value: orig, configurable: true })
        Object.defineProperty(window, '__skiprexaOrigShowPicker', { value: origShowPicker, configurable: true })
        HTMLInputElement.prototype.click = function () {}
        if (origShowPicker) HTMLInputElement.prototype.showPicker = function () {}
        return true
      })()`, { awaitPromise: false })

      const uploadItemMatch = await waitForNodeInFrames(uploadItemSelector, { timeoutMs: 4000 })
      if (!uploadItemMatch?.nodeId) throw new Error('Could not prepare Gemini file input: missing Upload files menu item')

      await clickNode(uploadItemMatch.nodeId)
      await delay(300)

      nodeIdMatch = await waitForNodeInFrames(fileInputSelector, { timeoutMs: 4000, intervalMs: 250 })
      if (!nodeIdMatch?.nodeId) throw new Error('Could not prepare Gemini file input: file input not found after opening menu')
    }

    await send('DOM.setFileInputFiles', { nodeId: nodeIdMatch.nodeId, files: filePaths })

    // Trigger change/input so the app actually reads the files
    const resolved = await send('DOM.resolveNode', { nodeId: nodeIdMatch.nodeId })
    const objectId = resolved?.object?.objectId
    if (objectId) {
      await send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          this.dispatchEvent(new Event('input', { bubbles: true }))
          this.dispatchEvent(new Event('change', { bubbles: true }))
        }`,
      })
    }
  } finally {
    try {
      await evaluate(`(() => {
        if (!window.__skiprexaFilePickerBlocked) return false
        const orig = window.__skiprexaOrigInputClick
        const origShowPicker = window.__skiprexaOrigShowPicker
        if (orig) HTMLInputElement.prototype.click = orig
        if (origShowPicker) HTMLInputElement.prototype.showPicker = origShowPicker
        delete window.__skiprexaOrigInputClick
        delete window.__skiprexaOrigShowPicker
        delete window.__skiprexaFilePickerBlocked
        return true
      })()`, { awaitPromise: false })
    } catch (e) {
      // ignore restore errors
    }
    try {
      await chrome.debugger.detach(debuggee)
    } catch (e) {
      // Ignore detach errors
    }
  }
}

function waitForDownloadComplete(downloadId, { timeoutMs = 90000, stallMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let finished = false
    let pollInterval = null
    let lastBytesReceived = 0
    let lastProgressAt = Date.now()

    const onChanged = (delta) => {
      if (delta.id !== downloadId) return

      if (delta.error?.current) {
        cleanup(new Error(delta.error.current))
        return
      }

      if (delta.state?.current === "interrupted") {
        cleanup(new Error("Download interrupted"))
        return
      }

      if (delta.state?.current === "complete") {
        cleanup(null)
        return
      }

      if (typeof delta.bytesReceived?.current === "number") {
        if (delta.bytesReceived.current > lastBytesReceived) {
          lastBytesReceived = delta.bytesReceived.current
          lastProgressAt = Date.now()
        }
      }
    }

    const cleanup = (error) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (pollInterval) clearInterval(pollInterval)
      chrome.downloads.onChanged.removeListener(onChanged)
      if (error) reject(error)
      else resolve(true)
    }

    const timeout = setTimeout(() => {
      cleanup(new Error("Download timeout"))
    }, timeoutMs)

    chrome.downloads.onChanged.addListener(onChanged)

    pollInterval = setInterval(async () => {
      try {
        const [item] = await chrome.downloads.search({ id: downloadId })
        if (!item) return
        if (item.error) cleanup(new Error(item.error))
        else if (item.state === "interrupted") cleanup(new Error("Download interrupted"))
        else if (item.state === "complete") cleanup(null)
        else if (item.state === "in_progress") {
          if (typeof item.bytesReceived === "number" && item.bytesReceived > lastBytesReceived) {
            lastBytesReceived = item.bytesReceived
            lastProgressAt = Date.now()
          } else if (stallMs && Date.now() - lastProgressAt > stallMs) {
            cleanup(new Error("Download stalled"))
          }
        }
      } catch (e) {
        // Ignore polling errors
      }
    }, 500)
  })
}

async function saveGeminiPdfToDisk(base64Data, filename) {
  if (!base64Data) throw new Error('Missing base64 data for Gemini save')
  if (!filename) throw new Error('Missing filename for Gemini save')

  const downloadFromUrl = async (url, { saveAs, timeoutMs = 15000 } = {}) => {
    const downloadPromise = new Promise((resolve, reject) => {
      chrome.downloads.download({
        url,
        filename,
        saveAs,
        conflictAction: "overwrite",
      }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
        } else if (!id) {
          reject(new Error("Download did not start"))
        } else {
          resolve(id)
        }
      })
    })

    return await Promise.race([
      downloadPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Download start timeout")), timeoutMs)),
    ])
  }

  try {
    const dataUrl = `data:application/pdf;base64,${base64Data}`
    try {
      return await downloadFromUrl(dataUrl, { saveAs: false, timeoutMs: 20000 })
    } catch (dataError) {
      console.warn('⚠️ Gemini auto-save stalled, prompting for save location...')
      return await downloadFromUrl(dataUrl, { saveAs: true, timeoutMs: 60000 })
    }
  } catch (error) {
    throw error
  }
}

// Function to download PDF (if needed by other parts of extension)
async function downloadPDF(url) {
    try {
        console.log('Background script attempting to download:', url);
        
        // Check if URL is valid first
        if (!url || !url.startsWith('http')) {
            throw new Error(`Invalid URL: ${url}`);
        }
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/pdf,*/*',
                'Referer': 'https://student.rajagiritech.ac.in/'
            }
        });
        
        console.log('Response status:', response.status);
        console.log('Response URL:', response.url);
        
        if (!response.ok) {
            console.error(`HTTP ${response.status} for URL: ${url}`);
            
            if (response.status === 404) {
                throw new Error(`PDF file not found at URL: ${url}. The file may have been moved or deleted.`);
            } else if (response.status === 403) {
                throw new Error(`Access denied to PDF: ${url}. Authentication may be required.`);
            } else {
                throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
            }
        }
        
        const blob = await response.blob();
        
        // Verify it's actually a PDF
        if (blob.type && !blob.type.includes('pdf')) {
            console.warn(`Downloaded file is not a PDF, got: ${blob.type}`);
        }
        
        if (blob.size === 0) {
            throw new Error(`Downloaded PDF is empty (0 bytes) from: ${url}`);
        }
        
        console.log('Downloaded blob size:', blob.size, 'bytes, type:', blob.type);
        return blob;
        
    } catch (error) {
        console.error('Error downloading PDF:', error);
        console.error('Failed URL:', url);
        
        throw error;
    }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "upload-papers") {
        // Open extension popup or trigger upload
        chrome.action.openPopup();
    }
});
