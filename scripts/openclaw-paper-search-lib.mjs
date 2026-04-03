export const MONTH_ORDER = Object.freeze({
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
});

const MONTH_ALIASES = Object.freeze({
  jan: "january",
  january: "january",
  feb: "february",
  february: "february",
  mar: "march",
  march: "march",
  apr: "april",
  april: "april",
  may: "may",
  jun: "june",
  june: "june",
  jul: "july",
  july: "july",
  aug: "august",
  august: "august",
  sep: "september",
  sept: "september",
  september: "september",
  oct: "october",
  october: "october",
  nov: "november",
  november: "november",
  dec: "december",
  december: "december",
});

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "exam",
  "for",
  "find",
  "get",
  "give",
  "i",
  "link",
  "links",
  "me",
  "need",
  "of",
  "paper",
  "papers",
  "please",
  "question",
  "questions",
  "send",
  "show",
  "the",
  "to",
  "want",
]);

const EXAM_TYPE_ALIASES = Object.freeze({
  regular: "regular",
  supplementary: "supplementary",
  supply: "supplementary",
  suppl: "supplementary",
  supplemental: "supplementary",
});

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function normalizeCourseName(name) {
  return String(name ?? "")
    .replace(/#/g, "")
    .replace(/&/g, " and ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeText(value) {
  return normalizeCourseName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCode(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
}

function tokenize(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(" ") : [];
}

function getMonthValue(month) {
  if (!month) {
    return 0;
  }

  return MONTH_ORDER[String(month).trim().toLowerCase()] ?? 0;
}

export function sortByLatestFirst(first, second) {
  const secondYear = Number(second.exam_year || 0);
  const firstYear = Number(first.exam_year || 0);
  if (secondYear !== firstYear) {
    return secondYear - firstYear;
  }

  const secondMonth = getMonthValue(second.exam_month);
  const firstMonth = getMonthValue(first.exam_month);
  if (secondMonth !== firstMonth) {
    return secondMonth - firstMonth;
  }

  const firstName = String(first.course_name || "");
  const secondName = String(second.course_name || "");
  const nameSort = firstName.localeCompare(secondName);
  if (nameSort !== 0) {
    return nameSort;
  }

  return String(first.question_paper_code || "").localeCompare(String(second.question_paper_code || ""));
}

function buildSearchText(record) {
  return normalizeText(
    [
      record.course_name,
      record.normalized_course_name,
      record.course_code,
      record.actual_subject_code,
      record.question_paper_code,
      record.semester,
      record.exam_type,
      record.exam_month,
      record.exam_year,
      record.codes.join(" "),
    ].join(" ")
  );
}

export function toOpenClawPaperRecord(paper) {
  const normalizedCourseName = normalizeCourseName(paper.course_name);
  const codes = unique([
    normalizeCode(paper.actual_subject_code),
    normalizeCode(paper.course_code),
    normalizeCode(paper.question_paper_code),
  ]);

  const record = {
    id: String(paper.id),
    course_name: normalizedCourseName,
    course_code: paper.course_code ?? null,
    actual_subject_code: paper.actual_subject_code ?? null,
    question_paper_code: paper.question_paper_code ?? null,
    semester: paper.semester ?? null,
    exam_type: paper.exam_type ?? null,
    exam_month: paper.exam_month ?? null,
    exam_year: paper.exam_year ?? null,
    download_url: String(paper.download_url),
    normalized_course_name: normalizedCourseName,
    codes,
  };

  return {
    ...record,
    search_text: buildSearchText(record),
  };
}

export function buildOpenClawIndex(sourceIndex) {
  const sourcePapers = Array.isArray(sourceIndex?.papers) ? sourceIndex.papers : [];
  const papers = sourcePapers.map(toOpenClawPaperRecord).sort(sortByLatestFirst);

  return {
    metadata: {
      generated_at: new Date().toISOString(),
      source_generated_at: sourceIndex?.metadata?.generated_at ?? null,
      source: sourceIndex?.metadata?.source ?? "unknown",
      page_url: sourceIndex?.metadata?.page_url ?? null,
      paper_count: papers.length,
      format: "openclaw-paper-index-v1",
    },
    papers,
  };
}

function extractSemesters(normalizedQuery, hintTokens) {
  const semesters = new Set();
  let match;

  const directPattern = /\bs([1-8])\b/g;
  while ((match = directPattern.exec(normalizedQuery)) !== null) {
    semesters.add(`S${match[1]}`);
    hintTokens.add(`s${match[1]}`);
  }

  const verbosePattern = /\b(?:semester|sem)\s+([1-8])\b/g;
  while ((match = verbosePattern.exec(normalizedQuery)) !== null) {
    semesters.add(`S${match[1]}`);
    hintTokens.add(match[0]);
    hintTokens.add(match[1]);
    hintTokens.add("semester");
    hintTokens.add("sem");
  }

  return semesters;
}

function extractMonths(tokens, hintTokens) {
  const months = new Set();

  for (const token of tokens) {
    const month = MONTH_ALIASES[token];
    if (!month) {
      continue;
    }

    months.add(month);
    hintTokens.add(token);
  }

  return months;
}

function extractExamTypes(tokens, hintTokens) {
  const examTypes = new Set();

  for (const token of tokens) {
    const examType = EXAM_TYPE_ALIASES[token];
    if (!examType) {
      continue;
    }

    examTypes.add(examType);
    hintTokens.add(token);
  }

  return examTypes;
}

function extractYears(tokens, hintTokens) {
  const years = new Set();

  for (const token of tokens) {
    if (!/^20\d{2}$/.test(token)) {
      continue;
    }

    years.add(Number(token));
    hintTokens.add(token);
  }

  return years;
}

export function parseQuery(rawQuery) {
  const query = String(rawQuery ?? "").trim();
  const normalized = normalizeText(query);
  const tokens = normalized ? normalized.split(" ") : [];
  const hintTokens = new Set();
  const years = extractYears(tokens, hintTokens);
  const months = extractMonths(tokens, hintTokens);
  const examTypes = extractExamTypes(tokens, hintTokens);
  const semesters = extractSemesters(normalized, hintTokens);
  const freeTextTokens = tokens.filter((token) => {
    if (!token || STOPWORDS.has(token)) {
      return false;
    }

    if (hintTokens.has(token)) {
      return false;
    }

    return true;
  });

  return {
    query,
    normalized,
    compact: normalizeCode(query),
    tokens,
    freeTextTokens,
    years,
    months,
    examTypes,
    semesters,
  };
}

function countStructuredMatches(record, parsedQuery) {
  let score = 0;

  if (parsedQuery.years.size > 0) {
    if (!parsedQuery.years.has(Number(record.exam_year || 0))) {
      return null;
    }

    score += 20;
  }

  if (parsedQuery.months.size > 0) {
    const month = String(record.exam_month || "").trim().toLowerCase();
    if (!parsedQuery.months.has(month)) {
      return null;
    }

    score += 15;
  }

  if (parsedQuery.examTypes.size > 0) {
    const examType = String(record.exam_type || "").trim().toLowerCase();
    if (!parsedQuery.examTypes.has(examType)) {
      return null;
    }

    score += 15;
  }

  if (parsedQuery.semesters.size > 0) {
    const semester = String(record.semester || "").trim().toUpperCase();
    if (!parsedQuery.semesters.has(semester)) {
      return null;
    }

    score += 15;
  }

  return score;
}

function scorePaper(record, parsedQuery) {
  const structuredScore = countStructuredMatches(record, parsedQuery);
  if (structuredScore === null) {
    return null;
  }

  const recordTokens = new Set(tokenize(record.search_text));
  const normalizedName = normalizeText(record.normalized_course_name);
  const freeTextPhrase = parsedQuery.freeTextTokens.join(" ");
  const compactCodes = new Set((record.codes || []).map((code) => normalizeCode(code)));
  let score = structuredScore;
  let hasTextSignal = false;
  let hasPhraseMatch = false;

  const questionPaperCode = normalizeCode(record.question_paper_code);
  if (parsedQuery.compact && questionPaperCode && parsedQuery.compact === questionPaperCode) {
    score += 5000;
    hasTextSignal = true;
  } else if (parsedQuery.compact && compactCodes.has(parsedQuery.compact)) {
    score += 4000;
    hasTextSignal = true;
  }

  if (freeTextPhrase) {
    if (normalizedName === freeTextPhrase) {
      score += 1000;
      hasTextSignal = true;
      hasPhraseMatch = true;
    } else if (normalizedName.includes(freeTextPhrase) || record.search_text.includes(freeTextPhrase)) {
      score += 500;
      hasTextSignal = true;
      hasPhraseMatch = true;
    }
  }

  let matchedTokens = 0;
  for (const token of parsedQuery.freeTextTokens) {
    if (recordTokens.has(token)) {
      matchedTokens += 1;
      continue;
    }

    const compactToken = normalizeCode(token);
    if (compactToken && compactCodes.has(compactToken)) {
      matchedTokens += 1;
    }
  }

  if (matchedTokens > 0) {
    const coverage = matchedTokens / parsedQuery.freeTextTokens.length;
    score += matchedTokens * 100 + Math.round(coverage * 100);
    hasTextSignal = true;

    if (!hasPhraseMatch && score < 4000) {
      if (parsedQuery.freeTextTokens.length === 2 && matchedTokens < 2) {
        return null;
      }

      if (parsedQuery.freeTextTokens.length > 2 && coverage < 0.67) {
        return null;
      }
    }
  }

  if (parsedQuery.freeTextTokens.length > 0 && !hasTextSignal) {
    return null;
  }

  if (
    parsedQuery.freeTextTokens.length === 0 &&
    parsedQuery.years.size === 0 &&
    parsedQuery.months.size === 0 &&
    parsedQuery.examTypes.size === 0 &&
    parsedQuery.semesters.size === 0 &&
    !parsedQuery.compact
  ) {
    return null;
  }

  return {
    ...record,
    _score: score,
  };
}

export function searchOpenClawIndex(index, rawQuery, options = {}) {
  const parsedQuery = parseQuery(rawQuery);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : null;
  const sourcePapers = Array.isArray(index?.papers) ? index.papers : [];
  const scoredPapers = sourcePapers
    .map((paper) => scorePaper(paper, parsedQuery))
    .filter(Boolean)
    .sort((first, second) => {
      if (second._score !== first._score) {
        return second._score - first._score;
      }

      return sortByLatestFirst(first, second);
    });

  const results = scoredPapers.map(({ _score, normalized_course_name, codes, search_text, ...paper }) => paper);
  const limitedResults = limit ? results.slice(0, limit) : results;

  return {
    status: limitedResults.length > 0 ? "ok" : "none",
    query: parsedQuery.query,
    total: results.length,
    results: limitedResults,
  };
}
