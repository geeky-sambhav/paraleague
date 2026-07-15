const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const adapter = require("../extension/eta9035-adapter.js");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/eta9035-section.html"), "utf8");
const suppliedA1Form = fs.readFileSync(path.join(__dirname, "..", "form"), "utf8");

function documentFor(html = fixture) {
  return new JSDOM(html, { url: "https://flag.dol.gov/case/123456789/edit", pretendToBeVisual: true }).window.document;
}

test("recognizes the ETA-9035 form and discovers question groups", () => {
  const document = documentFor();
  assert.equal(adapter.isEta9035Document(document), true);
  const groups = adapter.discoverFieldGroups(document);
  assert.ok(groups.some((group) => group.key === "A.1"));
  assert.ok(groups.some((group) => group.key === "B.2/B.3"));
  assert.equal(adapter.isFirstSection(document), true);
});

test("diagnostic export excludes entered field values and sanitizes route identifiers", () => {
  const document = documentFor();
  document.getElementById("job-title").value = "PRIVATE EMPLOYER VALUE";
  const inspection = adapter.inspectDocument(document);
  const serialized = JSON.stringify(inspection);
  assert.equal(serialized.includes("PRIVATE EMPLOYER VALUE"), false);
  assert.equal(inspection.page.urlPattern, "https://flag.dol.gov/case/:id/edit");
  assert.ok(inspection.fields.some((field) => field.questionIds.includes("B.1")));
});

test("diagnostic export excludes contenteditable answer text", () => {
  const document = documentFor(`<!doctype html><title>ETA-9035E</title><main>
    <h1>Labor Condition Application for Nonimmigrant Workers</h1>
    <div><label id="label">C.1. Employer name</label><div role="textbox" contenteditable="true" aria-labelledby="label">PRIVATE EDITABLE VALUE</div></div>
  </main>`);
  const serialized = JSON.stringify(adapter.inspectDocument(document));
  assert.equal(serialized.includes("PRIVATE EDITABLE VALUE"), false);
  assert.equal(serialized.includes("C.1. Employer name"), true);
});

test("finds Continue while protecting final actions", () => {
  const document = documentFor();
  assert.equal(adapter.findContinue(document).id, "continue");
  const saveQuit = Array.from(document.querySelectorAll("button")).find((button) => button.textContent.includes("Save"));
  assert.equal(adapter.isDeniedAction(saveQuit), true);

  document.querySelector("main").innerHTML = "<h1>Review and Submit</h1><button>Submit</button>";
  assert.equal(adapter.isFinalPage(document), true);
});

test("does not treat page-shell final actions as application final-page signals", () => {
  const document = documentFor("<!doctype html><title>Form ETA-9035E</title><body><header><button type='button'>File</button><h2 hidden>Review and Submit</h2></header><main><form><h1>Employment-Based Nonimmigrant Visa Information</h1><section><label for='a1_visa_type'><span>A.1. </span><span>Indicate the type of visa classification supported by this application</span></label><div><input type='radio' name='a1_visa_type' id='a1_visa_type_H-1B' value='H-1B'><label for='a1_visa_type_H-1B'><span>H-1B</span></label></div></section><button type='button'>Continue</button></form></main></body>");

  assert.equal(adapter.isEta9035Document(document), true);
  assert.equal(adapter.isFirstSection(document), true);
  assert.equal(adapter.isFinalPage(document), false);
  assert.equal(adapter.findContinue(document).textContent, "Continue");
});

test("distinguishes a review summary containing A.1 from the first section", () => {
  const document = documentFor("<!doctype html><title>Form ETA-9035E</title><body><aside><nav><button>A Employment-Based Nonimmigrant Visa Information</button></nav></aside><main><form><h1>Review and Submit</h1><label for='summary-a1'>A.1. Visa classification</label><input id='summary-a1' readonly><button type='button'>Submit</button></form></main></body>");

  assert.equal(adapter.isFinalPage(document), true);
  assert.equal(adapter.isFirstSection(document), false);
  assert.equal(adapter.actionText(adapter.findFirstSectionNavigation(document)), "A Employment-Based Nonimmigrant Visa Information");
});

test("inspection reports only application-scoped final-page evidence", () => {
  const document = documentFor("<!doctype html><title>Form ETA-9035E</title><body><button>File</button><main><form><h1>Review and Submit</h1><label for='a1'>A.1. Visa</label><input id='a1'><button>Submit</button></form></main></body>");
  const inspection = adapter.inspectDocument(document);
  assert.equal(inspection.page.finalPageDetected, true);
  assert.deepEqual(inspection.page.finalPageSignals.headings, ["Review and Submit"]);
  assert.deepEqual(inspection.page.finalPageSignals.actions, ["Submit"]);
});

test("recognizes the supplied FLAG A.1 validation form and ignores the global New Application tab", () => {
  const document = documentFor(`<!doctype html><title>Form ETA-9035E</title><body>
    <div class="active" role="tab">New Application</div>${suppliedA1Form}</body>`);

  assert.equal(adapter.classifyDocument(document).kind, "form");
  assert.equal(adapter.isFirstSection(document), true);
  assert.deepEqual(adapter.detectSection(document), { code: "A", title: "Section A" });
  assert.ok(adapter.discoverFieldGroups(document).some((group) => group.key === "A.1"));
});

test("classifies a control-free review page as final before form recognition", () => {
  const document = documentFor(`<!doctype html><title>Form ETA-9035E</title><body><main><form>
    <h1>Review and Submit</h1><button type="button">Sign and Submit</button>
  </form></main></body>`);

  assert.equal(adapter.isEta9035Document(document), false);
  assert.equal(adapter.classifyDocument(document).kind, "final");
});
