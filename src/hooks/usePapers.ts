import { useState } from 'react';
import { fetchPaperIndex, filterPapersForCourses, type Paper } from '@/data-client';

export type { Paper } from '@/data-client';

export function usePapers() {
    const [papers, setPapers] = useState<Paper[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchPapersForCourses = async (courseNames: string[]) => {
        if (courseNames.length === 0) {
            setPapers([]);
            return;
        }

        setIsLoading(true);
        setError(null);

        try {
            const index = await fetchPaperIndex();
            setPapers(filterPapersForCourses(index.papers, courseNames));
        } catch (err: any) {
            console.error("Error fetching papers:", err);
            setError(err.message || "Failed to load papers");
        } finally {
            setIsLoading(false);
        }
    };

    return { papers, isLoading, error, fetchPapersForCourses };
}
