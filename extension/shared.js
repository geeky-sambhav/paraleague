(function attachShared(root, factory) {
  const api = factory();
  root.FlagAutofillShared = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createShared() {
  "use strict";

  const RUN_KEY = "flagEta9035ActiveRun";
  const REPORT_KEY = "flagEta9035LastReport";
  const QUESTION_PATTERN = /\b([A-Za-z]\s*\.\s*\d+(?:\s*[A-Za-z])?)\b/g;
  const TERMINAL_STATUSES = new Set([
    "filled",
    "skipped_blank",
    "not_found",
    "option_not_found",
    "verification_failed",
    "unsupported_value",
    "blocked_by_portal"
  ]);

  function canonicalQuestionId(value) {
    const compact = String(value ?? "").replace(/\s+/g, "").toUpperCase();
    const match = compact.match(/^([A-Z])\.(\d+)([A-Z]?)$/);
    return match ? `${match[1]}.${match[2]}${match[3]}` : compact;
  }

  function extractQuestionIds(text) {
    const found = [];
    const seen = new Set();
    for (const match of String(text ?? "").matchAll(QUESTION_PATTERN)) {
      const id = canonicalQuestionId(match[1]);
      if (!seen.has(id)) {
        seen.add(id);
        found.push(id);
      }
    }
    return found;
  }

  function normalizeOptionText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .replace(/&/g, " and ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function exactNormalizedMatch(actual, expected) {
    const left = normalizeOptionText(actual);
    const right = normalizeOptionText(expected);
    return Boolean(left && right && left === right);
  }

  function containsNormalized(actual, expected) {
    const haystack = normalizeOptionText(actual);
    const needle = normalizeOptionText(expected);
    if (!haystack || !needle) return false;
    return ` ${haystack} `.includes(` ${needle} `);
  }

  function optionMatches(optionText, expectedTexts, combined) {
    const expected = expectedTexts.map(normalizeOptionText).filter(Boolean);
    if (!expected.length) return false;
    if (!combined && expected.length === 1) return normalizeOptionText(optionText) === expected[0];
    return expected.every((answer) => containsNormalized(optionText, answer));
  }

  function isBlankAnswer(value) {
    return value === null || (typeof value === "string" && value.trim() === "");
  }

  function parseFlatAnswerMap(jsonOrObject) {
    const parsed = typeof jsonOrObject === "string" ? JSON.parse(jsonOrObject) : jsonOrObject;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Answers must be one flat JSON object.");
    }
    if (Array.isArray(parsed.results) && parsed.form === "ETA-9035/9035E") {
      throw new Error("This JSON is an exported run report. Paste a flat object whose keys are question IDs such as A.1 and B.7a.");
    }

    const answers = {};
    const results = {};
    for (const [originalKey, rawValue] of Object.entries(parsed)) {
      const key = canonicalQuestionId(originalKey);
      if (!/^[A-Z]\.\d+[A-Z]?$/.test(key)) {
        throw new Error("Invalid question key \"" + originalKey + "\". Expected a key such as A.1 or B.7a.");
      }
      const base = {
        key: originalKey.trim() || originalKey,
        canonicalKey: key,
        answer: rawValue,
        section: null,
        message: "Waiting to find this question."
      };

      if (isBlankAnswer(rawValue)) {
        results[key] = { ...base, status: "skipped_blank", message: "Blank answer skipped." };
        continue;
      }
      if (typeof rawValue === "object") {
        results[key] = {
          ...base,
          status: "unsupported_value",
          message: "Arrays and nested objects are not supported by the flat-answer MVP."
        };
        continue;
      }

      answers[key] = { key, originalKey: base.key, raw: rawValue, text: String(rawValue) };
      results[key] = { ...base, status: "pending" };
    }
    return { answers, results };
  }

  function createRunState(jsonOrObject) {
    const { answers, results } = parseFlatAnswerMap(jsonOrObject);
    return {
      version: 1,
      form: "ETA-9035/9035E",
      status: "starting",
      phase: "seek_first_section",
      message: "Preparing to start from the first section.",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentSection: null,
      navigationAttempts: 0,
      processedSignatures: {},
      answers,
      results
    };
  }

  function updateResult(state, canonicalKey, patch) {
    if (!state.results[canonicalKey]) return;
    state.results[canonicalKey] = { ...state.results[canonicalKey], ...patch };
    state.updatedAt = new Date().toISOString();
  }

  function finalizePending(state, status, message) {
    for (const [key, result] of Object.entries(state.results)) {
      if (result.status === "pending") updateResult(state, key, { status, message });
    }
    return state;
  }

  function resultCounts(results) {
    const counts = {};
    for (const result of Object.values(results || {})) {
      counts[result.status] = (counts[result.status] || 0) + 1;
    }
    return counts;
  }

  function buildReport(state) {
    return {
      version: state.version,
      form: state.form,
      status: state.status,
      message: state.message,
      startedAt: state.startedAt,
      completedAt: state.completedAt || null,
      currentSection: state.currentSection,
      counts: resultCounts(state.results),
      results: Object.values(state.results)
    };
  }

  return {
    RUN_KEY,
    REPORT_KEY,
    TERMINAL_STATUSES,
    canonicalQuestionId,
    extractQuestionIds,
    normalizeOptionText,
    exactNormalizedMatch,
    containsNormalized,
    optionMatches,
    isBlankAnswer,
    parseFlatAnswerMap,
    createRunState,
    updateResult,
    finalizePending,
    resultCounts,
    buildReport
  };
});
