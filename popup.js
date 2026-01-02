console.log("🚀 Popup.js script loading...")

// DOM elements with error checking
console.log("🔍 Looking for DOM elements...")

function getElementSafely(id) {
  const element = document.getElementById(id)
  if (!element) {
    console.error(`❌ Element with ID '${id}' not found!`)
    return null
  }
  console.log(`✅ Found element: ${id}`)
  return element
}

const courseSearchInput = getElementSafely("courseSearch")
const courseDropdown = getElementSafely("courseDropdown") 
const selectedCoursesContainer = getElementSafely("selectedCoursesContainer")
const fetchPapersBtn = getElementSafely("fetchPapersBtn")
const paperCountDiv = getElementSafely("paperCount")
const uploadBtn = getElementSafely("uploadBtn")
const downloadBtn = getElementSafely("downloadBtn")
const statusDiv = getElementSafely("status")
const form = getElementSafely("paperForm")

// Progress bar elements
const progressContainer = getElementSafely("progressContainer")
const progressText = getElementSafely("progressText")
const progressCount = getElementSafely("progressCount")
const progressFill = getElementSafely("progressFill")
const progressDetails = getElementSafely("progressDetails")

// Theme toggle elements
const themeToggle = getElementSafely("themeToggle")
const sunIcon = themeToggle?.querySelector('.sun-icon')
const moonIcon = themeToggle?.querySelector('.moon-icon')

console.log("📋 DOM elements check complete")

// Global variables
let allCourses = []
let selectedCourses = new Set() // Set to store selected course objects
let highlightedIndex = -1

// Show status message
function showStatus(message, type) {
  console.log(`📢 Status: ${type.toUpperCase()} - ${message}`)
  
  if (!statusDiv) {
    console.error("❌ Cannot show status - statusDiv not found!")
    return
  }
  
  try {
    statusDiv.textContent = message
    statusDiv.className = `status ${type}`
    statusDiv.classList.remove("hidden")
    console.log("✅ Status message displayed successfully")

    if (type === "success" || type === "error") {
      setTimeout(() => {
        if (statusDiv) {
          statusDiv.classList.add("hidden")
        }
      }, 3000)
    }
  } catch (error) {
    console.error("❌ Error showing status:", error)
  }
}

// Progress bar functions
function showProgress(current, total, currentItem = "") {
  if (!progressContainer) return
  
  console.log(`📊 Progress: ${current}/${total} - ${currentItem}`)
  
  try {
    progressContainer.classList.remove("hidden")
    statusDiv.classList.add("hidden") // Hide status when showing progress
    
    if (progressText && currentItem) {
      progressText.textContent = currentItem
    }
    
    if (progressCount) {
      progressCount.textContent = `${current}/${total}`
    }
    
    if (progressFill) {
      const percentage = total > 0 ? (current / total) * 100 : 0
      progressFill.style.width = `${percentage}%`
    }
    
    if (progressDetails) {
      const percentage = total > 0 ? Math.round((current / total) * 100) : 0
      progressDetails.textContent = `${percentage}% complete`
    }
    
  } catch (error) {
    console.error("❌ Error updating progress:", error)
  }
}

function hideProgress() {
  if (progressContainer) {
    progressContainer.classList.add("hidden")
    console.log("📊 Progress bar hidden")
  }
}

function updateProgressDetails(details) {
  if (progressDetails && details) {
    progressDetails.textContent = details
  }
}

// Theme management functions
async function loadThemePreference() {
  try {
    const result = await chrome.storage.local.get(['theme'])
    const savedTheme = result.theme || 'light'
    console.log(`🎨 Loaded theme preference: ${savedTheme}`)
    applyTheme(savedTheme)
    return savedTheme
  } catch (error) {
    console.error('❌ Error loading theme preference:', error)
    applyTheme('light')
    return 'light'
  }
}

async function saveThemePreference(theme) {
  try {
    await chrome.storage.local.set({ theme })
    console.log(`💾 Saved theme preference: ${theme}`)
  } catch (error) {
    console.error('❌ Error saving theme preference:', error)
  }
}

function applyTheme(theme) {
  const body = document.body

  if (theme === 'dark') {
    body.classList.add('dark-theme')
    if (sunIcon) sunIcon.classList.remove('active')
    if (moonIcon) moonIcon.classList.add('active')
    console.log('🌙 Applied dark theme')
  } else {
    body.classList.remove('dark-theme')
    if (sunIcon) sunIcon.classList.add('active')
    if (moonIcon) moonIcon.classList.remove('active')
    console.log('☀️ Applied light theme')
  }
}

function toggleTheme() {
  const body = document.body
  const isDark = body.classList.contains('dark-theme')
  const newTheme = isDark ? 'light' : 'dark'
  
  applyTheme(newTheme)
  saveThemePreference(newTheme)
  
  console.log(`🔄 Toggled theme to: ${newTheme}`)
}

// Background script health check functions
async function checkBackgroundScriptHealth() {
  console.log("🔍 Checking background script health...")
  
  try {
    const response = await new Promise((resolve, reject) => {
      // Send a test message to background script
      chrome.runtime.sendMessage({ action: 'healthCheck' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
        } else {
          resolve(response || { success: false, error: 'No response' })
        }
      })
      
      // Set timeout for health check
      setTimeout(() => {
        reject(new Error('Health check timeout'))
      }, 5000)
    })
    
    console.log("✅ Background script health check passed")
    return true
    
  } catch (error) {
    console.error("❌ Background script health check failed:", error)
    return false
  }
}

