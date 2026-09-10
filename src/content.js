// Content script for ChatGPT/Claude file upload
console.log('Question Paper Helper content script loaded');


// Prevent multiple script injections and event listener registration
if (window.questionPaperHelperLoaded) {
    console.log('Content script already loaded, skipping initialization...');
} else {
    window.questionPaperHelperLoaded = true;
    console.log('Content script initialized for the first time');
    
    // Set up message listener only once
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log('Content script received message:', message.action);
        
        if (message.action === 'ping') {
            // Ping test to verify content script is working
            console.log('Content script responding to ping');
            sendResponse({ success: true, message: 'Content script is ready' });
            return true;
        }
        
        if (message.action === 'uploadPDFs') {
            console.log(`Content script received upload request for ${message.pdfs.length} PDFs`);
            
            uploadPDFsToActiveLLM(message.pdfs)
                .then((result) => {
                    const uploadedCount = Number(result?.uploadedCount || 0);
                    console.log(`Upload completed: ${uploadedCount}/${message.pdfs.length} confirmed`);
                    sendResponse({ success: uploadedCount > 0, ...(result || {}) });
                })
                .catch(error => {
                    console.error('Upload error:', error);
                    sendResponse({ success: false, error: error.message });
                });
            return true; // Keep message channel open for async response
        }
        
        if (message.action === 'injectPrompt') {
            console.log('Content script received prompt injection request');
            
            injectPromptToActiveLLM(message.prompt)
                .then(() => {
                    console.log('Prompt injection completed successfully');
                    sendResponse({ success: true });
                })
                .catch(error => {
                    console.error('Prompt injection error:', error);
                    sendResponse({ success: false, error: error.message });
                });
            return true; // Keep message channel open for async response
        }
        
        return false; // Don't keep channel open for unknown actions
    });
    
    console.log('✅ Message listener set up successfully');
}

function getActiveLLMPlatform() {
    const hostname = window.location.hostname || '';
    if (hostname === 'claude.ai') return 'claude';
    if (hostname === 'chatgpt.com' || hostname === 'chat.openai.com') return 'chatgpt';
    return 'unknown';
}

async function uploadPDFsToActiveLLM(pdfs) {
    const platform = getActiveLLMPlatform();
    console.log(`📤 Upload target platform: ${platform}`);

    if (platform === 'claude') {
        return uploadPDFsToClaude(pdfs);
    }

    if (platform === 'chatgpt') {
        return uploadPDFsToChatGPT(pdfs);
    }

    throw new Error(`Unsupported platform: ${window.location.hostname}`);
}

async function injectPromptToActiveLLM(promptText) {
    const platform = getActiveLLMPlatform();
    console.log(`📝 Prompt target platform: ${platform}`);

    if (platform === 'claude') {
        return injectPromptToClaude(promptText);
    }

    if (platform === 'chatgpt') {
        return injectPromptToChatGPT(promptText);
    }

    throw new Error(`Unsupported platform: ${window.location.hostname}`);
}

const ATTACHMENT_CARD_SELECTORS = [
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
];

