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
        documentUrlPatterns: ["*://chatgpt.com/*", "*://chat.openai.com/*"]
    });
});

// Listen for tab updates to check if user navigates to ChatGPT
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        const isChatGPT = tab.url.includes('chatgpt.com') || tab.url.includes('chat.openai.com');
        
        if (isChatGPT) {
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
});

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