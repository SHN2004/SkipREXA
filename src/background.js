// Background script for Chrome extension
console.log('🚀 Background script loaded at:', new Date().toISOString());

const RSMS_SPEED_MODE_STORAGE_KEY = 'skiprexa_rsms_speed_mode_enabled';
const RSMS_ATTENDANCE_UI_STORAGE_KEY = 'skiprexa_attendance_ui_enabled';
const RSMS_SPEED_MODE_RULESET_ID = 'rsms_speed_mode';

async function applyRsmsSpeedModeRules(enabled) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: enabled ? [RSMS_SPEED_MODE_RULESET_ID] : [],
        disableRulesetIds: enabled ? [] : [RSMS_SPEED_MODE_RULESET_ID]
    });
}

async function syncRsmsSpeedModeRuleset() {
    const result = await chrome.storage.local.get([RSMS_SPEED_MODE_STORAGE_KEY]);
    const storedValue = result[RSMS_SPEED_MODE_STORAGE_KEY];
    const enabled = typeof storedValue === 'boolean' ? storedValue : true;

    if (typeof storedValue !== 'boolean') {
        await chrome.storage.local.set({ [RSMS_SPEED_MODE_STORAGE_KEY]: enabled });
    }

    await applyRsmsSpeedModeRules(enabled);
    return enabled;
}

async function setRsmsSpeedMode(enabled) {
    await chrome.storage.local.set({ [RSMS_SPEED_MODE_STORAGE_KEY]: enabled });
    await applyRsmsSpeedModeRules(enabled);
    return enabled;
}

async function getRsmsAttendanceUiEnabled() {
    const result = await chrome.storage.local.get([RSMS_ATTENDANCE_UI_STORAGE_KEY]);
    const storedValue = result[RSMS_ATTENDANCE_UI_STORAGE_KEY];
    const enabled = typeof storedValue === 'boolean' ? storedValue : true;

    if (typeof storedValue !== 'boolean') {
        await chrome.storage.local.set({ [RSMS_ATTENDANCE_UI_STORAGE_KEY]: enabled });
    }

    return enabled;
}

async function setRsmsAttendanceUi(enabled) {
    await chrome.storage.local.set({ [RSMS_ATTENDANCE_UI_STORAGE_KEY]: enabled });
    return enabled;
}

// Add service worker startup listener
chrome.runtime.onStartup.addListener(() => {
    console.log('🔄 Background service worker started');
    syncRsmsSpeedModeRuleset().catch((error) => {
        console.warn('Failed to sync RSMS speed mode on startup:', error);
    });
});

// Add suspend listener to debug service worker termination
chrome.runtime.onSuspend.addListener(() => {
    console.log('💤 Background service worker suspending');
});

function getDeclaredContentScriptFiles() {
    const manifest = chrome.runtime.getManifest();
    const files = manifest.content_scripts
        ?.flatMap((entry) => Array.isArray(entry.js) ? entry.js : [])
        .filter((file, index, allFiles) => typeof file === 'string' && file.length > 0 && allFiles.indexOf(file) === index) ?? [];

    return files;
}

function injectDeclaredContentScripts(tabId) {
    const files = getDeclaredContentScriptFiles();
    if (files.length === 0) {
        return Promise.reject(new Error('No manifest-declared content scripts found for injection.'));
    }

    // Resolve script paths from the manifest so CRX/Vite hashed output stays valid after build.
    return chrome.scripting.executeScript({
        target: { tabId },
        files
    });
}

chrome.runtime.onInstalled.addListener((details) => {
    console.log('Question Paper Helper extension installed');
    syncRsmsSpeedModeRuleset().catch((error) => {
        console.warn('Failed to sync RSMS speed mode on install:', error);
    });
    
    if (details.reason === 'install') {
        // Show welcome message or open options page
        console.log('Extension installed for the first time');
    }
    
    // Create context menu item only on install/enable
    chrome.contextMenus.create({
        id: "upload-papers",
        title: "Upload Question Papers",
        contexts: ["page"],
        documentUrlPatterns: ["*://chatgpt.com/*", "*://chat.openai.com/*", "*://claude.ai/*"]
    });
});

