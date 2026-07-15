const test = require("node:test");
const assert = require("node:assert/strict");
const shared = require("../extension/shared.js");

test("extracts individual and combined question identifiers", () => {
  assert.deepEqual(shared.extractQuestionIds("B.2/B.3. SOC Code and Title"), ["B.2", "B.3"]);
  assert.deepEqual(shared.extractQuestionIds("B.7a. Workers"), ["B.7A"]);
});

test("parses a flat answer map without business validation", () => {
  const parsed = shared.parseFlatAnswerMap({
    " a.1 ": "H-1B",
    "B.7a": 0,
    "B.7b": false,
    "D.1": "   ",
    "D.2": null,
    "X.1": ["unsupported"]
  });

  assert.equal(parsed.answers["A.1"].text, "H-1B");
  assert.equal(parsed.answers["B.7A"].text, "0");
  assert.equal(parsed.answers["B.7B"].text, "false");
  assert.equal(parsed.results["D.1"].status, "skipped_blank");
  assert.equal(parsed.results["D.2"].status, "skipped_blank");
  assert.equal(parsed.results["X.1"].status, "unsupported_value");
});

test("rejects non-object JSON input", () => {
  assert.throws(() => shared.parseFlatAnswerMap("[]"), /flat JSON object/);
});

test("rejects exported reports and invalid question keys with actionable errors", () => {
  assert.throws(
    () => shared.parseFlatAnswerMap({ form: "ETA-9035/9035E", results: [] }),
    /exported run report/
  );
  assert.throws(() => shared.parseFlatAnswerMap({ completedAt: "2026-07-15" }), /Invalid question key/);
});

test("matches ordinary and combined options exactly after normalization", () => {
  assert.equal(shared.optionMatches("New  York", ["new york"], false), true);
  assert.equal(shared.optionMatches("New York State", ["New York"], false), false);
  assert.equal(
    shared.optionMatches("15-1252.00 — Software Developers", ["15-1252.00", "Software Developers"], true),
    true
  );
  assert.equal(
    shared.optionMatches("15-1253.00 — Software Quality Assurance Analysts", ["15-1252.00", "Software Developers"], true),
    false
  );
});
