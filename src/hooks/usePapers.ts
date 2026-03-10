import { useState } from 'react';
import { getSupabase } from '@/supabase-client';

export type Paper = {
    id: string;
    course_name: string;
    exam_type: string;
    exam_month: string;
    exam_year: string;
    semester: string;
};

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
            const supabase = getSupabase() as any;
            if (!supabase) throw new Error("Supabase client not initialized");

            const data = await supabase
                .from("question_papers")
                .select("*")
                .in("course_name", courseNames)
                .data();

            const papersArray = Array.isArray(data) ? data : [];

            const filteredPapers = papersArray.sort((a, b) => {
                if (a.course_name !== b.course_name) return a.course_name.localeCompare(b.course_name);
                const yearA = String(a.exam_year || "");
                const yearB = String(b.exam_year || "");
                return yearB.localeCompare(yearA, undefined, { numeric: true });
            });

            setPapers(filteredPapers);
        } catch (err: any) {
            console.error("Error fetching papers:", err);
            setError(err.message || "Failed to load papers");
        } finally {
            setIsLoading(false);
        }
    };

    return { papers, isLoading, error, fetchPapersForCourses };
}