// Listen for tab updates to check if user navigates to supported LLM platforms
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        const isSupportedPlatform = tab.url.includes('chatgpt.com') || 
                                    tab.url.includes('chat.openai.com') ||
                                    tab.url.includes('claude.ai');
        
        if (isSupportedPlatform) {
            // Inject content script if not already injected
            injectDeclaredContentScripts(tabId).catch((error) => {
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

    if (message.action === 'getRsmsSpeedMode') {
        syncRsmsSpeedModeRuleset()
            .then((enabled) => sendResponse({ success: true, enabled }))
            .catch((error) => sendResponse({ success: false, enabled: true, error: error.message }));
        return true;
    }

    if (message.action === 'getRsmsOptions') {
        Promise.all([syncRsmsSpeedModeRuleset(), getRsmsAttendanceUiEnabled()])
            .then(([speedModeEnabled, attendanceUiEnabled]) => sendResponse({
                success: true,
                speedModeEnabled,
                attendanceUiEnabled
            }))
            .catch((error) => sendResponse({
                success: false,
                speedModeEnabled: true,
                attendanceUiEnabled: true,
                error: error.message
            }));
        return true;
    }

    if (message.action === 'setRsmsSpeedMode') {
        const enabled = message.enabled !== false;
        setRsmsSpeedMode(enabled)
            .then((nextEnabled) => sendResponse({ success: true, enabled: nextEnabled }))
            .catch((error) => sendResponse({ success: false, enabled, error: error.message }));
        return true;
    }

    if (message.action === 'setRsmsAttendanceUi') {
        const enabled = message.enabled !== false;
        setRsmsAttendanceUi(enabled)
            .then((nextEnabled) => sendResponse({ success: true, enabled: nextEnabled }))
            .catch((error) => sendResponse({ success: false, enabled, error: error.message }));
        return true;
    }
    
    if (message.action === 'downloadPDF') {
        const mode = message.mode === 'save' ? 'save' : 'buffer';
        const filename = typeof message.filename === 'string' ? message.filename : null;

        downloadPDF({ url: message.url, mode, filename })
            .then((result) => {
                sendResponse(result);
            })
            .catch(error => {
                console.error('Background PDF download error:', error);
                sendResponse({
                    success: false,
                    code: 'UNEXPECTED_ERROR',
                    error: error?.message || 'Unexpected download error'
                });
            });
        return true;
    }
    
    if (message.action === 'injectContentScript') {
        // Handle content script injection from background
        console.log('Background injecting content script for tab:', message.tabId);
        injectDeclaredContentScripts(message.tabId)
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

async function downloadPDF({ url, mode, filename }) {
    console.log('Background script attempting to download:', { url, mode, filename });

    if (!url || !url.startsWith('http')) {
        return {
            success: false,
            code: 'INVALID_URL',
            error: `Invalid URL: ${url}`
        };
    }

    if (mode === 'save') {
        return await startNativeDownload(url, filename);
    }

    try {
        const blob = await fetchPdfBlob(url);
        const base64Data = await blobToBase64(blob);
        return { success: true, source: 'fetch', base64Data };
    } catch (error) {
        console.error('Error downloading PDF via fetch:', error);
        console.error('Failed URL:', url);

        const fetchFailure = normalizeFetchError(error, url);
        if (!fetchFailure.tryNativeFallback) {
            return fetchFailure;
        }

        if (canUseXhrFallback()) {
            // Some non-worker environments fail `fetch()` but allow XHR.
            try {
                console.log('🔁 Trying XHR fallback for PDF download...');
                const xhrBlob = await fetchPdfBlobViaXhr(url);
                const base64Data = await blobToBase64(xhrBlob);
                return { success: true, source: 'xhr', base64Data };
            } catch (xhrError) {
                console.warn('XHR fallback failed:', xhrError);
            }
        } else {
            console.log('XHR fallback unavailable in extension service worker; skipping.');
        }

        const nativeResult = await downloadWithNativeManager(url, filename);
        if (nativeResult.success) {
            return {
                success: false,
                code: 'NATIVE_DOWNLOAD_ONLY',
                error: 'Downloaded using Chrome download manager. Browser blocked in-memory fetch; attach the file manually from Downloads.',
                nativeDownload: nativeResult.nativeDownload
            };
        }

        if (nativeResult.code === 'CERT_ERROR') {
            return {
                success: false,
                code: 'CERT_ERROR',
                error: 'Certificate validation failed for this PDF URL. Extension fetch cannot bypass SSL warnings.',
                details: nativeResult.details
            };
        }

        return {
            success: false,
            code: fetchFailure.code,
            error: fetchFailure.error,
            details: {
                fetch: fetchFailure.details,
                native: nativeResult.details
            }
        };
    }
}

function canUseXhrFallback() {
    return typeof XMLHttpRequest === 'function';
}

async function fetchPdfBlob(url) {
    const response = await fetch(url, {
        method: 'GET',
        referrer: 'https://student.rajagiritech.ac.in/',
        headers: {
            'Accept': 'application/pdf,*/*'
        }
    });

    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        if (response.status === 404) {
            message = `PDF file not found at URL: ${url}`;
        } else if (response.status === 403) {
            message = `Access denied to PDF: ${url}. Authentication may be required.`;
        } else {
            message = `HTTP error ${response.status}: ${response.statusText}`;
        }

        const error = new Error(message);
        error.code = 'HTTP_ERROR';
        throw error;
    }

    const blob = await response.blob();
    if (blob.size === 0) {
        throw new Error(`Downloaded PDF is empty (0 bytes) from: ${url}`);
    }

    if (blob.type && !blob.type.includes('pdf')) {
        console.warn(`Downloaded file is not a PDF, got: ${blob.type}`);
    }

    return blob;
}

function fetchPdfBlobViaXhr(url) {
    return new Promise((resolve, reject) => {
        try {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'blob';
            xhr.withCredentials = true;
            xhr.setRequestHeader('Accept', 'application/pdf,*/*');

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
                    resolve(xhr.response);
                    return;
                }
                reject(new Error(`HTTP ${xhr.status || 0} while downloading PDF via XHR`));
            };

            xhr.onerror = () => reject(new Error('Network error while downloading PDF via XHR'));
            xhr.ontimeout = () => reject(new Error('Timeout while downloading PDF via XHR'));
            xhr.timeout = 30000;

            xhr.send();
        } catch (error) {
            reject(error);
        }
    });
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = typeof reader.result === 'string' ? reader.result : '';
            const base64Data = result.includes(',') ? result.split(',')[1] : '';
            if (!base64Data) {
                reject(new Error('Failed to convert PDF to base64'));
                return;
            }
            resolve(base64Data);
        };
        reader.onerror = () => reject(new Error('Failed to read PDF data'));
        reader.readAsDataURL(blob);
    });
}