async function ensureBackgroundScriptReady() {
  console.log("🔄 Ensuring background script is ready...")
  
  const isHealthy = await checkBackgroundScriptHealth()
  
  if (!isHealthy) {
    console.log("⚠️ Background script not responding, attempting to wake it up...")
    
    // Try to wake up the service worker by calling chrome.runtime methods
    try {
      await chrome.runtime.getBackgroundPage?.() 
    } catch (e) {
      console.log("getBackgroundPage not available (expected for MV3)")
    }
    
    // Wait a bit and try health check again
    await new Promise(resolve => setTimeout(resolve, 2000))
    
    const retryHealthy = await checkBackgroundScriptHealth()
    if (!retryHealthy) {
      throw new Error("Background script is not responding. Please reload the extension and try again.")
    }
  }
  
  console.log("✅ Background script is ready")
  return true
}

// Note: Using direct chrome.runtime.sendMessage() like the original working version

// Load all courses when extension opens
async function loadAllCourses() {
  try {
    console.log("🔄 Starting to load courses...")
    showStatus("Loading courses...", "loading")

    // 1. Check Cache First
    const CACHE_KEY_COURSES = 'cached_courses';
    const CACHE_KEY_TIMESTAMP = 'courses_last_fetch';
    const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

    const cache = await new Promise(resolve => {
        chrome.storage.local.get([CACHE_KEY_COURSES, CACHE_KEY_TIMESTAMP], resolve);
    });

    const now = Date.now();
    const lastFetch = cache[CACHE_KEY_TIMESTAMP] || 0;
    
    if (cache[CACHE_KEY_COURSES] && (now - lastFetch < CACHE_DURATION)) {
        console.log("✅ Using cached courses data");
        allCourses = cache[CACHE_KEY_COURSES];
        
        // Sort again just to be sure
        allCourses.sort((a, b) => a.name.localeCompare(b.name));
        
        console.log(`Loaded ${allCourses.length} courses from cache`);
        statusDiv.classList.add("hidden");
        return;
    }

    // 2. If No Cache or Expired, Fetch from Network
    console.log("🌐 Cache expired or missing, fetching from Supabase...");

    // Check if credentials are loaded
    const supabaseUrl = window.getSupabaseUrl();
    const supabaseKey = window.getSupabaseKey();
    const supabase = window.getSupabase();

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Supabase credentials not loaded")
    }

    if (!supabase) {
      throw new Error("Supabase client not initialized")
    }

    // Now get ALL data using pagination via the helper in supabase-client.js
    console.log("📥 Fetching ALL course data with pagination...")
    const data = await window.fetchAllRecords("question_papers", "course_name, actual_subject_code, semester", 1000, (count) => {
        showStatus(`Loading courses... (${count} fetched)`, "loading");
    });
    
    console.log("📊 All data from Supabase:", data?.length, "records")

    if (!data || data.length === 0) {
      console.error("❌ No data received from Supabase")
      showStatus("No courses found in database", "error")
      return
    }

    // Create unique courses with metadata
    const coursesMap = new Map()
    data.forEach((item) => {
      const key = `${item.course_name}_${item.actual_subject_code}`
      if (!coursesMap.has(key)) {
        coursesMap.set(key, {
          name: item.course_name,
          code: item.actual_subject_code,
          semesters: new Set(),
          searchText: `${item.course_name} ${item.actual_subject_code}`.toLowerCase(),
        })
      }
      coursesMap.get(key).semesters.add(item.semester)
    })

    // Convert to array and sort
    allCourses = Array.from(coursesMap.values())
      .map((course) => ({
        ...course,
        semesters: Array.from(course.semesters).sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    // 3. Save to Cache
    try {
        await chrome.storage.local.set({
            [CACHE_KEY_COURSES]: allCourses,
            [CACHE_KEY_TIMESTAMP]: now
        });
        console.log("💾 Courses cached successfully");
    } catch (cacheError) {
        console.warn("⚠️ Failed to cache courses:", cacheError);
    }

    console.log(`Loaded ${allCourses.length} unique courses:`, allCourses.slice(0, 3))
    statusDiv.classList.add("hidden")
    
    // Test search functionality after loading
    console.log("Courses loaded successfully, ready for search")
  } catch (error) {
    console.error("❌ Critical error loading courses:", error)
    console.error("❌ Error stack:", error.stack)
    
    let errorMessage = "Failed to load courses"
    if (error.message.includes("fetch")) {
      errorMessage = "Network error - check internet connection"
    } else if (error.message.includes("HTTP")) {
      errorMessage = `Server error: ${error.message}`
    } else if (error.name === "TypeError") {
      errorMessage = "Extension configuration error"
    }
    
    showStatus(`Error: ${errorMessage}`, "error")
  }
}

// Filter and display course suggestions
function showCourseSuggestions(searchTerm) {
  console.log("Searching for:", searchTerm, "Total courses available:", allCourses.length)
  
  // Always show dropdown if there is text, or if explicit request? 
  // Current logic: if (!searchTerm.trim()) hide.
  // We might want to show all if clicked? But let's stick to filtering for now.
  if (!searchTerm.trim()) {
    courseDropdown.classList.add("hidden")
    highlightedIndex = -1
    return
  }

  const filtered = allCourses.filter((course) => course.searchText.includes(searchTerm.toLowerCase())).slice(0, 8) // Limit to 8 suggestions
  console.log("Filtered courses:", filtered.length)

  if (filtered.length === 0) {
    courseDropdown.innerHTML = '<div class="dropdown-item">No courses found</div>'
    courseDropdown.classList.remove("hidden")
    return
  }

  courseDropdown.innerHTML = filtered
    .map(
      (course, index) => {
        const isSelected = selectedCourses.has(course)
        return `
        <div class="dropdown-item" data-index="${index}">
            <input type="checkbox" class="course-checkbox" ${isSelected ? 'checked' : ''}>
            <div class="dropdown-item-content">
                <div class="course-name">${highlightMatch(course.name, searchTerm)}</div>
                <div class="course-details">
                    Code: ${course.code} • Semesters: ${course.semesters.join(", ")}
                </div>
            </div>
        </div>
    `},
    )
    .join("")

  courseDropdown.classList.remove("hidden")
  highlightedIndex = -1

  // Add click listeners to dropdown items
  courseDropdown.querySelectorAll(".dropdown-item").forEach((item, index) => {
    item.addEventListener("click", (e) => {
      e.preventDefault() 
      e.stopPropagation() // Prevent document click listener from closing dropdown
      toggleCourseSelection(filtered[index])
      
      // Keep input focus so user can continue typing/selecting
      courseSearchInput.focus()
    })
  })
}

// Highlight matching text
function highlightMatch(text, searchTerm) {
  const regex = new RegExp(`(${searchTerm})`, "gi")
  return text.replace(regex, "<strong>$1</strong>")
}

// Toggle course selection
function toggleCourseSelection(course) {
  console.log("Toggling course:", course.name)
  
  if (selectedCourses.has(course)) {
    selectedCourses.delete(course)
  } else {
    selectedCourses.add(course)
  }

  updateSelectedCoursesDisplay()
  saveState() // Save selection state
  
  // Re-render dropdown to update checkbox states if it's open and has search term
  const searchTerm = courseSearchInput.value
  if (searchTerm.trim()) {
    showCourseSuggestions(searchTerm)
  }
}

// Update selected courses chips display
function updateSelectedCoursesDisplay() {
  if (selectedCourses.size === 0) {
    selectedCoursesContainer.innerHTML = ''
    selectedCoursesContainer.classList.add('hidden')
    return
  }

  const sortedCourses = Array.from(selectedCourses).sort((a, b) => a.name.localeCompare(b.name))

  selectedCoursesContainer.innerHTML = sortedCourses.map(course => `
    <div class="course-chip">
      <span>${course.name}</span>
      <span class="chip-remove" data-code="${course.code}">×</span>
    </div>
  `).join('')
  
  selectedCoursesContainer.classList.remove('hidden')

  // Add listeners to remove buttons
  selectedCoursesContainer.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const code = e.target.dataset.code
      // Find course by code (assuming code is unique enough or we iterate)
      const courseToRemove = Array.from(selectedCourses).find(c => c.code === code)
      if (courseToRemove) {
        toggleCourseSelection(courseToRemove)
      }
    })
  })
  
  // Hide paper display if selection changes? 
  // User might want to fetch again.
  // Let's hide papers to force re-fetch to ensure consistency
  document.getElementById("paperSelectionGroup").style.display = "none"
  paperCountDiv.classList.add("hidden")
}

