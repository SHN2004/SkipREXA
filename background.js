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

// Listen for tab updates to check if user navigates to supported LLM platforms
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        const isSupportedPlatform = tab.url.includes('chatgpt.com') || 
                                    tab.url.includes('chat.openai.com');
        
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
        // Handle PDF via native Chrome Downloads API
        chrome.downloads.download({
            url: message.url,
            conflictAction: 'uniquify',
            saveAs: false
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error('Background PDF download error:', chrome.runtime.lastError.message);
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
                console.log('PDF download started with ID:', downloadId);
                sendResponse({ success: true, downloadId: downloadId, isNativeDownload: true });
            }
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
    
    // Handle active tab requests
    if (message.action === 'getActiveTab') {
        chrome.tabs.query({active: true, currentWindow: true})
            .then(tabs => sendResponse(tabs[0]))
            .catch(error => sendResponse({error: error.message}));
        return true; // keep channel open
    }
    
    
});


chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "upload-papers") {
        // Open extension popup or trigger upload
        chrome.action.openPopup();
    }
});