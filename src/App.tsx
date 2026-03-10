import React, { useState, useEffect, useRef } from 'react';
import { ThemeProvider } from '@/components/theme-provider';
import { ThemeToggle } from '@/components/theme-toggle';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Search, Loader2, X, Download, UploadCloud, CheckCircle2, ChevronRight, CheckSquare, Square } from 'lucide-react';
import { useCourses, Course } from '@/hooks/useCourses';
import { usePapers, Paper } from '@/hooks/usePapers';
import { processUpload, processDirectDownload } from '@/hooks/useUpload';
import openaiIcon from '@/assets/openai.svg';
import claudeIcon from '@/assets/claude-color.svg';

export default function App() {
    const { courses, isLoading: isLoadingCourses, error: courseError } = useCourses();
    const { papers, fetchPapersForCourses, isLoading: isLoadingPapers } = usePapers();

    const [searchTerm, setSearchTerm] = useState('');
    const [selectedCourses, setSelectedCourses] = useState<Course[]>([]);
    const [selectedPapers, setSelectedPapers] = useState<Set<string>>(new Set());
    const [studyIntent, setStudyIntent] = useState('general');
    const [isLoading, setIsLoading] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);
    const [progressMsg, setProgressMsg] = useState('');
    const [showDropdown, setShowDropdown] = useState(false);
    const [highlightedIndex, setHighlightedIndex] = useState(-1);

    const [activeLLM, setActiveLLM] = useState('ChatGPT');
    const isBusy = isLoading || isDownloading;

    useEffect(() => {
        if (chrome?.tabs) {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const url = tabs[0]?.url || "";
                if (url.includes("claude.ai")) {
                    setActiveLLM("Claude");
                }
            });
        }
    }, []);

    const papersSectionRef = useRef<HTMLDivElement>(null);
    const mainScrollRef = useRef<HTMLElement>(null);
    const progressPanelRef = useRef<HTMLDivElement>(null);
    const wasBusyRef = useRef(false);

    useEffect(() => {
        if (papers.length > 0 && papersSectionRef.current) {
            setTimeout(() => {
                papersSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
        }
    }, [papers.length]);

    useEffect(() => {
        const wasBusy = wasBusyRef.current;
        wasBusyRef.current = isBusy;

        if (!isBusy || wasBusy) return;

        const frameId = requestAnimationFrame(() => {
            const scrollContainer = mainScrollRef.current;
            const progressPanel = progressPanelRef.current;

            if (!scrollContainer || !progressPanel) return;

            const containerRect = scrollContainer.getBoundingClientRect();
            const panelRect = progressPanel.getBoundingClientRect();
            const topBuffer = 12;
            const bottomBuffer = 16;
            const visibleTop = containerRect.top + topBuffer;
            const visibleBottom = containerRect.bottom - bottomBuffer;
            const isFullyVisible = panelRect.top >= visibleTop && panelRect.bottom <= visibleBottom;

            if (isFullyVisible) return;

            let nextScrollTop = scrollContainer.scrollTop;

            if (panelRect.bottom > visibleBottom) {
                nextScrollTop += panelRect.bottom - visibleBottom;
            }

            if (panelRect.top < visibleTop) {
                nextScrollTop += panelRect.top - visibleTop;
            }

            const maxScrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight;
            const targetScrollTop = Math.min(Math.max(nextScrollTop, 0), maxScrollTop);

            if (Math.abs(targetScrollTop - scrollContainer.scrollTop) < 1) return;

            scrollContainer.scrollTo({
                top: targetScrollTop,
                behavior: 'smooth',
            });
        });

        return () => cancelAnimationFrame(frameId);
    }, [isBusy]);


    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);


    // --- CACHING & MEMORY LOGIC ---
    const STORAGE_KEY_STATE = 'skiprexa_popup_state';
    const STATE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
    const isFirstLoad = useRef(true);

    // Initial load from cache
    useEffect(() => {
        if (!chrome?.storage) return;

        const loadState = async () => {
            try {
                const result = await new Promise<any>(resolve => chrome.storage.local.get([STORAGE_KEY_STATE], resolve));
                const state = result[STORAGE_KEY_STATE];

                if (state) {
                    const now = Date.now();
                    if (now - state.timestamp > STATE_TIMEOUT_MS) {
                        chrome.storage.local.remove(STORAGE_KEY_STATE);
                        return;
                    }

                    if (state.searchText) setSearchTerm(state.searchText);
                    if (state.selectedCourses && Array.isArray(state.selectedCourses)) {
                        setSelectedCourses(state.selectedCourses);

                        // Auto-fetch if there were selected courses
                        if (state.selectedCourses.length > 0) {
                            fetchPapersForCourses(state.selectedCourses.map((c: Course) => c.name));
                        }
                    }
                    if (state.studyIntent) setStudyIntent(state.studyIntent);
                }
            } catch (error) {
                console.error("Error loading state:", error);
            } finally {
                // Ensure we don't save initial empty states during the async fetch
                setTimeout(() => { isFirstLoad.current = false; }, 100);
            }
        };

        loadState();
    }, []);

    // Save state whenever relevant fields change
    useEffect(() => {
        if (!chrome?.storage || isFirstLoad.current) return;

        const saveState = async () => {
            const state = {
                timestamp: Date.now(),
                searchText: searchTerm,
                selectedCourses: selectedCourses,
                studyIntent: studyIntent
            };
            chrome.storage.local.set({ [STORAGE_KEY_STATE]: state });
        };

        saveState();
    }, [searchTerm, selectedCourses, studyIntent]);
    // ----------------------------

    // Close dropdown on outside click
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setShowDropdown(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const filteredCourses = searchTerm.trim()
        ? courses.filter(c => c.searchText.includes(searchTerm.toLowerCase())).slice(0, 8)
        : [];

    const handleFetchPapers = () => {
        fetchPapersForCourses(selectedCourses.map(c => c.name));
    };

    const toggleCourse = (course: Course) => {
        setSelectedCourses(prev => {
            const isSelected = prev.some(c => c.code === course.code);
            if (isSelected) {
                return prev.filter(c => c.code !== course.code);
            } else {
                return [...prev, course];
            }
        });
    };

    const togglePaper = (paperId: string) => {
        const newSelected = new Set(selectedPapers);
        if (newSelected.has(paperId)) {
            newSelected.delete(paperId);
        } else {
            newSelected.add(paperId);
        }
        setSelectedPapers(newSelected);
    };

    const toggleAllPapers = () => {
        if (selectedPapers.size === papers.length) {
            setSelectedPapers(new Set());
        } else {
            setSelectedPapers(new Set(papers.map((_, i) => i.toString())));
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!showDropdown || filteredCourses.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlightedIndex(prev => Math.min(prev + 1, filteredCourses.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlightedIndex(prev => Math.max(prev - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (highlightedIndex >= 0 && filteredCourses[highlightedIndex]) {
                toggleCourse(filteredCourses[highlightedIndex]);
            }
        } else if (e.key === 'Escape') {
            setShowDropdown(false);
        }
    };

    const handleUpload = async () => {
        setIsLoading(true);
        try {
            const papersToUpload = Array.from(selectedPapers).map(id => papers[parseInt(id)]);
            await processUpload(papersToUpload, selectedCourses, studyIntent, setProgressMsg);
        } catch (error: any) {
            alert(error.message || "Upload failed");
        } finally {
            setIsLoading(false);
            setProgressMsg('');
        }
    };

    const handleDownload = async () => {
        setIsDownloading(true);
        try {
            const papersToDownload = Array.from(selectedPapers).map(id => papers[parseInt(id)]);
            await processDirectDownload(papersToDownload, setProgressMsg);
        } catch (error: any) {
            alert("Download failed");
        } finally {
            setIsDownloading(false);
            setProgressMsg('');
        }
    };

    return (
        <ThemeProvider defaultTheme="system" storageKey="skiprexa-theme">
            <div className="w-[400px] h-[600px] bg-background text-foreground transition-colors duration-300 relative selection:bg-primary selection:text-white flex flex-col overflow-hidden">
                {/* Header */}
                <header className="fixed top-0 left-0 right-0 z-[100] px-5 py-4 border-b border-foreground/20 bg-background/80 backdrop-blur-md flex justify-between items-center shadow-sm">
                    <div className="flex flex-col">
                        <h1 className="font-display font-black text-[28px] text-foreground leading-[1] tracking-tight m-0 uppercase italic">Skip<span className="text-primary">REXA</span></h1>
                        <span className="text-[10px] text-muted-foreground font-bold tracking-[0.2em] uppercase mt-[4px]">Study Assistant</span>
                    </div>
                    <ThemeToggle />
                </header>

                {/* Main Content */}
                <main ref={mainScrollRef} className="flex-1 mt-[88px] px-5 pb-6 overflow-y-auto overflow-x-hidden relative custom-scrollbar">
                    {/* Section 1: Search */}
                    <section className="mb-8" >
                        <div className="flex items-end gap-3 mb-4 border-b-2 border-foreground pb-2">
                            <span className="font-display font-bold text-3xl leading-none text-primary -mb-1">01</span>
                            <h2 className="font-main font-bold text-[14px] uppercase tracking-widest text-foreground m-0 flex-1">Select Course</h2>
                            {courseError && <span className="text-xs font-bold text-destructive bg-destructive/10 px-2 py-0.5 border border-destructive">{courseError}</span>}
                        </div>

                        <div className="relative z-50" ref={containerRef}>
                            <Search className="absolute left-[13px] top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground opacity-70" />
                            <Input
                                ref={inputRef}
                                value={searchTerm}
                                onChange={(e) => {
                                    setSearchTerm(e.target.value);
                                    setShowDropdown(true);
                                    setHighlightedIndex(-1);
                                }}
                                onFocus={() => setShowDropdown(true)}
                                onKeyDown={handleKeyDown}
                                placeholder={isLoadingCourses ? "Loading courses..." : "Search by name or code..."}
                                disabled={isLoadingCourses}
                                className="pl-11"
                            />

                            {/* Dropdown menu */}
                            {showDropdown && searchTerm.trim() && (
                                <div className="mt-2 w-full bg-card border-2 border-foreground max-h-[280px] overflow-y-scroll overflow-x-hidden z-50 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.15)] dark:shadow-[4px_4px_0px_0px_rgba(0,0,0,0.6)] animate-in fade-in slide-in-from-top-2 relative custom-scrollbar">
                                    {filteredCourses.length === 0 ? (
                                        <div className="p-4 text-sm font-semibold text-muted-foreground uppercase tracking-wider text-center">No courses found</div>
                                    ) : (
                                        filteredCourses.map((course, index) => {
                                            const isSelected = selectedCourses.some(c => c.code === course.code);
                                            return (
                                                <div
                                                    key={course.code}
                                                    className={`p-4 cursor-pointer border-b-2 border-foreground transition-all flex items-start gap-3
                            ${index === filteredCourses.length - 1 ? 'border-b-0' : ''}
                            ${highlightedIndex === index || isSelected ? 'bg-foreground text-background' : 'hover:bg-muted text-foreground'}`}
                                                    onClick={() => toggleCourse(course)}
                                                >
                                                    <div className={`mt-0.5 w-[18px] h-[18px] flex-shrink-0 border-2 ${highlightedIndex === index || isSelected ? 'border-background/50' : 'border-foreground'} flex items-center justify-center transition-colors`}>
                                                        {isSelected && <div className={`w-2.5 h-2.5 ${highlightedIndex === index || isSelected ? 'bg-primary' : 'bg-foreground'}`} />}
                                                    </div>
                                                    <div className="flex-1">
                                                        <div className={`font-display font-bold text-[16px] mb-1 leading-tight ${highlightedIndex === index || isSelected ? 'text-background' : 'text-foreground'}`}>{course.name}</div>
                                                        <div className={`font-main font-bold text-[10px] leading-tight tracking-[0.05em] uppercase ${highlightedIndex === index || isSelected ? 'text-background/70' : 'text-muted-foreground'}`}>
                                                            {course.code} <span className="mx-1 opacity-50">•</span> {course.semesters.join(", ")}
                                                        </div>
                                                    </div>
                                                </div>
                                            )
                                        })
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Selected Chips */}
                        {!(showDropdown && searchTerm.trim()) && selectedCourses.length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-4 animate-in fade-in slide-in-from-top-2">
                                {selectedCourses.map(course => (
                                    <div key={course.code} className="inline-flex items-center gap-2 bg-foreground text-background border border-foreground/10 py-1.5 pl-4 pr-1.5 shadow-sm rounded-full animate-in zoom-in-95 group hover:shadow-md transition-all duration-300">
                                        <span className="font-main font-bold text-[10px] uppercase tracking-[0.1em]">{course.name}</span>
                                        <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleCourse(course); }} className="w-5 h-5 rounded-full bg-background/10 hover:bg-destructive hover:text-destructive-foreground flex items-center justify-center transition-all">
                                            <X className="w-3 h-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {selectedCourses.length > 0 && (
                            <Button
                                className="relative overflow-hidden group w-full mt-6 font-main font-bold uppercase tracking-[0.2em] text-primary-foreground bg-primary hover:bg-primary/95 transition-all duration-500 rounded-[20px] h-14 text-[11px] shadow-sm hover:shadow-[0_0_20px_rgba(124,58,237,0.4)] dark:hover:shadow-[0_0_20px_rgba(179,156,208,0.4)] hover:-translate-y-0.5 active:translate-y-0 active:scale-95 flex items-center justify-center gap-2 border-none"
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={() => {
                                    setSearchTerm('');
                                    setShowDropdown(false);
                                    handleFetchPapers();
                                }}
                                disabled={isLoadingPapers}
                            >
                                {isLoadingPapers ? <Loader2 className="w-5 h-5 animate-spin" /> : papers.length > 0 ? 'Update Papers' : 'Fetch Papers'}
                            </Button>
                        )}
                    </section>

                    {/* Section 2: Intent */}
                    <section className="mb-8 relative z-10">
                        <div className="flex items-end gap-3 mb-4 border-b-2 border-foreground pb-2">
                            <span className="font-display font-bold text-3xl leading-none text-primary -mb-1">02</span>
                            <h2 className="font-main font-bold text-[14px] uppercase tracking-widest text-foreground m-0 flex-1">Study Purpose</h2>
                        </div>
                        <div className="grid gap-3">
                            {[
                                { id: 'general', label: 'General Analysis (No Prompt Injection)' },
                                { id: 'internal_1', label: 'Internal 1 Prep (Modules 1-2)' },
                                { id: 'internal_2', label: 'Internal 2 Prep (Modules 3-4)' },
                                { id: 'model', label: 'Model Exam Prep (All Modules)' }
                            ].map((intent) => (
                                <label key={intent.id} className={`flex items-center p-4 bg-card border-2 cursor-pointer transition-all ${studyIntent === intent.id ? 'border-primary shadow-sm -translate-y-1 rounded-[16px]' : 'border-foreground/20 hover:shadow-sm hover:-translate-y-0.5 rounded-[16px]'}`}>
                                    <input type="radio" name="intent" value={intent.id} checked={studyIntent === intent.id} onChange={(e) => setStudyIntent(e.target.value)} className="appearance-none w-5 h-5 border-2 border-foreground rounded-none mr-4 checked:border-primary checked:bg-primary transition-all flex-shrink-0 relative checked:after:content-[''] checked:after:absolute checked:after:top-1/2 checked:after:left-1/2 checked:after:-translate-x-1/2 checked:after:-translate-y-1/2 checked:after:w-2 checked:after:h-2 checked:after:bg-white" />
                                    <span className={`font-main text-[13px] uppercase tracking-wider flex-1 transition-colors ${studyIntent === intent.id ? 'font-bold text-primary' : 'font-semibold text-foreground'}`}>{intent.label}</span>
                                </label>
                            ))}
                        </div>
                    </section>

                    {/* Papers Section */}
                    {papers.length > 0 && (
                        <section ref={papersSectionRef} className="mb-6 relative z-10 animate-in fade-in slide-in-from-bottom-4 pt-16 -mt-16">
                            <div className="flex justify-between items-end mb-4 border-b-2 border-foreground pb-2">
                                <div className="flex items-end gap-3">
                                    <span className="font-display font-bold text-3xl leading-none text-primary -mb-1">03</span>
                                    <h2 className="font-main font-bold text-[14px] uppercase tracking-widest text-foreground m-0 flex-1">Select Papers</h2>
                                </div>
                                <div className="flex items-center gap-4">
                                    <span className="font-main text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground mr-2">
                                        <span className="text-primary text-[14px]">{selectedPapers.size}</span> / {papers.length}
                                    </span>
                                    <button onClick={toggleAllPapers} className="bg-foreground/5 text-foreground hover:bg-foreground hover:text-background px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-[0.15em] transition-all duration-300 transform active:scale-95 flex items-center gap-1 shadow-sm hover:shadow-md">
                                        {selectedPapers.size === papers.length ? 'NONE' : 'ALL'}
                                    </button>
                                </div>
                            </div>

                            <ScrollArea className="h-[280px] border border-border bg-card rounded-[20px] shadow-sm overflow-hidden">
                                <div className="flex flex-col">
                                    {papers.map((paper, index) => {
                                        const idStr = index.toString();
                                        const isSelected = selectedPapers.has(idStr);
                                        return (
                                            <div
                                                key={idStr}
                                                onClick={() => togglePaper(idStr)}
                                                className={`flex items-start gap-4 p-4 cursor-pointer transition-all duration-300 border-b border-border/50 ${isSelected ? 'bg-primary/5 hover:bg-primary/10' : 'hover:bg-muted/30'} ${index === papers.length - 1 ? 'border-b-0' : ''}`}
                                            >
                                                <div className="mt-0.5 flex-shrink-0">
                                                    {isSelected ? <CheckSquare className="w-5 h-5 text-primary transition-transform duration-300 scale-110" strokeWidth={3} /> : <Square className="w-5 h-5 text-muted-foreground opacity-40 transition-all duration-300 hover:opacity-100 hover:scale-110" strokeWidth={2} />}
                                                </div>
                                                <div className="flex flex-col gap-1">
                                                    <span className={`font-display font-bold text-[14px] leading-tight ${isSelected ? 'text-primary' : 'text-foreground'}`}>{paper.course_name}</span>
                                                    <span className="font-main text-[10px] font-bold text-muted-foreground uppercase tracking-[0.05em]">
                                                        {paper.exam_type} <span className="mx-1 opacity-50">•</span> {paper.exam_month} {paper.exam_year} <span className="mx-1 opacity-50">•</span> {paper.semester}
                                                    </span>
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            </ScrollArea>


                            <div className="grid grid-cols-2 gap-4 mt-6">
                                <Button variant="outline" className="relative overflow-hidden group font-main tracking-[0.15em] uppercase font-bold text-[10px] h-14 border border-border/50 bg-background text-foreground hover:bg-foreground hover:text-background transition-all duration-500 rounded-[20px] shadow-sm hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 active:scale-95 flex items-center justify-center gap-2" onClick={handleDownload} disabled={isDownloading || isLoading || selectedPapers.size === 0}>
                                    {isDownloading ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Download className="w-4 h-4 mr-2 group-hover:scale-110 transition-transform duration-300" />} Save to PC
                                </Button>
                                <Button className="relative overflow-hidden group font-main tracking-[0.15em] uppercase font-bold text-[10px] h-14 bg-primary text-primary-foreground transition-all duration-500 rounded-[20px] shadow-sm hover:shadow-[0_0_20px_rgba(124,58,237,0.4)] dark:hover:shadow-[0_0_20px_rgba(179,156,208,0.4)] border-none hover:-translate-y-0.5 active:translate-y-0 active:scale-95 flex items-center justify-center gap-2" onClick={handleUpload} disabled={isLoading || isDownloading || selectedPapers.size === 0}>
                                    {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : (
                                        activeLLM === 'Claude' ? (
                                            <img src={claudeIcon} alt="Claude" className="w-4 h-4 mr-1 opacity-90 group-hover:scale-110 transition-transform duration-300" />
                                        ) : (
                                            <img src={openaiIcon} alt="ChatGPT" className="w-4 h-4 mr-1 opacity-90 group-hover:scale-110 transition-transform duration-300" />
                                        )
                                    )}
                                    Send to {activeLLM}
                                </Button>
                            </div>
                            {isBusy && (
                                <div ref={progressPanelRef} className="mt-4 p-3 border border-primary/50 bg-primary/5 rounded-[16px] flex flex-col items-center justify-center gap-2 animate-in fade-in slide-in-from-bottom-2 shadow-sm">
                                    <div className="flex items-center gap-2 text-primary font-main tracking-widest uppercase font-bold text-xs">
                                        <Loader2 className="w-4 h-4 animate-spin" /> {progressMsg}
                                    </div>
                                    <span className="text-[9px] font-main font-bold tracking-[0.15em] uppercase text-muted-foreground/70">
                                        Please keep extension open
                                    </span>
                                </div>
                            )}
                        </section>
                    )}

                </main>
            </div>
        </ThemeProvider>
    );
}