// Handle keyboard navigation
function handleKeyNavigation(e) {
  const items = courseDropdown.querySelectorAll(".dropdown-item")

  if (e.key === "ArrowDown") {
    e.preventDefault()
    highlightedIndex = Math.min(highlightedIndex + 1, items.length - 1)
    updateHighlight(items)
  } else if (e.key === "ArrowUp") {
    e.preventDefault()
    highlightedIndex = Math.max(highlightedIndex - 1, 0)
    updateHighlight(items)
  } else if (e.key === "Enter") {
    e.preventDefault()
    if (highlightedIndex >= 0 && items[highlightedIndex]) {
      const index = Number.parseInt(items[highlightedIndex].dataset.index)
      const filtered = allCourses.filter((course) => course.searchText.includes(courseSearchInput.value.toLowerCase()))
      if (filtered[index]) {
        toggleCourseSelection(filtered[index])
      }
    }
  } else if (e.key === "Escape") {
    courseDropdown.classList.add("hidden")
    highlightedIndex = -1
  }
}

// Update visual highlight
function updateHighlight(items) {
  items.forEach((item, index) => {
    item.classList.toggle("highlighted", index === highlightedIndex)
  })
}

// Get papers for selected course and filters and display them
async function updatePaperDisplay() {
  const paperSelectionGroup = document.getElementById("paperSelectionGroup")
  const paperList = document.getElementById("paperList")

  if (selectedCourses.size === 0) {
    console.log("No courses selected, hiding paper display")
    paperCountDiv.classList.add("hidden")
    paperSelectionGroup.style.display = "none"
    showStatus("Please select at least one course", "error")
    return
  }

  // Check if credentials and supabase client are available
  const supabase = window.getSupabase();
  const SUPABASE_URL = window.getSupabaseUrl();
  const SUPABASE_ANON_KEY = window.getSupabaseKey();

  if (!supabase || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    showStatus("Extension credentials not available", "error")
    return
  }

  try {
    const courseNames = Array.from(selectedCourses).map(c => c.name)
    console.log("Fetching papers for courses:", courseNames)
    showStatus("Loading papers...", "loading")
    
    // Use .in() for multiple courses
    const data = await supabase
      .from("question_papers")
      .select("*")
      .in("course_name", courseNames)
      .data()

    console.log("Fetched papers data:", data)
    
    // Ensure data is an array before sorting
    const papersArray = Array.isArray(data) ? data : [];

    // Sort papers by course name then year/sem
    const filteredPapers = papersArray.sort((a, b) => {
        if (a.course_name !== b.course_name) return a.course_name.localeCompare(b.course_name);
        // Handle exam_year robustly - convert to string for safe comparison
        const yearA = String(a.exam_year || "");
        const yearB = String(b.exam_year || "");
        return yearB.localeCompare(yearA, undefined, { numeric: true });
    })

    paperCountDiv.textContent = `${filteredPapers.length} papers available`
    paperCountDiv.classList.remove("hidden")
    statusDiv.classList.add("hidden") // Hide loading status

    console.log("Paper count should now show:", `${filteredPapers.length} papers available`)

    if (filteredPapers.length > 0) {
      console.log("Displaying paper list...")
      displayPaperList(filteredPapers)
      paperSelectionGroup.style.display = "block"
      
      // Auto-scroll to the available papers section
      setTimeout(() => {
        paperSelectionGroup.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    } else {
      console.log("No papers found, hiding selection group")
      paperSelectionGroup.style.display = "none"
      showStatus("No papers found for selected courses", "error")
    }
  } catch (error) {
    console.error("Error fetching papers:", error)
    paperSelectionGroup.style.display = "none"
    showStatus(`Error loading papers: ${error.message}`, "error")
  }
}

// Legacy function name for compatibility
async function updatePaperCount() {
  return updatePaperDisplay()
}

// Display paper list with checkboxes
function displayPaperList(papers) {
  console.log("Displaying paper list with", papers.length, "papers")
  const paperList = document.getElementById("paperList")

  paperList.innerHTML = papers
    .map(
      (paper, index) => `
        <div class="paper-item">
            <input type="checkbox" id="paper-${index}" value="${index}" class="paper-checkbox">
            <div class="paper-info">
                <div class="paper-details">${paper.course_name}</div>
                <div class="paper-meta">
                     ${paper.exam_type} • ${paper.exam_month} ${paper.exam_year} • ${paper.semester}
                </div>
            </div>
        </div>
    `,
    )
    .join("")

  console.log("Paper list HTML created")

  // Store papers data globally for later access
  window.availablePapers = papers

  // Add event listeners to checkboxes
  const checkboxes = paperList.querySelectorAll(".paper-checkbox")
  console.log("Found", checkboxes.length, "checkboxes")
  checkboxes.forEach((checkbox) => {
    checkbox.addEventListener("change", updateSelectedCount)
  })

  updateSelectedCount()
  console.log("Paper list display completed")
}

// Update selected count display
function updateSelectedCount() {
  const selectedCheckboxes = document.querySelectorAll(".paper-checkbox:checked")
  const selectedCount = document.getElementById("selectedCount")
  const count = selectedCheckboxes.length

  selectedCount.textContent = `${count} paper${count !== 1 ? "s" : ""} selected`
}

// Get selected papers
function getSelectedPapers() {
  const selectedCheckboxes = document.querySelectorAll(".paper-checkbox:checked")
  const selectedIndices = Array.from(selectedCheckboxes).map((cb) => Number.parseInt(cb.value))

  if (!window.availablePapers) {
    return []
  }

  return selectedIndices.map((index) => window.availablePapers[index])
}

// Select all papers
function selectAllPapers() {
  const checkboxes = document.querySelectorAll(".paper-checkbox")
  checkboxes.forEach((checkbox) => {
    checkbox.checked = true
  })
  updateSelectedCount()
}

// Deselect all papers
function deselectAllPapers() {
  const checkboxes = document.querySelectorAll(".paper-checkbox")
  checkboxes.forEach((checkbox) => {
    checkbox.checked = false
  })
  updateSelectedCount()
}

// Get selected study purpose
function getSelectedStudyPurpose() {
  const selectedRadio = document.querySelector('input[name="studyPurpose"]:checked')
  return selectedRadio ? selectedRadio.value : "general"
}

// Generate custom prompt based on study purpose
function generateCustomPrompt(studyPurpose, selectedPapers) {
  if (studyPurpose === "general") {
    return "" // No prompt for general analysis
  }

  const courseName = selectedCourses.size > 0 
      ? Array.from(selectedCourses).map(c => c.name).join(", ") 
      : "these courses";
      
  const paperCount = selectedPapers.length

  const promptTemplates = {
    internal1: `I'm studying for my Internal 1 exam and have uploaded ${paperCount} end semester question papers for ${courseName} for reference. My Internal 1 will have:
- Section A: 4 questions (5 marks each) 
- Section B: 4 questions (2 main questions, each with OR options, 15 marks each)

Internal 1 typically covers Modules 1 and 2, but my teacher may have assigned different modules.

Before we start, please ask me:
1. Which specific modules are covered in my Internal 1 exam?
2. How much time do I have to prepare for this exam?
3. What's my preferred study approach: (a) Practice solving questions, (b) Understand concepts through questions, (c) Create study notes from questions, or (d) Mixed approach?

Since I've uploaded end semester question papers, I need you to filter the relevant questions based on my modules. The end semester paper structure is: Section A has questions 1-2 (Module 1), 3-4 (Module 2), 5-6 (Module 3), 7-8 (Module 4), 9-10 (Module 5). Section B has questions 11-12 (Module 1 with OR), 13-14 (Module 2 with OR), 15-16 (Module 3 with OR), 17-18 (Module 4 with OR), 19-20 (Module 5 with OR). Please identify and focus on questions from my specified modules only.`,
    internal2: `I'm studying for my Internal 2 exam and have uploaded ${paperCount} end semester question papers for ${courseName} for reference. My Internal 2 will have:
- Section A: 4 questions (5 marks each)
- Section B: 4 questions (2 main questions, each with OR options, 15 marks each)

Internal 2 typically covers Modules 3 and 4, but my teacher may have assigned different modules.

Before we start, please ask me:
1. Which specific modules are covered in my Internal 2 exam?
2. How much time do I have to prepare for this exam?
3. What's my preferred study approach: (a) Practice solving questions, (b) Understand concepts through questions, (c) Create study notes from questions, or (d) Mixed approach?

Since I've uploaded end semester question papers, I need you to filter the relevant questions based on my modules. The end semester paper structure is: Section A has questions 1-2 (Module 1), 3-4 (Module 2), 5-6 (Module 3), 7-8 (Module 4), 9-10 (Module 5). Section B has questions 11-12 (Module 1 with OR), 13-14 (Module 2 with OR), 15-16 (Module 3 with OR), 17-18 (Module 4 with OR), 19-20 (Module 5 with OR). Please identify and focus on questions from my specified modules only.`,
    endSemester: `I'm studying for my End Semester exam and have uploaded ${paperCount} question papers for ${courseName} for reference. My End Semester exam will have:
- Section A: 10 questions (2 from each of the 5 modules)
- Section B: 10 questions (5 main questions, each with OR options)

Before we start, please ask me:
1. Are there any specific modules I want to focus on more, or should we cover all 5 modules equally?
2. How much time do I have to prepare for this exam?
3. What's my preferred study approach: (a) Practice solving questions, (b) Understand concepts through questions, (c) Create study notes from questions, (d) Focus on frequently asked questions, or (e) Mixed approach?

Once you know this, please help me create a comprehensive study plan covering all modules according to my study approach and time constraint, using the uploaded question papers as reference.`,
  }

  return promptTemplates[studyPurpose] || ""
}

// PDF downloads now handled by background script


// Main upload function
async function uploadPapers() {
  try {
    // Check if we're on ChatGPT
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab || !tab.url) {
      showStatus("Could not access current tab. Please try again.", "error")
      return
    }

    if (!tab.url.includes("chatgpt.com") && !tab.url.includes("chat.openai.com")) {
      showStatus("Please open ChatGPT first", "error")
      return
    }

    console.log("Current tab:", tab.url)

    showStatus("Fetching papers...", "loading")
    uploadBtn.disabled = true

    // First ensure background script is ready
    console.log("🔄 Checking background script before starting upload...")
    await ensureBackgroundScriptReady()

    if (selectedCourses.size === 0) {
      showStatus("Please select at least one course first", "error")
      return
    }

    const selectedPapers = getSelectedPapers()

    if (selectedPapers.length === 0) {
      showStatus("Please select at least one paper first", "error")
      return
    }

    const filteredPapers = selectedPapers

    if (filteredPapers.length === 0) {
      showStatus("No papers found for the selected criteria", "error")
      return
    }

    // Initialize progress bar
    showProgress(0, filteredPapers.length, "Preparing downloads...")
    hideProgress() // Hide first, then show again
    showProgress(0, filteredPapers.length, "Starting downloads...")

    // Download PDFs using background script
    const pdfData = []
    const downloadErrors = []

    for (let i = 0; i < filteredPapers.length; i++) {
      const paper = filteredPapers[i]
      try {
        const currentPaperName = `${paper.course_name} (${paper.exam_type})`
        showProgress(i, filteredPapers.length, `Downloading: ${currentPaperName}`)
        showStatus(`Downloading ${i + 1}/${filteredPapers.length}: ${paper.course_name}`, 'loading')
        
        // Use background script to download PDF - ORIGINAL WORKING VERSION
        const response = await chrome.runtime.sendMessage({
          action: 'downloadPDF',
          url: paper.download_url
        })

        if (response.success) {
          // Convert the response back to blob
          const byteCharacters = atob(response.base64Data)
          const byteNumbers = new Array(byteCharacters.length)
          for (let j = 0; j < byteCharacters.length; j++) {
            byteNumbers[j] = byteCharacters.charCodeAt(j)
          }
          const byteArray = new Uint8Array(byteNumbers)
          const blob = new Blob([byteArray], { type: "application/pdf" })

          pdfData.push({
            name: `${paper.course_name}_${paper.exam_type}_${paper.exam_month}_${paper.exam_year}.pdf`,
            blob: blob,
            info: paper,
          })

          console.log(`✅ Successfully downloaded: ${paper.course_name}`)
        } else {
          throw new Error(response.error)
        }
      } catch (error) {
        console.error(`❌ Error downloading ${paper.course_name}:`, error)
        downloadErrors.push({
          paper: paper.course_name,
          error: error.message,
          url: paper.download_url
        })

        // Continue with next paper instead of failing completely
        continue
      }
    }
    
    // Show final progress
    showProgress(filteredPapers.length, filteredPapers.length, "Downloads complete")

    // Show download summary - ORIGINAL WORKING VERSION
    console.log(`📊 Download Summary: ${pdfData.length}/${filteredPapers.length} successful`)
    if (downloadErrors.length > 0) {
      console.warn(`⚠️ Failed downloads:`, downloadErrors)
    }

    if (pdfData.length === 0) {
      hideProgress()
      if (downloadErrors.length > 0) {
        showStatus(`All ${filteredPapers.length} papers failed to download. Check console for details.`, "error")
      } else {
        showStatus("No papers found to download", "error")
      }
      return
    }

    // Show partial success message if some failed
    if (downloadErrors.length > 0) {
      showStatus(
        `Downloaded ${pdfData.length}/${filteredPapers.length} papers (${downloadErrors.length} failed)`,
        "loading",
      )
    }

    showStatus("Uploading to ChatGPT...", "loading")

    // Enhanced content script injection with retries
    let contentScriptReady = false
    let injectionAttempts = 0
    const maxInjectionAttempts = 3

    while (!contentScriptReady && injectionAttempts < maxInjectionAttempts) {
      injectionAttempts++
      console.log(`Attempt ${injectionAttempts}: Injecting content script...`)

      try {
        // Inject content script
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"],
        })

        // Wait longer for initialization
        await new Promise((resolve) => setTimeout(resolve, 1000))

        // Test if content script is responding
        try {
          const testResponse = await chrome.tabs.sendMessage(tab.id, {
            action: "ping",
          })
          contentScriptReady = true
          console.log("✅ Content script is responding")
        } catch (testError) {
          console.log(`❌ Content script test failed on attempt ${injectionAttempts}`)
          if (injectionAttempts < maxInjectionAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 1000))
          }
        }
      } catch (injectionError) {
        console.log(`Injection attempt ${injectionAttempts} failed:`, injectionError.message)
        if (injectionAttempts < maxInjectionAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
    }

    if (!contentScriptReady) {
      console.log("❌ All injection attempts failed, trying background injection...")

      // Last resort: ask background script to inject
      try {
        await chrome.runtime.sendMessage({
          action: "injectContentScript",
          tabId: tab.id,
        })

        await new Promise((resolve) => setTimeout(resolve, 1500))

        // Test one more time
        const finalTestResponse = await chrome.tabs.sendMessage(tab.id, {
          action: "ping",
        })

        contentScriptReady = true
        console.log("✅ Background injection successful")
      } catch (finalError) {
        console.error("❌ Background injection also failed:", finalError)
        throw new Error(
          "Could not establish connection with ChatGPT page. Please refresh the ChatGPT page and try again.",
        )
      }
    }

    // Send to content script for upload
    const pdfsWithBase64 = await Promise.all(
      pdfData.map(async (pdf) => ({
        name: pdf.name,
        info: pdf.info,
        // Convert blob to base64 for message passing
        data: await blobToBase64(pdf.blob),
      })),
    )

    console.log(`📤 Sending ${pdfsWithBase64.length} PDFs to content script...`)

    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: "uploadPDFs",
        pdfs: pdfsWithBase64,
      })
    } catch (error) {
      console.error("Message sending failed:", error)
      throw new Error(`Upload communication failed: ${error.message}. Please refresh ChatGPT and try again.`)
    }

    // Hide progress bar and show success
    hideProgress()

    if (downloadErrors.length > 0) {
      showStatus(`Successfully uploaded ${pdfData.length} papers! (${downloadErrors.length} downloads failed)`, "success")
    } else {
      showStatus(`Successfully uploaded ${pdfData.length} papers!`, "success")
    }

    // Inject custom prompt based on study purpose
    const studyPurpose = getSelectedStudyPurpose()
    const customPrompt = generateCustomPrompt(studyPurpose, selectedPapers)

    if (customPrompt && customPrompt.trim() !== "") {
      console.log(`📝 Injecting custom prompt for study purpose: ${studyPurpose}`)
      showStatus("Injecting study prompt...", "loading")

      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: "injectPrompt",
          prompt: customPrompt,
        })
        console.log("✅ Custom prompt injected successfully")
      } catch (promptError) {
        console.error("❌ Failed to inject custom prompt:", promptError)
        // Don't show error to user since upload was successful
      }
    } else {
      console.log("ℹ️ No custom prompt needed for general analysis")
    }
  } catch (error) {
    console.error("❌ Critical upload error:", error)
    console.error("❌ Error stack:", error.stack)
    
    // Hide progress and show error
    hideProgress()
    
    let errorMessage = "Upload failed. Please try again."
    if (error.message.includes("tab")) {
      errorMessage = "Could not access ChatGPT tab. Please refresh and try again."
    } else if (error.message.includes("network") || error.message.includes("fetch")) {
      errorMessage = "Network error. Check your connection and try again."
    } else if (error.message.includes("timeout")) {
      errorMessage = "Upload timeout. Try again with fewer papers."
    }
    
    showStatus(errorMessage, "error")
  } finally {
    // ALWAYS re-enable the button and ensure clean state
    console.log("🔄 Cleaning up upload process...")
    
    if (uploadBtn) {
      uploadBtn.disabled = false
      console.log("✅ Upload button re-enabled")
    }
    
    // Hide progress bar if still showing
    hideProgress()
    
    console.log("✅ Upload process cleanup complete")
  }
}