const ATTACHMENT_PROCESSING_PATTERN = /\b(uploading|processing|queued|loading|finalizing)\b/i;
const ATTACHMENT_FAILURE_PATTERN = /\b(upload failed|failed|error|couldn['’]?t upload|try again|not supported)\b/i;

function getChatGPTComposerContainer() {
    const chatInput = document.querySelector('[data-testid="chat-input"]');
    if (chatInput) {
        return chatInput.closest?.('form') || chatInput.parentElement || chatInput;
    }

    const promptTextarea = document.querySelector('[data-testid="prompt-textarea"]');
    if (promptTextarea) {
        return promptTextarea.closest?.('form') || promptTextarea.parentElement || promptTextarea;
    }

    return (
        document.querySelector('.composer-container') ||
        document.querySelector('main') ||
        document.body
    );
}

function normalizeAttachmentText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getAttachmentMarker(element) {
    return normalizeAttachmentText([
        element.getAttribute?.('data-testid'),
        element.getAttribute?.('class'),
        element.getAttribute?.('role'),
        element.getAttribute?.('data-filename'),
        element.getAttribute?.('data-file-name')
    ].filter(Boolean).join(' '));
}

function isAttachmentLabel(element) {
    const marker = getAttachmentMarker(element);
    return /(?:filename|file[-_ ]?name|attachment[-_ ]?name|file[-_ ]?(?:icon|remove|button)|attachment[-_ ]?(?:icon|remove|button))/.test(marker);
}

function isAttachmentCard(element) {
    if (!element || isAttachmentLabel(element)) return false;
    const marker = getAttachmentMarker(element);
    return element.getAttribute?.('role') === 'listitem' || /attachment|file|upload/.test(marker);
}

function getAttachmentLabel(element) {
    return normalizeAttachmentText([
        element.getAttribute?.('data-filename'),
        element.getAttribute?.('data-file-name'),
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
        element.getAttribute?.('alt'),
        element.textContent
    ].filter(Boolean).join(' '));
}

function findAttachmentCard(element, container) {
    if (isAttachmentCard(element)) return element;

    let current = element.parentElement;
    while (current && current !== container) {
        if (isAttachmentCard(current)) return current;
        current = current.parentElement;
    }

    return element;
}

function attachmentLabelMatches(label, fileName) {
    const target = normalizeAttachmentText(fileName);
    const baseName = target.replace(/\.[^/.]+$/, '');
    if (!target || !label.includes(target)) {
        return Boolean(baseName && baseName.length >= 6 && label.includes(baseName));
    }
    return true;
}

function collectAttachmentRecords(container, fileName, knownTestIds = new Set()) {
    if (!container || !fileName) return [];

    const records = [];
    const seenCards = new Set();
    const candidates = container.querySelectorAll(ATTACHMENT_CARD_SELECTORS.join(', '));

    for (const candidate of candidates) {
        const testId = candidate.getAttribute?.('data-testid');
        if (testId && knownTestIds.has(testId)) continue;

        const candidateLabel = getAttachmentLabel(candidate);
        if (!attachmentLabelMatches(candidateLabel, fileName)) continue;

        const card = findAttachmentCard(candidate, container);
        if (!card || seenCards.has(card)) continue;
        seenCards.add(card);

        const cardLabel = getAttachmentLabel(card);
        const statusText = normalizeAttachmentText([
            cardLabel,
            card.getAttribute?.('data-status'),
            card.getAttribute?.('aria-busy'),
            card.getAttribute?.('aria-live'),
            card.getAttribute?.('class')
        ].filter(Boolean).join(' '));

        records.push({
            card,
            label: cardLabel || candidateLabel,
            processing: ATTACHMENT_PROCESSING_PATTERN.test(statusText),
            error: ATTACHMENT_FAILURE_PATTERN.test(statusText)
        });
    }

    return records;
}

function getAttachmentSnapshot(containerGetter, fileName, knownTestIds = new Set()) {
    const records = collectAttachmentRecords(containerGetter(), fileName, knownTestIds);
    const eligibleRecords = records.filter((record) => !record.processing && !record.error);
    return {
        count: records.length,
        eligibleCount: eligibleRecords.length,
        signature: records.map((record) => `${record.label}|${record.processing ? 'processing' : record.error ? 'error' : 'ready'}`).sort().join('||'),
        records
    };
}

async function waitForConfirmedAttachment(containerGetter, fileName, previousSnapshot, timeoutMs = 5000, knownTestIds = new Set()) {
    const startTime = Date.now();
    let stableSignature = null;

    while (Date.now() - startTime < timeoutMs) {
        const current = getAttachmentSnapshot(containerGetter, fileName, knownTestIds);
        const hasNewEligibleCard = current.count > previousSnapshot.count && current.eligibleCount > previousSnapshot.eligibleCount;
        const hasUnfinishedTarget = current.records.some((record) => record.processing || record.error);
        const signature = `${current.count}:${current.eligibleCount}:${current.signature}`;

        if (hasNewEligibleCard && !hasUnfinishedTarget) {
            if (stableSignature === signature) return { ok: true, snapshot: current };
            stableSignature = signature;
            await delay(600);
        } else {
            stableSignature = null;
        }

        await delay(250);
    }

    return { ok: false, snapshot: getAttachmentSnapshot(containerGetter, fileName, knownTestIds) };
}

function getClaudeComposerContainer() {
    return (
        document.querySelector('[data-testid="chat-input-grid-container"]') ||
        document.querySelector('[data-testid="chat-input"]') ||
        document.querySelector('main') ||
        document.body
    );
}

const CLAUDE_KNOWN_TESTIDS = new Set([
    'chat-input-grid-container',
    'chat-input-grid-area',
    'prompt-input-ssr-interactive',
    'chat-input-ssr',
    'file-upload',
    'chat-input',
    'model-selector-dropdown'
]);

function getClaudeAttachmentTestIds() {
    const container = getClaudeComposerContainer();
    if (!container) return [];

    const ids = new Set();
    const elements = container.querySelectorAll('[data-testid]');
    for (const el of elements) {
        const id = el.getAttribute('data-testid');
        if (!id) continue;
        if (CLAUDE_KNOWN_TESTIDS.has(id)) continue;
        ids.add(id);
    }

    return Array.from(ids);
}

function isClaudeAttachmentPresent(fileName) {
    return getAttachmentSnapshot(getClaudeComposerContainer, fileName, CLAUDE_KNOWN_TESTIDS).eligibleCount > 0;
}

async function waitForClaudeAttachment(fileName, timeoutMs = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        if (isClaudeAttachmentPresent(fileName)) return true;
        await delay(200);
    }
    return false;
}

function getClaudeAttachmentCount() {
    return getClaudeAttachmentTestIds().length;
}

async function waitForClaudeAttachmentAdded(previousSnapshot, fileName, timeoutMs = 5000) {
    const snapshot = typeof previousSnapshot === 'number'
        ? { count: previousSnapshot, eligibleCount: previousSnapshot, signature: '', records: [] }
        : previousSnapshot;
    return waitForConfirmedAttachment(
        getClaudeComposerContainer,
        fileName,
        snapshot,
        timeoutMs,
        CLAUDE_KNOWN_TESTIDS
    );
}

// Test upload methods to find the working one
async function findWorkingUploadMethod() {
    console.log('🔍 Testing upload methods to find working one...');
    
    // Create a small test file
    const testFile = new File(['test'], 'test.txt', { type: 'text/plain' });
    const initialFileCount = getCurrentFileCount();
    
    const methods = [
        {
            name: 'attachment_button',
            test: async () => {
                const attachButton = findAttachmentButton();
                if (!attachButton) return false;
                
                attachButton.click();
                await delay(500);
                
                const fileInput = findFileInput();
                if (!fileInput) return false;
                
                await simulateFileUpload(fileInput, testFile);
                return true;
            }
        },
        {
            name: 'drag_drop',
            test: async () => {
                const dropZone = findDropZone();
                if (!dropZone) return false;
                
                await simulateDragAndDrop(dropZone, testFile);
                return true;
            }
        },
        {
            name: 'direct_input',
            test: async () => {
                const fileInput = findFileInput();
                if (!fileInput) return false;
                
                await simulateFileUpload(fileInput, testFile);
                return true;
            }
        }
    ];
    
    for (const method of methods) {
        try {
            console.log(`Testing method: ${method.name}`);
            
            const success = await method.test();
            if (!success) {
                console.log(`❌ Method ${method.name} failed - mechanism not found`);
                continue;
            }
            
            // Wait longer and check if file count increased
            console.log('⏳ Waiting for upload to process...');
            await delay(3000);
            const newFileCount = getCurrentFileCount();
            
            if (newFileCount > initialFileCount) {
                console.log(`✅ Method ${method.name} works! File count: ${initialFileCount} → ${newFileCount}`);
                return method.name;
            } else {
                console.log(`❌ Method ${method.name} failed - no file detected in UI`);
            }
            
        } catch (error) {
            console.log(`❌ Method ${method.name} failed with error:`, error.message);
        }
        
        // Longer delay between method tests to let interface reset
        await delay(1000);
    }
    
    console.log('❌ No working upload method found');
    return null;
}

// Main function to upload PDFs to ChatGPT using drag-and-drop
async function uploadPDFsToChatGPT(pdfs) {
    console.log('Starting upload of', pdfs.length, 'PDFs to ChatGPT using drag-and-drop method');
    
    // Use drag-and-drop method directly
    const workingMethod = 'drag_drop';
    console.log(`📤 Using drag-and-drop method for all uploads`);
    
    console.log('📄 Starting individual upload strategy');
    
    let successfulUploads = 0;
    const outcomes = [];
    
    for (let i = 0; i < pdfs.length; i++) {
        const pdf = pdfs[i];
        console.log(`\n📄 Uploading PDF ${i + 1}/${pdfs.length}: ${pdf.name}`);
        let dispatchAttempted = false;
        
        try {
            // Convert this specific PDF to File object
            const byteCharacters = atob(pdf.data);
            const byteNumbers = new Array(byteCharacters.length);
            for (let j = 0; j < byteCharacters.length; j++) {
                byteNumbers[j] = byteCharacters.charCodeAt(j);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: 'application/pdf' });
            const file = new File([blob], pdf.name, { type: 'application/pdf' });
            
            // Use drag-and-drop method directly
            const dropZone = findDropZone();
            if (!dropZone) {
                outcomes.push({
                    paperId: pdf.id || pdf.info?.id,
                    name: pdf.name,
                    status: 'failed',
                    error: 'ChatGPT upload drop zone was not found.'
                });
                continue;
            }

            const previousSnapshot = getAttachmentSnapshot(getChatGPTComposerContainer, pdf.name);
            console.log(`📤 Drag-dropping ${pdf.name}...`);
            dispatchAttempted = true;
            await simulateDragAndDrop(dropZone, file);

            const confirmation = await waitForConfirmedAttachment(
                getChatGPTComposerContainer,
                pdf.name,
                previousSnapshot,
                5000
            );

            if (confirmation.ok) {
                successfulUploads++;
                outcomes.push({
                    paperId: pdf.id || pdf.info?.id,
                    name: pdf.name,
                    status: 'attached'
                });
                console.log(`✅ Upload ${i + 1} confirmed: ${pdf.name}`);
            } else {
                outcomes.push({
                    paperId: pdf.id || pdf.info?.id,
                    name: pdf.name,
                    status: 'unconfirmed',
                    error: `ChatGPT did not show a stable attachment for ${pdf.name}.`
                });
                console.warn(`⚠️ Upload ${i + 1} could not be confirmed: ${pdf.name}`);
            }

            if (i < pdfs.length - 1) await delay(800);
            
        } catch (error) {
            console.error(`Error uploading ${pdf.name}:`, error);
            outcomes.push({
                paperId: pdf.id || pdf.info?.id,
                name: pdf.name,
                status: dispatchAttempted ? 'unconfirmed' : 'failed',
                error: error?.message || String(error)
            });
        }
    }
    
    console.log(`\n📊 Upload Summary:`);
    console.log(`- Attempted: ${pdfs.length}`);
    console.log(`- Successful: ${successfulUploads}`);
    return { uploadedCount: successfulUploads, outcomes };
}

