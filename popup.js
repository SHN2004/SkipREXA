// Configuration
const SUPABASE_URL = 'https://avmoixumqzdydqrzquon.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF2bW9peHVtcXpkeWRxcnpxdW9uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ1ODE2MjYsImV4cCI6MjA3MDE1NzYyNn0.nwJgP7j9s78OGdJpj8Gmle_hHX8Hdk7Ro0hNOEmFFVk';

// Initialize Supabase client
function createSupabaseClient() {
    return {
        from: (table) => ({
            select: (columns = '*') => {
                const query = {
                    table,
                    columns,
                    filters: []
                };
                
                return {
                    eq: (column, value) => {
                        query.filters.push(`${column}=eq.${value}`);
                        return {
                            eq: (column2, value2) => {
                                query.filters.push(`${column2}=eq.${value2}`);
                                return {
                                    async data() {
                                        let url = `${SUPABASE_URL}/rest/v1/${query.table}?select=${query.columns}`;
                                        if (query.filters.length > 0) {
                                            url += '&' + query.filters.join('&');
                                        }
                                        
                                        const response = await fetch(url, {
                                            headers: {
                                                'apikey': SUPABASE_ANON_KEY,
                                                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                                                'Content-Type': 'application/json'
                                            }
                                        });
                                        const data = await response.json();
                                        return data;
                                    }
                                };
                            },
                            async data() {
                                let url = `${SUPABASE_URL}/rest/v1/${query.table}?select=${query.columns}`;
                                if (query.filters.length > 0) {
                                    url += '&' + query.filters.join('&');
                                }
                                
                                const response = await fetch(url, {
                                    headers: {
                                        'apikey': SUPABASE_ANON_KEY,
                                        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                                        'Content-Type': 'application/json'
                                    }
                                });
                                const data = await response.json();
                                return data;
                            }
                        };
                    },
                    async data() {
                        let url = `${SUPABASE_URL}/rest/v1/${query.table}?select=${query.columns}`;
                        if (query.filters.length > 0) {
                            url += '&' + query.filters.join('&');
                        }
                        
                        const response = await fetch(url, {
                            headers: {
                                'apikey': SUPABASE_ANON_KEY,
                                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                                'Content-Type': 'application/json'
                            }
                        });
                        const data = await response.json();
                        return data;
                    }
                };
            }
        })
    };
}

const supabase = createSupabaseClient();

// DOM elements
const courseSearchInput = document.getElementById('courseSearch');
const courseDropdown = document.getElementById('courseDropdown');
const selectedCourseDiv = document.getElementById('selectedCourse');
const paperCountDiv = document.getElementById('paperCount');
const uploadBtn = document.getElementById('uploadBtn');
const statusDiv = document.getElementById('status');
const form = document.getElementById('paperForm');

// Global variables
let allCourses = [];
let selectedCourse = null;
let highlightedIndex = -1;

// Show status message
function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
    statusDiv.classList.remove('hidden');
    
    if (type === 'success' || type === 'error') {
        setTimeout(() => {
            statusDiv.classList.add('hidden');
        }, 3000);
    }
}