// Direct download function for downloading papers to user's PC
async function downloadPapersDirectly() {
  try {
    showStatus("Preparing downloads...", "loading")
    const downloadBtn = document.getElementById("downloadBtn")
    downloadBtn.disabled = true

    if (selectedCourses.size === 0) {
      showStatus("Please select at least one course first", "error")
      return
    }

    const selectedPapers = getSelectedPapers()

    if (selectedPapers.length === 0) {
      showStatus("Please select at least one paper first", "error")
      return
    }

    // Initialize progress bar
    showProgress(0, selectedPapers.length, "Preparing downloads...")
    
    let successfulDownloads = 0
    let failedDownloads = []

    for (let i = 0; i < selectedPapers.length; i++) {
      const paper = selectedPapers[i]
      try {
        const currentPaperName = `${paper.course_name} (${paper.exam_type})`
        showProgress(i, selectedPapers.length, `Downloading: ${currentPaperName}`)
        
        // Use background script to download PDF
        const response = await chrome.runtime.sendMessage({
          action: 'downloadPDF',
          url: paper.download_url
        })

        if (response.success) {
          // Convert base64 back to blob and create download
          const byteCharacters = atob(response.base64Data)
          const byteNumbers = new Array(byteCharacters.length)
          for (let j = 0; j < byteCharacters.length; j++) {
            byteNumbers[j] = byteCharacters.charCodeAt(j)
          }
          const byteArray = new Uint8Array(byteNumbers)
          const blob = new Blob([byteArray], { type: "application/pdf" })
          
          // Create filename with proper naming
          const filename = `${paper.course_name}_${paper.exam_type}_${paper.exam_month}_${paper.exam_year}.pdf`
          
          // Create download link and trigger download
          const url = URL.createObjectURL(blob)
          const downloadLink = document.createElement('a')
          downloadLink.href = url
          downloadLink.download = filename
          downloadLink.style.display = 'none'
          
          // Trigger download
          document.body.appendChild(downloadLink)
          downloadLink.click()
          document.body.removeChild(downloadLink)
          
          // Clean up URL after a short delay
          setTimeout(() => URL.revokeObjectURL(url), 1000)
          
          successfulDownloads++
          console.log(`✅ Successfully downloaded: ${filename}`)
        } else {
          throw new Error(response.error)
        }
      } catch (error) {
        console.error(`❌ Error downloading ${paper.course_name}:`, error)
        failedDownloads.push({
          paper: paper.course_name,
          error: error.message
        })
      }
    }
    
    // Show final progress
    showProgress(selectedPapers.length, selectedPapers.length, "Downloads complete")
    
    // Hide progress and show final status
    setTimeout(() => {
      hideProgress()
      
      if (successfulDownloads === selectedPapers.length) {
        showStatus(`Successfully downloaded ${successfulDownloads} papers!`, "success")
      } else if (successfulDownloads > 0) {
        showStatus(`Downloaded ${successfulDownloads}/${selectedPapers.length} papers (${failedDownloads.length} failed)`, "success")
      } else {
        showStatus("All downloads failed. Please check your connection and try again.", "error")
      }
    }, 1000)
    
  } catch (error) {
    console.error("❌ Critical download error:", error)
    hideProgress()
    
    let errorMessage = "Download failed. Please try again."
    if (error.message.includes("network") || error.message.includes("fetch")) {
      errorMessage = "Network error. Check your connection and try again."
    }
    
    showStatus(errorMessage, "error")
  } finally {
    // Re-enable the download button
    const downloadBtn = document.getElementById("downloadBtn")
    if (downloadBtn) {
      downloadBtn.disabled = false
    }
  }
}