// Upload single PDF using specific method
async function uploadSinglePDFWithMethod(pdf, method) {
    try {
        console.log(`Using method ${method} to upload: ${pdf.name}`);
        
        // Convert base64 back to blob
        const byteCharacters = atob(pdf.data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: 'application/pdf' });
        
        // Create File object
        const file = new File([blob], pdf.name, { type: 'application/pdf' });
        const previousSnapshot = getAttachmentSnapshot(getChatGPTComposerContainer, pdf.name);
        
        let uploadSuccess = false;
        
        switch (method) {
            case 'attachment_button':
                const attachButton = findAttachmentButton();
                if (attachButton) {
                    attachButton.click();
                    await delay(800); // Increased delay for attachment button
                    
                    const fileInput = findFileInput();
                    if (fileInput) {
                        await simulateFileUpload(fileInput, file);
                        uploadSuccess = true;
                    }
                }
                break;
                
            case 'drag_drop':
                const dropZone = findDropZone();
                if (dropZone) {
                    await simulateDragAndDrop(dropZone, file);
                    uploadSuccess = true;
                }
                break;
                
            case 'direct_input':
                const fileInput = findFileInput();
                if (fileInput) {
                    await simulateFileUpload(fileInput, file);
                    uploadSuccess = true;
                }
                break;
        }
        
        if (!uploadSuccess) {
            throw new Error(`Method ${method} failed - mechanism not available`);
        }
        
        // Wait a bit before verification to let UI update
        await delay(1000);
        
        // Verify the upload was successful
        const verified = await verifyFileUpload(pdf.name, 5000, previousSnapshot); // Increased timeout
        
        if (verified) {
            console.log(`✅ ${pdf.name} uploaded and verified successfully`);
            return true;
        } else {
            console.log(`❌ ${pdf.name} upload not verified in UI`);
            return false;
        }
        
    } catch (error) {
        console.error(`Error uploading ${pdf.name} with method ${method}:`, error);
        return false;
    }
}