function normalizeFetchError(error, url) {
    const message = error?.message || 'Failed to fetch PDF';
    const code = error?.code || '';

    if (code === 'HTTP_ERROR' || message.startsWith('HTTP ')) {
        return {
            success: false,
            code: 'HTTP_ERROR',
            error: message,
            details: { url },
            tryNativeFallback: false
        };
    }

    if (message.includes('Invalid URL')) {
        return {
            success: false,
            code: 'INVALID_URL',
            error: message,
            details: { url },
            tryNativeFallback: false
        };
    }

    const likelyNetworkOrTls =
        message.includes('Failed to fetch') ||
        message.includes('NetworkError') ||
        message.includes('ERR_');

    return {
        success: false,
        code: likelyNetworkOrTls ? 'NETWORK_OR_TLS_ERROR' : 'FETCH_ERROR',
        error: likelyNetworkOrTls
            ? 'Network or TLS handshake failed while fetching the PDF.'
            : message,
        details: { url, rawMessage: message },
        tryNativeFallback: likelyNetworkOrTls
    };
}

async function downloadWithNativeManager(url, preferredFilename) {
    const safeName = sanitizeFilename(preferredFilename) || `paper_${Date.now()}.pdf`;
    const fullFilename = `SkipREXA/${safeName}`;

    try {
        const downloadId = await new Promise((resolve, reject) => {
            chrome.downloads.download(
                {
                    url,
                    filename: fullFilename,
                    saveAs: false,
                    conflictAction: 'uniquify'
                },
                (id) => {
                    if (chrome.runtime.lastError || typeof id !== 'number') {
                        reject(new Error(chrome.runtime.lastError?.message || 'Native download failed to start'));
                        return;
                    }
                    resolve(id);
                }
            );
        });

        return await waitForDownloadOutcome(downloadId, url);
    } catch (error) {
        const message = error?.message || 'Native download request failed';
        const certError = message.includes('CERT');
        return {
            success: false,
            code: certError ? 'CERT_ERROR' : 'NATIVE_DOWNLOAD_START_FAILED',
            error: certError ? 'Chrome blocked the download because of a certificate problem.' : message,
            details: { url, rawMessage: message }
        };
    }
}

