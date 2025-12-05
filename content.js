// Content script for ChatGPT file upload
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
            
            uploadPDFsToChatGPT(message.pdfs)
                .then(() => {
                    console.log('Upload completed successfully');
                    sendResponse({ success: true });
                })
                .catch(error => {
                    console.error('Upload error:', error);
                    sendResponse({ success: false, error: error.message });
                });
            return true; // Keep message channel open for async response
        }
        
        if (message.action === 'injectPrompt') {
            console.log('Content script received prompt injection request');
            
            injectPromptToChatGPT(message.prompt)
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
    
    // Track successful uploads
    let successfulUploads = 0;
    const initialFileCount = getCurrentFileCount();
    
    for (let i = 0; i < pdfs.length; i++) {
        const pdf = pdfs[i];
        console.log(`\n📄 Uploading PDF ${i + 1}/${pdfs.length}: ${pdf.name}`);
        
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
            if (dropZone) {
                console.log(`📤 Drag-dropping ${pdf.name}...`);
                await simulateDragAndDrop(dropZone, file);
                
                // Wait for upload to process
                await delay(2000);
                
                // Assume success - no verification to avoid confusion
                successfulUploads++;
                console.log(`✅ Upload ${i + 1} completed: ${pdf.name}`);
            } else {
                console.log(`❌ No drop zone found for ${pdf.name}`);
            }
            
            // Longer delay between uploads to let ChatGPT stabilize
            if (i < pdfs.length - 1) {
                console.log('⏳ Waiting before next upload...');
                await delay(2000);
            }
            
        } catch (error) {
            console.error(`Error uploading ${pdf.name}:`, error);
        }
    }
    
    const finalFileCount = getCurrentFileCount();
    console.log(`\n📊 Upload Summary:`);
    console.log(`- Attempted: ${pdfs.length}`);
    console.log(`- Successful: ${successfulUploads}`);
    console.log(`- Files in UI: ${finalFileCount} (was ${initialFileCount})`);
    
    if (successfulUploads === 0) {
        throw new Error('No files were uploaded successfully. Please try refreshing ChatGPT and try again.');
    }
    
    console.log('🎉 Upload process completed');
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
        const verified = await verifyFileUpload(pdf.name, 5000); // Increased timeout
        
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

// Find file input element
function findFileInput() {
    const selectors = [
        'input[type="file"]',
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

// Enhanced drop zone detection for ChatGPT
function findDropZone() {
    console.log('Searching for drop zones...');
    
    // ChatGPT-specific selectors (updated for current interface)
    const selectors = [
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
async function verifyFileUpload(fileName, maxWaitTime = 5000) {
    console.log(`Verifying upload of ${fileName}...`);
    
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime) {
        // Look for file indicators in ChatGPT's interface
        const fileElements = document.querySelectorAll([
            '[data-testid*="file"]',
            '.file-item',
            '.attachment',
            '.uploaded-file',
            'div[title*=".pdf"]',
            'span[title*=".pdf"]',
            '[aria-label*=".pdf"]'
        ].join(', '));
        
        for (const element of fileElements) {
            const text = element.textContent || element.title || element.ariaLabel || '';
            if (text.includes(fileName) || text.includes(fileName.replace(/\.[^/.]+$/, ""))) {
                console.log(`✅ File ${fileName} verified in UI`);
                return true;
            }
        }
        
        // Also check for generic file upload indicators
        const genericFileIndicators = document.querySelectorAll([
            'svg[class*="file"]',
            '.file-preview',
            '.file-attachment',
            '[class*="attachment"]'
        ].join(', '));
        
        if (genericFileIndicators.length > 0) {
            console.log(`✅ Generic file indicator found for ${fileName}`);
            return true;
        }
        
        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    console.log(`❌ File ${fileName} not verified in UI after ${maxWaitTime}ms`);
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