// Upload a single PDF file (legacy function - keeping for compatibility)
async function uploadSinglePDF(pdf) {
    try {
        console.log(`Attempting to upload: ${pdf.name}`);
        
        // Convert base64 back to blob
        const byteCharacters = atob(pdf.data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: 'application/pdf' });
        
        // Create File object
        const file = new File([blob], pdf.name, { type: 'application/pdf' });
        
        // Method 1: Enhanced attachment button + file input approach
        const attachButton = findAttachmentButton();
        if (attachButton) {
            console.log('Method 1: Using attachment button approach');
            
            try {
                // Click the attachment button
                attachButton.click();
                console.log('Clicked attachment button');
                
                // Wait for file input to appear and try multiple times
                for (let attempts = 0; attempts < 5; attempts++) {
                    await new Promise(resolve => setTimeout(resolve, 200 * (attempts + 1)));
                    
                    const fileInput = findFileInput();
                    if (fileInput) {
                        console.log(`Found file input on attempt ${attempts + 1}`);
                        await simulateFileUpload(fileInput, file);
                        
                        // Verify upload success by checking for file in UI
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        console.log('Attachment button method completed');
                        return;
                    }
                }
                console.log('File input not found after clicking attachment button');
            } catch (error) {
                console.log('Attachment button method failed:', error.message);
            }
        }
        
        // Method 2: Enhanced drag and drop to main input area
        const dropZone = findDropZone();
        if (dropZone) {
            console.log('Method 2: Using enhanced drag and drop');
            
            try {
                await simulateDragAndDrop(dropZone, file);
                console.log('Enhanced drag and drop completed');
                return;
            } catch (error) {
                console.log('Enhanced drag and drop failed:', error.message);
            }
        }
        
        // Method 3: Direct file input manipulation
        const fileInput = findFileInput();
        if (fileInput) {
            console.log('Method 3: Using direct file input');
            
            try {
                await simulateFileUpload(fileInput, file);
                console.log('Direct file input method completed');
                return;
            } catch (error) {
                console.log('Direct file input failed:', error.message);
            }
        }
        
        // Method 4: Alternative drop zones
        console.log('Method 4: Trying alternative drop zones');
        const alternativeZones = document.querySelectorAll('div, textarea, input');
        for (const zone of alternativeZones) {
            if (zone.offsetParent !== null && 
                (zone.tagName === 'TEXTAREA' || 
                 zone.contentEditable === 'true' ||
                 zone.type === 'text')) {
                
                try {
                    await simulateDragAndDrop(zone, file);
                    console.log('Alternative drop zone method completed');
                    return;
                } catch (error) {
                    // Continue to next zone
                }
            }
        }
        
        throw new Error(`Failed to upload ${pdf.name} - no working upload mechanism found`);
        
    } catch (error) {
        console.error(`Error uploading ${pdf.name}:`, error);
        throw error;
    }
}

function findClaudeDropZone() {
    const selectors = [
        'textarea[data-testid="chat-input-ssr"]',
        'textarea[aria-label="Write your prompt to Claude"]',
        'textarea[aria-label*="Write your prompt"]',
        'textarea[placeholder*="help you"]',
        'textarea'
    ];

    for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el && !el.disabled) return el;
    }

    return null;
}

let claudeDragDropSupported = null;