async function startNativeDownload(url, preferredFilename) {
    const safeName = sanitizeFilename(preferredFilename) || `paper_${Date.now()}.pdf`;
    const fullFilename = `SkipREXA/${safeName}`;

    try {
        const downloadId = await new Promise((resolve, reject) => {
            chrome.downloads.download(
                {
                    url,
                    filename: fullFilename,
                    conflictAction: 'uniquify',
                    saveAs: false
                },
                (id) => {
                    if (chrome.runtime.lastError || typeof id !== 'number') {
                        reject(new Error(chrome.runtime.lastError?.message || 'Native download failed to start'));
                        return;
                    }
                    resolve(id);
                }
            );
        });

        return {
            success: true,
            source: 'native',
            isNativeDownload: true,
            downloadId
        };
    } catch (error) {
        const message = error?.message || 'Native download request failed';
        const certError = message.includes('CERT');
        return {
            success: false,
            code: certError ? 'CERT_ERROR' : 'NATIVE_DOWNLOAD_START_FAILED',
            error: certError ? 'Chrome blocked the download because of a certificate problem.' : message,
            details: { url, rawMessage: message }
        };
    }
}

function waitForDownloadOutcome(downloadId, sourceUrl) {
    return new Promise((resolve) => {
        const timeout = setTimeout(async () => {
            cleanup();
            const current = await getDownloadItem(downloadId);
            if (current?.state === 'complete') {
                resolve({
                    success: true,
                    source: 'native',
                    nativeDownload: {
                        downloadId,
                        filename: current.filename,
                        finalUrl: current.finalUrl || sourceUrl
                    }
                });
                return;
            }

            resolve({
                success: false,
                code: 'NATIVE_DOWNLOAD_TIMEOUT',
                error: 'Native download timed out before completion.',
                details: { downloadId, state: current?.state || 'unknown' }
            });
        }, 60000);

        const listener = async (delta) => {
            if (delta.id !== downloadId) {
                return;
            }

            if (delta.state?.current === 'complete') {
                cleanup();
                const item = await getDownloadItem(downloadId);
                resolve({
                    success: true,
                    source: 'native',
                    nativeDownload: {
                        downloadId,
                        filename: item?.filename || null,
                        finalUrl: item?.finalUrl || sourceUrl
                    }
                });
                return;
            }

            if (delta.state?.current === 'interrupted') {
                cleanup();
                const reason = delta.error?.current || 'UNKNOWN';
                const mapped = mapInterruptReason(reason);
                resolve({
                    success: false,
                    code: mapped.code,
                    error: mapped.error,
                    details: { downloadId, interruptReason: reason }
                });
            }
        };

        function cleanup() {
            clearTimeout(timeout);
            chrome.downloads.onChanged.removeListener(listener);
        }

        chrome.downloads.onChanged.addListener(listener);
    });
}

function getDownloadItem(downloadId) {
    return new Promise((resolve) => {
        chrome.downloads.search({ id: downloadId }, (items) => {
            resolve(items?.[0] || null);
        });
    });
}

function mapInterruptReason(reason) {
    if (!reason) {
        return {
            code: 'DOWNLOAD_INTERRUPTED',
            error: 'Download was interrupted.'
        };
    }

    if (reason.includes('CERT')) {
        return {
            code: 'CERT_ERROR',
            error: 'Chrome blocked the download because of a certificate problem.'
        };
    }

    if (
        reason.includes('NETWORK') ||
        reason.includes('CONNECTION') ||
        reason.includes('HOST') ||
        reason.includes('SERVER')
    ) {
        return {
            code: 'NETWORK_ERROR',
            error: 'Network error while downloading the PDF.'
        };
    }

    return {
        code: 'DOWNLOAD_INTERRUPTED',
        error: `Download interrupted: ${reason}`
    };
}

function sanitizeFilename(filename) {
    if (!filename || typeof filename !== 'string') {
        return null;
    }

    const trimmed = filename.trim();
    if (!trimmed) {
        return null;
    }

    const sanitized = trimmed
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, '_');

    return sanitized.toLowerCase().endsWith('.pdf') ? sanitized : `${sanitized}.pdf`;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "upload-papers") {
        // Open extension popup or trigger upload
        chrome.action.openPopup();
    }
});
