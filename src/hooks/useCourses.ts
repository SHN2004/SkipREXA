import { useState, useEffect } from 'react';
import { buildCourses, fetchPaperIndex, type CourseRecord } from '@/data-client';

export type Course = CourseRecord;

export function useCourses() {
    const [courses, setCourses] = useState<Course[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        async function fetchCourses() {
            setIsLoading(true);
            setError(null);

            try {
                const index = await fetchPaperIndex();
                const fetchedCourses = buildCourses(index.papers)
                    .sort((first: Course, second: Course) => first.name.localeCompare(second.name));

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