async function uploadSingleFileToClaude(file) {
    const fileName = file?.name || 'file';
    const previousSnapshot = getAttachmentSnapshot(getClaudeComposerContainer, fileName, CLAUDE_KNOWN_TESTIDS);
    const sizeBytes = typeof file?.size === 'number' ? file.size : 0;
    const waitMs = Math.min(60000, Math.max(10000, Math.ceil(sizeBytes / (1024 * 1024)) * 8000));
    let dispatchAttempted = false;
    let fileInputForCleanup = null;

    try {
        // Try drag-and-drop first (matches Claude's UX, if supported)
        const dropZone = claudeDragDropSupported === false ? null : findClaudeDropZone();
        if (dropZone) {
            console.log(`📤 [Claude] Drag-dropping ${fileName}...`);
            dispatchAttempted = true;
            await simulateDragAndDrop(dropZone, file);
            const confirmation = await waitForClaudeAttachmentAdded(previousSnapshot, fileName, 2500);
            if (confirmation.ok) {
                claudeDragDropSupported = true;
                return { status: 'attached', method: 'drag_drop' };
            }
            if (claudeDragDropSupported === null) claudeDragDropSupported = false;
            console.log(`⚠️ [Claude] Drag-drop did not show a confirmed attachment for ${fileName}, falling back to file input...`);
        }

        // Fallback: hidden file input (works if Claude wires change/input events)
        fileInputForCleanup = findClaudeFileInput() || findFileInput();
        if (!fileInputForCleanup) {
            const error = new Error('No Claude file input found. Are you on an active chat and logged in?');
            error.uploadStatus = dispatchAttempted ? 'unconfirmed' : 'failed';
            throw error;
        }

        console.log(`📤 [Claude] Using file input for ${fileName}...`);
        dispatchAttempted = true;
        await simulateFileUpload(fileInputForCleanup, file);

        const confirmation = await waitForClaudeAttachmentAdded(previousSnapshot, fileName, waitMs);
        if (!confirmation.ok) {
            const attachmentIds = getClaudeAttachmentTestIds();
            const suffix = attachmentIds.length ? ` (found attachments: ${attachmentIds.slice(0, 5).join(', ')})` : '';
            const error = new Error(`Claude did not show a stable attachment for ${fileName}${suffix}`);
            error.uploadStatus = 'unconfirmed';
            throw error;
        }

        // Restore the native `files` property for future uploads (prevents interfering with normal selection).
        return { status: 'attached', method: 'file_input' };
    } catch (error) {
        if (error && !error.uploadStatus) error.uploadStatus = dispatchAttempted ? 'unconfirmed' : 'failed';
        throw error;
    } finally {
        if (fileInputForCleanup && Object.prototype.hasOwnProperty.call(fileInputForCleanup, 'files')) {
            try {
                delete fileInputForCleanup.files;
            } catch (error) {
                // Best-effort cleanup; safe to ignore.
            }
        }
    }
}

// Upload PDFs to Claude using its hidden file input
async function uploadPDFsToClaude(pdfs) {
    console.log('Starting upload of', pdfs.length, 'PDFs to Claude');

    let successfulUploads = 0;
    const outcomes = [];

    for (let i = 0; i < pdfs.length; i++) {
        const pdf = pdfs[i];
        console.log(`\n📄 Uploading PDF ${i + 1}/${pdfs.length}: ${pdf.name}`);

        try {
            const file = base64ToFile(pdf.data, pdf.name, 'application/pdf');

            const result = await uploadSingleFileToClaude(file);
            successfulUploads++;
            outcomes.push({
                paperId: pdf.id || pdf.info?.id,
                name: pdf.name,
                status: 'attached',
                method: result?.method
            });
            console.log(`✅ Upload ${i + 1} confirmed: ${pdf.name}`);

            // Small delay between uploads for UI stabilization
            if (i < pdfs.length - 1) {
                await delay(800);
            }
        } catch (error) {
            console.error(`Error uploading ${pdf.name} to Claude:`, error);
            outcomes.push({
                paperId: pdf.id || pdf.info?.id,
                name: pdf.name,
                status: error?.uploadStatus || 'failed',
                error: error?.message || String(error)
            });
        }
    }

    console.log(`\n📊 Claude Upload Summary:`);
    console.log(`- Attempted: ${pdfs.length}`);
    console.log(`- Successful: ${successfulUploads}`);

    return { uploadedCount: successfulUploads, outcomes };
}

// Find file input element
function findFileInput() {
    const selectors = [
        'input[type="file"]',
        'input[data-testid="file-upload"]', // Claude
        '[data-testid="file-upload-input"]',
        'input[accept*="pdf"]',
        'input[accept*="/*"]'
    ];
    
    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && !element.disabled) {
            return element;
        }
    }
    return null;
}

function findClaudeFileInput() {
    const selectors = [
        'input[type="file"][data-testid="file-upload"]',
        'input[type="file"]#chat-input-file-upload-onpage',
        'input[type="file"][aria-label*="Upload"]',
        'input[type="file"][aria-label*="upload"]'
    ];

    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && !element.disabled) {
            return element;
        }
    }
    return null;
}

// Enhanced drop zone detection for ChatGPT
function findDropZone() {
    console.log('Searching for drop zones...');
    
    // ChatGPT-specific selectors (updated for current interface)
    const selectors = [
        // Claude
        'textarea[data-testid="chat-input-ssr"]',
        'textarea[aria-label*="Write your prompt"]',
        // ChatGPT
        '[data-testid="file-drop-zone"]',
        '[data-testid="chat-input"]',
        '[data-testid="prompt-textarea"]',
        'textarea[placeholder*="message"]',
        'textarea[placeholder*="Message"]',
        '.composer-container',
        '.chat-input-container',
        '.input-container',
        '.text-input-container',
        'div[contenteditable="true"]',
        'form textarea',
        'main textarea',
        'div[role="textbox"]'
    ];
    
    // Try specific selectors first
    for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
            if (element.offsetParent !== null) { // Element is visible
                console.log('Found potential drop zone:', selector);
                return element;
            }
        }
    }
    
    // Fallback: Look for any interactive area that might accept drops
    const fallbackSelectors = [
        'div[role="button"]',
        '.file-drop-zone',
        '.drop-zone'
    ];
    
    for (const selector of fallbackSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
            const text = element.textContent.toLowerCase();
            if ((text.includes('drop') || text.includes('file') || text.includes('upload') || 
                 text.includes('attach') || text.includes('drag')) && 
                element.offsetParent !== null) {
                console.log('Found fallback drop zone:', selector);
                return element;
            }
        }
    }
    
    // Last resort: Find the main input area
    const mainInput = document.querySelector('textarea') || 
                     document.querySelector('div[contenteditable="true"]') ||
                     document.querySelector('input[type="text"]');
    
    if (mainInput && mainInput.offsetParent !== null) {
        console.log('Using main input as drop zone');
        return mainInput;
    }
    
    console.log('No drop zone found');
    return null;
}