// Convert blob to base64
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result.split(",")[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// State Management
const STORAGE_KEY_STATE = 'popup_state';
const STATE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function saveState() {
  const state = {
    timestamp: Date.now(),
    searchText: courseSearchInput.value,
    selectedCourses: Array.from(selectedCourses), // Store full course objects
    studyPurpose: getSelectedStudyPurpose()
  };
  chrome.storage.local.set({ [STORAGE_KEY_STATE]: state });
}

async function loadState() {
  try {
    const result = await new Promise(resolve => chrome.storage.local.get([STORAGE_KEY_STATE], resolve));
    const state = result[STORAGE_KEY_STATE];
    
    if (state) {
      // Check for timeout
      const now = Date.now();
      if (now - state.timestamp > STATE_TIMEOUT_MS) {
        console.log("🕒 Saved state expired (>10 mins), clearing...");
        chrome.storage.local.remove(STORAGE_KEY_STATE);
        return;
      }

      console.log("📥 Restoring state...", state);
      
      if (state.searchText) {
        courseSearchInput.value = state.searchText;
      }
      
      if (state.selectedCourses && Array.isArray(state.selectedCourses)) {
        selectedCourses = new Set(state.selectedCourses);
        updateSelectedCoursesDisplay();
        
        // If we have selected courses, auto-fetch papers
        if (selectedCourses.size > 0) {
            // Small delay to ensure auth is ready? Should be fine if called after init
            updatePaperDisplay(); 
        }
      }
      
      if (state.studyPurpose) {
        const radio = document.querySelector(`input[name="studyPurpose"][value="${state.studyPurpose}"]`);
        if (radio) radio.checked = true;
      }
    }
  } catch (error) {
    console.error("❌ Error loading state:", error);
  }
}

// Event listeners with error handling
console.log("🎯 Setting up event listeners...")

if (courseSearchInput) {
  try {
    courseSearchInput.addEventListener("input", (e) => {
      try {
        const searchTerm = e.target.value
        console.log("🔍 Input event triggered, search term:", searchTerm)
        showCourseSuggestions(searchTerm)
        saveState(); // Save search text
      } catch (error) {
        console.error("❌ Error in input event handler:", error)
      }
    })
    console.log("✅ Input event listener added")

    // Add click listener to show dropdown when clicking back into the search box
    courseSearchInput.addEventListener("click", (e) => {
      try {
        const searchTerm = e.target.value
        if (searchTerm.trim()) {
            showCourseSuggestions(searchTerm)
        }
      } catch (error) {
        console.error("❌ Error in click event handler:", error)
      }
    })
    console.log("✅ Click event listener added")
    
    courseSearchInput.addEventListener("keydown", handleKeyNavigation)
    console.log("✅ Keydown event listener added")
  } catch (error) {
    console.error("❌ Error setting up course search listeners:", error)
  }
} else {
  console.error("❌ Cannot add event listeners - courseSearchInput not found!")
}

// Add listener for study purpose changes
document.querySelectorAll('input[name="studyPurpose"]').forEach(radio => {
    radio.addEventListener('change', saveState);
});

// Fetch papers button listener
if (fetchPapersBtn) {
    try {
        fetchPapersBtn.addEventListener('click', updatePaperDisplay)
        console.log("✅ Fetch button event listener added")
    } catch (error) {
        console.error("❌ Error setting up fetch button listener:", error)
    }
}

// Theme toggle event listener
if (themeToggle) {
  try {
    themeToggle.addEventListener('click', toggleTheme)
    console.log("✅ Theme toggle event listener added")
  } catch (error) {
    console.error("❌ Error setting up theme toggle listener:", error)
  }
} else {
  console.error("❌ Cannot add theme toggle listener - themeToggle not found!")
}

// Download button event listener
if (downloadBtn) {
  try {
    downloadBtn.addEventListener('click', downloadPapersDirectly)
    console.log("✅ Download button event listener added")
  } catch (error) {
    console.error("❌ Error setting up download button listener:", error)
  }
} else {
  console.error("❌ Cannot add download button listener - downloadBtn not found!")
}

// Close dropdown when clicking outside
document.addEventListener("click", (e) => {
  if (!courseSearchInput.contains(e.target) && !courseDropdown.contains(e.target)) {
    courseDropdown.classList.add("hidden")
    highlightedIndex = -1
  }
})

// Note: Exam type checkboxes have been removed, no longer need event listeners for them

// Add event listeners for Select All/Deselect All buttons
document.getElementById("selectAllBtn").addEventListener("click", selectAllPapers)
document.getElementById("deselectAllBtn").addEventListener("click", deselectAllPapers)

form.addEventListener("submit", (e) => {
  e.preventDefault()

  if (selectedCourses.size === 0) {
    showStatus("Please select a course first", "error")
    return
  }

  const selectedPapers = getSelectedPapers()
  if (selectedPapers.length === 0) {
    showStatus("Please select at least one paper to upload", "error")
    return
  }

  uploadPapers()
})

// Initialize with comprehensive error handling
console.log("🎬 Setting up DOMContentLoaded listener...")

document.addEventListener("DOMContentLoaded", async () => {
  console.log("🚀 DOM loaded, initializing extension...")
  
  try {
    // Initialize credentials first
    console.log("🔐 Initializing credentials...")
    await window.initializeCredentials()
    // supabase = createSupabaseClient() // Already handled in initializeCredentials via initSupabase
    console.log("✅ Supabase client created")
    
    // Load theme preference
    loadThemePreference()
    
    // Verify all critical elements exist
    const criticalElements = {
      courseSearchInput, courseDropdown, selectedCoursesContainer, fetchPapersBtn,
      paperCountDiv, uploadBtn, downloadBtn, statusDiv, form
    }
    
    console.log("🔍 Checking critical elements...")
    let missingElements = []
    for (const [name, element] of Object.entries(criticalElements)) {
      if (!element) {
        missingElements.push(name)
      }
    }
    
    if (missingElements.length > 0) {
      console.error("❌ Missing critical elements:", missingElements)
      alert(`Extension error: Missing elements ${missingElements.join(', ')}. Please reload the extension.`)
      return
    }
    
    console.log("✅ All critical elements found")
    
    // Restore previous state (selected courses, search text, study purpose)
    await loadState();

    // Check if we're on ChatGPT
    if (chrome?.tabs) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        try {
          const currentTab = tabs[0]
          console.log("🌐 Current tab URL:", currentTab?.url)
          
          if (!currentTab || (!currentTab.url.includes("chatgpt.com") && !currentTab.url.includes("chat.openai.com"))) {
            showStatus("Please navigate to ChatGPT to use this extension", "error")
            if (uploadBtn) uploadBtn.disabled = true
            // Still load courses for testing course search functionality
            console.log("📚 Not on supported LLM platform, but loading courses for testing...")
            loadAllCourses()
          } else {
            console.log("✅ On supported LLM platform, loading courses...")
            // Load courses immediately when on supported platform
            loadAllCourses()
          }
        } catch (tabError) {
          console.error("❌ Error checking current tab:", tabError)
          showStatus("Extension context error", "error")
          // Still try to load courses
          loadAllCourses()
        }
      })
    } else {
      console.warn("⚠️ Chrome tabs API not available, loading courses anyway...")
      loadAllCourses()
    }
    
  } catch (error) {
    console.error("❌ Critical error during initialization:", error)
    console.error("❌ Error stack:", error.stack)
    
    if (error.message.includes('credentials') || error.message.includes('storage')) {
      showStatus("Failed to load extension credentials", "error")
    } else if (statusDiv) {
      showStatus("Extension failed to initialize", "error")
    } else {
      alert("Extension initialization failed. Please reload the extension.")
    }
  }
})

console.log("✅ DOMContentLoaded listener set up")