// Load all courses when extension opens
async function loadAllCourses() {
    try {
        showStatus('Loading courses...', 'loading');
        
        const data = await supabase.from('question_papers')
            .select('course_name, actual_subject_code, semester')
            .data();

        // Create unique courses with metadata
        const coursesMap = new Map();
        data.forEach(item => {
            const key = `${item.course_name}_${item.actual_subject_code}`;
            if (!coursesMap.has(key)) {
                coursesMap.set(key, {
                    name: item.course_name,
                    code: item.actual_subject_code,
                    semesters: new Set(),
                    searchText: `${item.course_name} ${item.actual_subject_code}`.toLowerCase()
                });
            }
            coursesMap.get(key).semesters.add(item.semester);
        });

        // Convert to array and sort
        allCourses = Array.from(coursesMap.values())
            .map(course => ({
                ...course,
                semesters: Array.from(course.semesters).sort()
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        console.log(`Loaded ${allCourses.length} unique courses`);
        statusDiv.classList.add('hidden');
        
    } catch (error) {
        console.error('Error loading courses:', error);
        showStatus('Error loading courses', 'error');
    }
}

// Filter and display course suggestions
function showCourseSuggestions(searchTerm) {
    if (!searchTerm.trim()) {
        courseDropdown.classList.add('hidden');
        highlightedIndex = -1;
        return;
    }

    const filtered = allCourses.filter(course => 
        course.searchText.includes(searchTerm.toLowerCase())
    ).slice(0, 8); // Limit to 8 suggestions

    if (filtered.length === 0) {
        courseDropdown.innerHTML = '<div class="dropdown-item">No courses found</div>';
        courseDropdown.classList.remove('hidden');
        return;
    }

    courseDropdown.innerHTML = filtered.map((course, index) => `
        <div class="dropdown-item" data-index="${index}">
            <div class="course-name">${highlightMatch(course.name, searchTerm)}</div>
            <div class="course-details">
                Code: ${course.code} • Semesters: ${course.semesters.join(', ')}
            </div>
        </div>
    `).join('');

    courseDropdown.classList.remove('hidden');
    highlightedIndex = -1;

    // Add click listeners to dropdown items
    courseDropdown.querySelectorAll('.dropdown-item').forEach((item, index) => {
        item.addEventListener('click', () => selectCourse(filtered[index]));
    });
}

// Highlight matching text
function highlightMatch(text, searchTerm) {
    const regex = new RegExp(`(${searchTerm})`, 'gi');
    return text.replace(regex, '<strong>$1</strong>');
}

// Select a course
function selectCourse(course) {
    selectedCourse = course;
    courseSearchInput.value = course.name;
    courseDropdown.classList.add('hidden');
    
    // Show selected course info
    selectedCourseDiv.innerHTML = `
        <div class="course-title">${course.name}</div>
        <div class="course-meta">Code: ${course.code} • Available in: ${course.semesters.join(', ')}</div>
    `;
    selectedCourseDiv.classList.remove('hidden');
    
    updatePaperCount();
}

// Handle keyboard navigation
function handleKeyNavigation(e) {
    const items = courseDropdown.querySelectorAll('.dropdown-item');
    
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlightedIndex = Math.min(highlightedIndex + 1, items.length - 1);
        updateHighlight(items);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlightedIndex = Math.max(highlightedIndex - 1, 0);
        updateHighlight(items);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (highlightedIndex >= 0 && items[highlightedIndex]) {
            const index = parseInt(items[highlightedIndex].dataset.index);
            const filtered = allCourses.filter(course => 
                course.searchText.includes(courseSearchInput.value.toLowerCase())
            );
            if (filtered[index]) {
                selectCourse(filtered[index]);
            }
        }
    } else if (e.key === 'Escape') {
        courseDropdown.classList.add('hidden');
        highlightedIndex = -1;
    }
}

// Update visual highlight
function updateHighlight(items) {
    items.forEach((item, index) => {
        item.classList.toggle('highlighted', index === highlightedIndex);
    });
}

// Get papers for selected course and filters and display them
async function updatePaperDisplay() {
    const paperSelectionGroup = document.getElementById('paperSelectionGroup');
    const paperList = document.getElementById('paperList');
    
    if (!selectedCourse) {
        paperCountDiv.classList.add('hidden');
        paperSelectionGroup.style.display = 'none';
        return;
    }

    try {
        const examTypes = getSelectedExamTypes();
        
        const data = await supabase.from('question_papers')
            .select('*')
            .eq('course_name', selectedCourse.name)
            .eq('actual_subject_code', selectedCourse.code)
            .data();

        const filteredPapers = data.filter(paper => 
            examTypes.includes(paper.exam_type)
        );

        paperCountDiv.textContent = `${filteredPapers.length} papers available`;
        paperCountDiv.classList.remove('hidden');
        
        if (filteredPapers.length > 0) {
            displayPaperList(filteredPapers);
            paperSelectionGroup.style.display = 'block';
        } else {
            paperSelectionGroup.style.display = 'none';
        }
        
    } catch (error) {
        console.error('Error fetching papers:', error);
        paperSelectionGroup.style.display = 'none';
    }
}

// Legacy function name for compatibility
async function updatePaperCount() {
    return updatePaperDisplay();
}

// Display paper list with checkboxes
function displayPaperList(papers) {
    const paperList = document.getElementById('paperList');
    
    paperList.innerHTML = papers.map((paper, index) => `
        <div class="paper-item">
            <input type="checkbox" id="paper-${index}" value="${index}" class="paper-checkbox">
            <div class="paper-info">
                <div class="paper-details">${paper.raw_exam_details || 'No details available'}</div>
                <div class="paper-meta">
                    ${paper.exam_type} • ${paper.exam_month} ${paper.exam_year} • ${paper.semester}
                </div>
            </div>
        </div>
    `).join('');
    
    // Store papers data globally for later access
    window.availablePapers = papers;
    
    // Add event listeners to checkboxes
    const checkboxes = paperList.querySelectorAll('.paper-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.addEventListener('change', updateSelectedCount);
    });
    
    updateSelectedCount();
}

// Update selected count display
function updateSelectedCount() {
    const selectedCheckboxes = document.querySelectorAll('.paper-checkbox:checked');
    const selectedCount = document.getElementById('selectedCount');
    const count = selectedCheckboxes.length;
    
    selectedCount.textContent = `${count} paper${count !== 1 ? 's' : ''} selected`;
}

// Get selected papers
function getSelectedPapers() {
    const selectedCheckboxes = document.querySelectorAll('.paper-checkbox:checked');
    const selectedIndices = Array.from(selectedCheckboxes).map(cb => parseInt(cb.value));
    
    if (!window.availablePapers) {
        return [];
    }
    
    return selectedIndices.map(index => window.availablePapers[index]);
}

// Select all papers
function selectAllPapers() {
    const checkboxes = document.querySelectorAll('.paper-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.checked = true;
    });
    updateSelectedCount();
}