// Enhanced attachment button detection for ChatGPT
function findAttachmentButton() {
    console.log('Searching for attachment buttons...');
    
    // ChatGPT-specific attachment button selectors
    const selectors = [
        'button[aria-label*="ttach"]',
        'button[aria-label*="Upload"]',
        'button[aria-label*="File"]',
        'button[title*="ttach"]',
        'button[title*="Upload"]',
        'button[data-testid*="attach"]',
        'button[data-testid*="upload"]',
        'button[data-testid*="file"]',
        '.attachment-button',
        '[data-testid="attachment-button"]',
        '[data-testid="file-upload-button"]',
        'button svg[class*="paperclip"]',
        'button svg[class*="attach"]',
        'button svg[class*="plus"]'
    ];
    
    // Try specific selectors first
    for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
            if (element.offsetParent !== null && !element.disabled) {
                console.log('Found attachment button:', selector);
                return element.closest('button') || element;
            }
        }
    }
    
    // Look for buttons with specific SVG paths or icons
    const buttons = document.querySelectorAll('button');
    for (const button of buttons) {
        if (button.offsetParent === null || button.disabled) continue;
        
        const svg = button.querySelector('svg');
        const buttonText = button.textContent.toLowerCase();
        const buttonHTML = button.innerHTML.toLowerCase();
        const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase();
        
        // Check for attachment-related content
        if (svg && (
            buttonHTML.includes('paperclip') ||
            buttonHTML.includes('attach') ||
            buttonHTML.includes('clip') ||
            buttonHTML.includes('plus') ||
            buttonHTML.includes('upload')
        )) {
            console.log('Found attachment button by SVG content');
            return button;
        }
        
        // Check aria-label and text content
        if (ariaLabel.includes('attach') || 
            ariaLabel.includes('upload') || 
            ariaLabel.includes('file') ||
            buttonText.includes('attach') ||
            buttonText.includes('+')) {
            console.log('Found attachment button by text/aria-label');
            return button;
        }
        
        // Check for plus icon specifically (common in ChatGPT)
        if (svg && buttonText.trim() === '' && 
            (buttonHTML.includes('M12 4v8m-8-4h8') || // Plus icon path
             buttonHTML.includes('plus') ||
             ariaLabel.includes('add'))) {
            console.log('Found plus/add button (potential attachment)');
            return button;
        }
    }
    
    console.log('No attachment button found');
    return null;
}

// Simulate file upload by setting files property
async function simulateFileUpload(input, file, fileList = null) {
    try {
        console.log('Attempting to simulate file upload for:', fileList ? `${fileList.length} files` : file.name);
        
        // Create proper FileList object
        let finalFileList;
        if (fileList) {
            // Use provided fileList (for batch uploads)
            finalFileList = fileList;
        } else {
            // Create FileList for single file
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            finalFileList = dataTransfer.files;
        }
        
        // Check if files property is configurable
        const descriptor = Object.getOwnPropertyDescriptor(input, 'files');
        if (descriptor && !descriptor.configurable) {
            console.log('Files property not configurable, using alternative method');
            
            // Alternative approach: Use the native files property from finalFileList
            try {
                input.files = finalFileList;
            } catch (e) {
                console.log('Direct assignment failed, trying descriptor override');
                
                // Try to use the finalFileList directly in events
                const changeEvent = new Event('change', { bubbles: true });
                Object.defineProperty(changeEvent, 'target', {
                    value: {
                        ...input,
                        files: finalFileList
                    },
                    writable: false
                });
                input.dispatchEvent(changeEvent);
                
                const inputEvent = new Event('input', { bubbles: true });
                Object.defineProperty(inputEvent, 'target', {
                    value: {
                        ...input,
                        files: finalFileList
                    },
                    writable: false
                });
                input.dispatchEvent(inputEvent);
                
                console.log('File upload simulated using event target override');
                return;
            }
        } else {
            // Property is configurable, use original method
            Object.defineProperty(input, 'files', {
                value: finalFileList,
                writable: false,
                configurable: true
            });
        }
        
        // Trigger events
        const changeEvent = new Event('change', { bubbles: true });
        input.dispatchEvent(changeEvent);
        
        const inputEvent = new Event('input', { bubbles: true });
        input.dispatchEvent(inputEvent);
        
        // Also trigger focus and blur for good measure
        input.focus();
        setTimeout(() => input.blur(), 100);
        
        // Wait a moment for processing
        await new Promise(resolve => setTimeout(resolve, 500));
        
        console.log('File upload simulated successfully');
        
    } catch (error) {
        console.error('Error simulating file upload:', error);
        throw error;
    }
}

