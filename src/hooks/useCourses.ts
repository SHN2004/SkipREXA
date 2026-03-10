import { useState, useEffect } from 'react';
import { getSupabase } from '@/supabase-client';

export type Course = {
    name: string;
    code: string;
    semesters: string[];
    searchText: string;
};

export function useCourses() {
    const [courses, setCourses] = useState<Course[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        async function fetchCourses() {
            setIsLoading(true);
            setError(null);

            try {
                const CACHE_KEY_COURSES = 'cached_courses';
                const CACHE_KEY_TIMESTAMP = 'courses_last_fetch';
                const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

                const cache = await new Promise<any>(resolve => {
                    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                        chrome.storage.local.get([CACHE_KEY_COURSES, CACHE_KEY_TIMESTAMP], resolve);
                    } else {
                        resolve({}); // Fallback for localhost testing
                    }
                });

                const now = Date.now();
                const lastFetch = cache[CACHE_KEY_TIMESTAMP] || 0;

                if (cache[CACHE_KEY_COURSES] && (now - lastFetch < CACHE_DURATION)) {
                    const cachedCourses = cache[CACHE_KEY_COURSES];
                    cachedCourses.sort((a: Course, b: Course) => a.name.localeCompare(b.name));
                    setCourses(cachedCourses);
                    setIsLoading(false);
                    return;
                }

                const supabase = getSupabase() as any;
                if (!supabase) throw new Error("Supabase client not initialized");

                const data = await supabase.rpc('get_distinct_courses').data();
                if (!data || data.length === 0) {
                    throw new Error("No courses found in database");
                }

                const fetchedCourses = data.map((course: any) => ({
                    name: course.course_name,
                    code: course.actual_subject_code,
                    semesters: course.semesters,
                    searchText: `${course.course_name} ${course.actual_subject_code}`.toLowerCase(),
                })).sort((a: Course, b: Course) => a.name.localeCompare(b.name));

                if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                    await chrome.storage.local.set({
                        [CACHE_KEY_COURSES]: fetchedCourses,
                        [CACHE_KEY_TIMESTAMP]: now
                    });
                }

                setCourses(fetchedCourses);
            } catch (err: any) {
                console.error("Critical error loading courses:", err);
                setError(err.message || "Failed to load courses");
            } finally {
                setIsLoading(false);
            }
        }

        fetchCourses();
    }, []);

    return { courses, isLoading, error };
}
