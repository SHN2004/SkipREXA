import bundledPaperIndex from "../data/question-papers.json";

export type Paper = {
  id: string;
  sl_no?: string | null;
  question_paper_code?: string | null;
  course_name: string;
  course_code?: string | null;
  actual_subject_code?: string | null;
  semester?: string | null;
  exam_type?: string | null;
  admission_year?: number | null;
  exam_month?: string | null;
  exam_year?: number | null;
  raw_exam_details?: string | null;
  download_url: string;
};

type PaperIndex = {
  metadata: {
    generated_at?: string | null;
    source: string;
    page_url: string;
    paper_count: number;
    notes?: string[];
  };
  papers: Paper[];
};

const REMOTE_DATA_URL =
  "https://raw.githubusercontent.com/SHN2004/SkipREXA/main/data/question-papers.json";
const DATA_SOURCE_STRATEGY =
  import.meta.env.VITE_DATA_SOURCE_STRATEGY || "github-first";
const CACHE_KEY_INDEX = "paper_index_cache_v1";
const CACHE_KEY_TIMESTAMP = "paper_index_last_fetch_v1";
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000;

async function getCachedIndex() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return null;
  }

  const result = await chrome.storage.local.get([CACHE_KEY_INDEX, CACHE_KEY_TIMESTAMP]);
  return {
    index: (result[CACHE_KEY_INDEX] as PaperIndex | undefined) ?? null,
    timestamp: (result[CACHE_KEY_TIMESTAMP] as number | undefined) ?? 0,
  };
}

async function setCachedIndex(index: PaperIndex) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return;
  }

  await chrome.storage.local.set({
    [CACHE_KEY_INDEX]: index,
    [CACHE_KEY_TIMESTAMP]: Date.now(),
  });
}

function isFresh(timestamp: number) {
  return Date.now() - timestamp < CACHE_DURATION_MS;
}

function getBundledIndex(): PaperIndex | null {
  if (bundledPaperIndex && Array.isArray(bundledPaperIndex.papers)) {
    return bundledPaperIndex as PaperIndex;
  }

  return null;
}

async function fetchRemoteIndex() {
  const response = await fetch(REMOTE_DATA_URL, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub JSON fetch failed: ${response.status}`);
  }

  const index = (await response.json()) as PaperIndex;
  if (!index || !Array.isArray(index.papers)) {
    throw new Error("GitHub JSON payload is invalid.");
  }

  await setCachedIndex(index);
  return index;
}

export async function fetchPaperIndex(forceRefresh = false): Promise<PaperIndex> {
  const cached = await getCachedIndex();
  if (!forceRefresh && cached?.index && isFresh(cached.timestamp)) {
    return cached.index;
  }

  const bundledIndex = getBundledIndex();

  if (DATA_SOURCE_STRATEGY === "local-first" && bundledIndex) {
    return bundledIndex;
  }

  try {
    return await fetchRemoteIndex();
  } catch (error) {
    if (cached?.index) {
      return cached.index;
    }

    if (bundledIndex) {
      return bundledIndex;
    }

    throw error instanceof Error ? error : new Error("Failed to load question paper index.");
  }
}

export function buildCourses(papers: Paper[]) {
  const byCourse = new Map<
    string,
    {
      name: string;
      code: string;
      semesters: Set<string>;
      searchText: string;
    }
  >();

  for (const paper of papers) {
    const name = paper.course_name?.trim();
    if (!name) continue;

    const code = (paper.actual_subject_code || paper.course_code || paper.question_paper_code || "").trim();
    const key = `${name}::${code}`;
    const current = byCourse.get(key);

    if (current) {
      if (paper.semester) {
        current.semesters.add(paper.semester);
      }
      continue;
    }

    byCourse.set(key, {
      name,
      code,
      semesters: new Set(paper.semester ? [paper.semester] : []),
      searchText: `${name} ${code}`.toLowerCase(),
    });
  }

  return Array.from(byCourse.values()).map((course) => ({
    name: course.name,
    code: course.code,
    semesters: Array.from(course.semesters).sort(),
    searchText: course.searchText,
  }));
}

export function filterPapersForCourses(papers: Paper[], courseNames: string[]) {
  const selected = new Set(courseNames);

  return papers
    .filter((paper) => selected.has(paper.course_name))
    .sort((first, second) => {
      if (first.course_name !== second.course_name) {
        return first.course_name.localeCompare(second.course_name);
      }

      const firstYear = Number(first.exam_year || 0);
      const secondYear = Number(second.exam_year || 0);
      if (firstYear !== secondYear) {
        return secondYear - firstYear;
      }

      return (first.exam_month || "").localeCompare(second.exam_month || "");
    });
}