// Enhanced drag and drop simulation
async function simulateDragAndDrop(dropZone, file) {
    try {
        console.log('Starting enhanced drag and drop simulation');
        
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        
        // Simulate realistic drag sequence with timing
        const simulateDragSequence = async () => {
            // 1. DragEnter
            const dragEnterEvent = new DragEvent('dragenter', {
                bubbles: true,
                cancelable: true,
                dataTransfer: dataTransfer,
                clientX: dropZone.offsetLeft + 50,
                clientY: dropZone.offsetTop + 50
            });
            dropZone.dispatchEvent(dragEnterEvent);
            console.log('Dispatched dragenter');
            
            await new Promise(resolve => setTimeout(resolve, 50));
            
            // 2. DragOver (multiple times to simulate real drag)
            for (let i = 0; i < 3; i++) {
                const dragOverEvent = new DragEvent('dragover', {
                    bubbles: true,
                    cancelable: true,
                    dataTransfer: dataTransfer,
                    clientX: dropZone.offsetLeft + 50 + i * 10,
                    clientY: dropZone.offsetTop + 50 + i * 5
                });
                dragOverEvent.preventDefault();
                dropZone.dispatchEvent(dragOverEvent);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            console.log('Dispatched dragover events');
            
            // 3. Drop
            const dropEvent = new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                dataTransfer: dataTransfer,
                clientX: dropZone.offsetLeft + 80,
                clientY: dropZone.offsetTop + 80
            });
            dropEvent.preventDefault();
            dropZone.dispatchEvent(dropEvent);
            console.log('Dispatched drop event');
            
            // 4. DragLeave
            await new Promise(resolve => setTimeout(resolve, 50));
            const dragLeaveEvent = new DragEvent('dragleave', {
                bubbles: true,
                dataTransfer: dataTransfer
            });
            dropZone.dispatchEvent(dragLeaveEvent);
            console.log('Dispatched dragleave');
        };
        
        await simulateDragSequence();
        
    } catch (error) {
        console.error('Error simulating enhanced drag and drop:', error);
        throw error;
    }
}