// Deselect all papers
function deselectAllPapers() {
    const checkboxes = document.querySelectorAll('.paper-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.checked = false;
    });
    updateSelectedCount();
}

// Get selected exam types (updated to exclude paper checkboxes)
function getSelectedExamTypes() {
    const checkboxes = document.querySelectorAll('input[type="checkbox"]:checked:not(.paper-checkbox)');
    return Array.from(checkboxes).map(cb => cb.value);
}

// PDF downloads now handled by background script

// Main upload function
async function uploadPapers() {
    try {
        // Check if we're on ChatGPT
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) {
            showStatus('Could not access current tab. Please try again.', 'error');
            return;
        }
        
        if (!tab.url.includes('chatgpt.com') && !tab.url.includes('chat.openai.com')) {
            showStatus('Please open ChatGPT first', 'error');
            return;
        }
        
        console.log('Current tab:', tab.url);

        showStatus('Fetching papers...', 'loading');
        uploadBtn.disabled = true;

        if (!selectedCourse) {
            showStatus('Please select a course first', 'error');
            return;
        }

        const selectedPapers = getSelectedPapers();

        if (selectedPapers.length === 0) {
            showStatus('Please select at least one paper first', 'error');
            return;
        }

        const filteredPapers = selectedPapers;

        if (filteredPapers.length === 0) {
            showStatus('No papers found for the selected criteria', 'error');
            return;
        }

        showStatus(`Downloading ${filteredPapers.length} papers...`, 'loading');

        // Download PDFs using background script
        const pdfData = [];
        let downloadErrors = [];
        
        for (let i = 0; i < filteredPapers.length; i++) {
            const paper = filteredPapers[i];
            try {
                showStatus(`Downloading ${i + 1}/${filteredPapers.length}: ${paper.course_name}`, 'loading');
                
                // Use background script to download PDF
                const response = await chrome.runtime.sendMessage({
                    action: 'downloadPDF',
                    url: paper.download_url
                });
                
                if (response.success) {
                    // Convert the response back to blob
                    const byteCharacters = atob(response.base64Data);
                    const byteNumbers = new Array(byteCharacters.length);
                    for (let j = 0; j < byteCharacters.length; j++) {
                        byteNumbers[j] = byteCharacters.charCodeAt(j);
                    }
                    const byteArray = new Uint8Array(byteNumbers);
                    const blob = new Blob([byteArray], { type: 'application/pdf' });
                    
                    pdfData.push({
                        name: `${paper.course_name}_${paper.exam_type}_${paper.exam_month}_${paper.exam_year}.pdf`,
                        blob: blob,
                        info: paper
                    });
                    
                    console.log(`✅ Successfully downloaded: ${paper.course_name}`);
                } else {
                    throw new Error(response.error);
                }
            } catch (error) {
                console.error(`❌ Error downloading ${paper.course_name}:`, error);
                downloadErrors.push({
                    paper: paper.course_name,
                    error: error.message,
                    url: paper.download_url
                });
                
                // Continue with next paper instead of failing completely
                continue;
            }
        }
        
        // Show download summary
        console.log(`📊 Download Summary: ${pdfData.length}/${filteredPapers.length} successful`);
        if (downloadErrors.length > 0) {
            console.warn(`⚠️ Failed downloads:`, downloadErrors);
        }

        if (pdfData.length === 0) {
            if (downloadErrors.length > 0) {
                showStatus(`All ${filteredPapers.length} papers failed to download. Check console for details.`, 'error');
            } else {
                showStatus('No papers found to download', 'error');
            }
            return;
        }
        
        // Show partial success message if some failed
        if (downloadErrors.length > 0) {
            showStatus(`Downloaded ${pdfData.length}/${filteredPapers.length} papers (${downloadErrors.length} failed)`, 'loading');
        }

        showStatus('Uploading to ChatGPT...', 'loading');

        // Enhanced content script injection with retries
        let contentScriptReady = false;
        let injectionAttempts = 0;
        const maxInjectionAttempts = 3;
        
        while (!contentScriptReady && injectionAttempts < maxInjectionAttempts) {
            injectionAttempts++;
            console.log(`Attempt ${injectionAttempts}: Injecting content script...`);
            
            try {
                // Inject content script
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['content.js']
                });
                
                // Wait longer for initialization
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Test if content script is responding
                try {
                    const testResponse = await chrome.tabs.sendMessage(tab.id, { 
                        action: 'ping' 
                    });
                    contentScriptReady = true;
                    console.log('✅ Content script is responding');
                } catch (testError) {
                    console.log(`❌ Content script test failed on attempt ${injectionAttempts}`);
                    if (injectionAttempts < maxInjectionAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
                
            } catch (injectionError) {
                console.log(`Injection attempt ${injectionAttempts} failed:`, injectionError.message);
                if (injectionAttempts < maxInjectionAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }
        
        if (!contentScriptReady) {
            console.log('❌ All injection attempts failed, trying background injection...');
            
            // Last resort: ask background script to inject
            try {
                await chrome.runtime.sendMessage({
                    action: 'injectContentScript',
                    tabId: tab.id
                });
                
                await new Promise(resolve => setTimeout(resolve, 1500));
                
                // Test one more time
                const finalTestResponse = await chrome.tabs.sendMessage(tab.id, { 
                    action: 'ping' 
                });
                
                contentScriptReady = true;
                console.log('✅ Background injection successful');
                
            } catch (finalError) {
                console.error('❌ Background injection also failed:', finalError);
                throw new Error('Could not establish connection with ChatGPT page. Please refresh the ChatGPT page and try again.');
            }
        }

        // Send to content script for upload
        const pdfsWithBase64 = await Promise.all(
            pdfData.map(async pdf => ({
                name: pdf.name,
                info: pdf.info,
                // Convert blob to base64 for message passing
                data: await blobToBase64(pdf.blob)
            }))
        );

        console.log(`📤 Sending ${pdfsWithBase64.length} PDFs to content script...`);
        
        try {
            await chrome.tabs.sendMessage(tab.id, {
                action: 'uploadPDFs',
                pdfs: pdfsWithBase64
            });
        } catch (error) {
            console.error('Message sending failed:', error);
            throw new Error(`Upload communication failed: ${error.message}. Please refresh ChatGPT and try again.`);
        }

        if (downloadErrors.length > 0) {
            showStatus(`Successfully uploaded ${pdfData.length} papers! (${downloadErrors.length} downloads failed)`, 'success');
        } else {
            showStatus(`Successfully uploaded ${pdfData.length} papers!`, 'success');
        }
        
    } catch (error) {
        console.error('Upload error:', error);
        showStatus('Upload failed. Please try again.', 'error');
    } finally {
        uploadBtn.disabled = false;
    }
}

// Convert blob to base64
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// Event listeners
courseSearchInput.addEventListener('input', (e) => {
    const searchTerm = e.target.value;
    if (searchTerm !== selectedCourse?.name) {
        selectedCourse = null;
        selectedCourseDiv.classList.add('hidden');
        paperCountDiv.classList.add('hidden');
    }
    showCourseSuggestions(searchTerm);
});

courseSearchInput.addEventListener('keydown', handleKeyNavigation);

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    if (!courseSearchInput.contains(e.target) && !courseDropdown.contains(e.target)) {
        courseDropdown.classList.add('hidden');
        highlightedIndex = -1;
    }
});

// Add event listeners for checkboxes
document.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', updatePaperCount);
});

// Add event listeners for Select All/Deselect All buttons
document.getElementById('selectAllBtn').addEventListener('click', selectAllPapers);
document.getElementById('deselectAllBtn').addEventListener('click', deselectAllPapers);


form.addEventListener('submit', (e) => {
    e.preventDefault();
    
    if (!selectedCourse) {
        showStatus('Please select a course first', 'error');
        return;
    }
    
    const examTypes = getSelectedExamTypes();
    if (examTypes.length === 0) {
        showStatus('Please select at least one exam type', 'error');
        return;
    }
    
    const selectedPapers = getSelectedPapers();
    if (selectedPapers.length === 0) {
        showStatus('Please select at least one paper to upload', 'error');
        return;
    }
    
    uploadPapers();
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Check if we're on ChatGPT
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const currentTab = tabs[0];
        if (!currentTab.url.includes('chatgpt.com') && !currentTab.url.includes('chat.openai.com')) {
            showStatus('Please navigate to ChatGPT to use this extension', 'error');
            uploadBtn.disabled = true;
        } else {
            // Load courses immediately when on ChatGPT
            loadAllCourses();
        }
    });
});