// Utility function to wait for element
function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const element = document.querySelector(selector);
        if (element) {
            resolve(element);
            return;
        }
        
        const observer = new MutationObserver((mutations) => {
            const element = document.querySelector(selector);
            if (element) {
                observer.disconnect();
                resolve(element);
            }
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
        
        setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Element ${selector} not found within ${timeout}ms`));
        }, timeout);
    });
}

// Utility function to add delay
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Enhanced utility to convert base64 to File object
function base64ToFile(base64, filename, mimeType) {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: mimeType });
    return new File([blob], filename, { type: mimeType });
}

// Convert base64 to ArrayBuffer for background script File constructor
function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

// Upload verification system
async function verifyFileUpload(fileName, maxWaitTime = 5000, previousSnapshot = null) {
    console.log(`Verifying upload of ${fileName}...`);
    const before = previousSnapshot || getAttachmentSnapshot(getChatGPTComposerContainer, fileName);
    const confirmation = await waitForConfirmedAttachment(
        getChatGPTComposerContainer,
        fileName,
        before,
        maxWaitTime
    );
    if (confirmation.ok) {
        console.log(`✅ File ${fileName} verified in the composer`);
        return true;
    }
    console.log(`❌ File ${fileName} not verified in the composer after ${maxWaitTime}ms`);
    return false;
}

// Get current uploaded files count for comparison
function getCurrentFileCount() {
    const fileElements = document.querySelectorAll([
        '[data-testid*="file"]',
        '.file-item',
        '.attachment',
        '.uploaded-file',
        'svg[class*="file"]',
        '.file-preview',
        '.file-attachment'
    ].join(', '));
    
    return fileElements.length;
}

// Batch upload multiple files at once (for methods that support it)
async function batchUploadFiles(files, method) {
    console.log(`🎯 Attempting batch upload of ${files.length} files using ${method}`);
    
    switch (method) {
        case 'attachment_button':
            const attachButton = findAttachmentButton();
            if (attachButton) {
                attachButton.click();
                await delay(800);
                
                const fileInput = findFileInput();
                if (fileInput) {
                    // Try to set multiple files at once
                    const dataTransfer = new DataTransfer();
                    files.forEach(file => dataTransfer.items.add(file));
                    
                    try {
                        await simulateFileUpload(fileInput, null, dataTransfer.files);
                        return true;
                    } catch (error) {
                        console.log('Batch upload failed, falling back to individual uploads');
                        return false;
                    }
                }
            }
            break;
            
        case 'drag_drop':
            const dropZone = findDropZone();
            if (dropZone) {
                // Create DataTransfer with all files
                const dataTransfer = new DataTransfer();
                files.forEach(file => dataTransfer.items.add(file));
                
                try {
                    await simulateDragAndDropBatch(dropZone, dataTransfer);
                    return true;
                } catch (error) {
                    console.log('Batch drag-drop failed, falling back to individual uploads');
                    return false;
                }
            }
            break;
            
        case 'direct_input':
            // Most direct inputs don't support multiple files well
            return false;
    }
    
    return false;
}

// Enhanced drag and drop for batch uploads
async function simulateDragAndDropBatch(dropZone, dataTransfer) {
    try {
        console.log('Starting batch drag and drop simulation');
        
        // Simulate realistic drag sequence with all files
        const simulateDragSequence = async () => {
            // 1. DragEnter
            const dragEnterEvent = new DragEvent('dragenter', {
                bubbles: true,
                cancelable: true,
                dataTransfer: dataTransfer,
                clientX: dropZone.offsetLeft + 50,
                clientY: dropZone.offsetTop + 50
            });
            dropZone.dispatchEvent(dragEnterEvent);
            console.log('Dispatched batch dragenter');
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // 2. DragOver
            const dragOverEvent = new DragEvent('dragover', {
                bubbles: true,
                cancelable: true,
                dataTransfer: dataTransfer,
                clientX: dropZone.offsetLeft + 60,
                clientY: dropZone.offsetTop + 60
            });
            dragOverEvent.preventDefault();
            dropZone.dispatchEvent(dragOverEvent);
            console.log('Dispatched batch dragover');
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // 3. Drop (with all files)
            const dropEvent = new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                dataTransfer: dataTransfer,
                clientX: dropZone.offsetLeft + 70,
                clientY: dropZone.offsetTop + 70
            });
            dropEvent.preventDefault();
            dropZone.dispatchEvent(dropEvent);
            console.log('Dispatched batch drop event with', dataTransfer.files.length, 'files');
        };
        
        await simulateDragSequence();
        
    } catch (error) {
        console.error('Error simulating batch drag and drop:', error);
        throw error;
    }
}

// Download files for manual upload fallback
async function downloadFilesForManualUpload(pdfs) {
    console.log('📥 Downloading files for manual upload...');
    
    for (let i = 0; i < pdfs.length; i++) {
        const pdf = pdfs[i];
        
        try {
            // Convert base64 to blob
            const byteCharacters = atob(pdf.data);
            const byteNumbers = new Array(byteCharacters.length);
            for (let j = 0; j < byteCharacters.length; j++) {
                byteNumbers[j] = byteCharacters.charCodeAt(j);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: 'application/pdf' });
            
            // Create download link
            const url = URL.createObjectURL(blob);
            const downloadLink = document.createElement('a');
            downloadLink.href = url;
            downloadLink.download = pdf.name;
            downloadLink.style.display = 'none';
            
            // Trigger download
            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);
            
            // Clean up URL
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            
            console.log(`✅ Downloaded: ${pdf.name}`);
            
            // Small delay between downloads
            if (i < pdfs.length - 1) {
                await delay(500);
            }
            
        } catch (error) {
            console.error(`Error downloading ${pdf.name}:`, error);
        }
    }
    
    console.log('📥 Manual download completed');
}

// Inject custom prompt into ChatGPT's input field
async function injectPromptToChatGPT(promptText) {
    try {
        console.log('🔤 Attempting to inject prompt:', promptText);
        
        // First try to find the ProseMirror editor
        const proseMirrorDiv = document.querySelector('#prompt-textarea[contenteditable="true"]');
        if (proseMirrorDiv) {
            console.log('Found ProseMirror div, injecting prompt...');
            
            // Clear existing content and set new content
            proseMirrorDiv.innerHTML = `<p>${promptText}</p>`;
            
            // Trigger input events to notify ProseMirror of the change
            const inputEvent = new Event('input', { bubbles: true });
            proseMirrorDiv.dispatchEvent(inputEvent);
            
            const focusEvent = new Event('focus', { bubbles: true });
            proseMirrorDiv.dispatchEvent(focusEvent);
            
            console.log('✅ Prompt injected via ProseMirror');
            return;
        }
        
        // Fallback: try to find the textarea
        const textarea = document.querySelector('textarea[name="prompt-textarea"]');
        if (textarea) {
            console.log('Found textarea, injecting prompt...');
            
            textarea.value = promptText;
            textarea.style.display = 'block'; // Make visible if hidden
            
            // Trigger events
            const inputEvent = new Event('input', { bubbles: true });
            textarea.dispatchEvent(inputEvent);
            
            const changeEvent = new Event('change', { bubbles: true });
            textarea.dispatchEvent(changeEvent);
            
            console.log('✅ Prompt injected via textarea');
            return;
        }
        
        // Last resort: try any contenteditable div that might be the input
        const contentEditableInputs = document.querySelectorAll('div[contenteditable="true"]');
        for (const input of contentEditableInputs) {
            if (input.closest('[class*="input"]') || input.closest('[class*="prompt"]')) {
                console.log('Found alternative contenteditable input, injecting prompt...');
                
                input.innerHTML = `<p>${promptText}</p>`;
                
                const inputEvent = new Event('input', { bubbles: true });
                input.dispatchEvent(inputEvent);
                
                console.log('✅ Prompt injected via alternative method');
                return;
            }
        }
        
        throw new Error('Could not find ChatGPT input field to inject prompt');
        
    } catch (error) {
        console.error('Error injecting prompt:', error);
        throw error;
    }
}

// Inject custom prompt into Claude's textarea
async function injectPromptToClaude(promptText) {
    try {
        console.log('🔤 Attempting to inject prompt into Claude:', promptText);

        const selectors = [
            'textarea[data-testid="chat-input-ssr"]',
            'textarea[aria-label="Write your prompt to Claude"]',
            'textarea[aria-label*="Write your prompt"]',
            'textarea[placeholder*="help you"]',
            'textarea'
        ];

        let textarea = null;
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el && el.offsetParent !== null && !el.disabled) {
                textarea = el;
                break;
            }
        }

        if (!textarea) {
            throw new Error('Could not find Claude input textarea to inject prompt');
        }

        textarea.focus();

        // Use the native setter to work with React-controlled inputs
        const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (valueSetter) {
            valueSetter.call(textarea, promptText);
        } else {
            textarea.value = promptText;
        }

        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));

        console.log('✅ Prompt injected into Claude');
    } catch (error) {
        console.error('Error injecting prompt into Claude:', error);
        throw error;
    }
}
