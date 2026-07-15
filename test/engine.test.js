const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const shared = require("../extension/shared.js");
const engine = require("../extension/autofill-engine.js");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/eta9035-section.html"), "utf8");
const suppliedA1Form = fs.readFileSync(path.join(__dirname, "..", "form"), "utf8");

function setup() {
  const dom = new JSDOM(fixture, { url: "https://flag.dol.gov/case/123456789/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  const combo = document.getElementById("soc");
  for (const option of document.querySelectorAll("#soc-options [role='option']")) {
    option.addEventListener("click", () => {
      for (const other of document.querySelectorAll("#soc-options [role='option']")) other.setAttribute("aria-selected", "false");
      option.setAttribute("aria-selected", "true");
      combo.value = option.textContent.trim();
      combo.setAttribute("aria-expanded", "false");
      document.getElementById("soc-options").hidden = true;
    });
  }
  return { dom, document };
}

test("fills text, radio, date, select, and combined dropdown fields", async () => {
  const { document } = setup();
  const state = shared.createRunState({
    "A.1": "H-1B",
    "B.1": "Software Engineer",
    "B.2": "15-1252.00",
    "B.3": "Software Developers",
    "B.4": "Yes",
    "B.5": "10/01/2026",
    "C.6": "New York",
    "D.1": ""
  });

  await engine.fillVisibleSection(document, state, { optionTimeoutMs: 150, settleMs: 5, betweenFieldsMs: 1, conditionalWaitMs: 1 });

  assert.equal(document.querySelector("input[name='visa']:checked").value, "h1b");
  assert.equal(document.getElementById("job-title").value, "Software Engineer");
  assert.equal(document.getElementById("soc").value, "15-1252.00 — Software Developers");
  assert.equal(document.querySelector("input[name='fulltime']:checked").value, "yes");
  assert.equal(document.getElementById("start-date").value, "2026-10-01");
  assert.equal(document.getElementById("state").value, "NY");
  assert.equal(document.getElementById("empty-target").value, "Keep me");
  for (const key of ["A.1", "B.1", "B.2", "B.3", "B.4", "B.5", "C.6"]) assert.equal(state.results[key].status, "filled", key);
  assert.equal(state.results["D.1"].status, "skipped_blank");
});

test("rejects a combined dropdown code/title mismatch without choosing an option", async () => {
  const { document } = setup();
  const state = shared.createRunState({ "B.2": "15-1252.00", "B.3": "Computer Programmers" });
  await engine.fillVisibleSection(document, state, { optionTimeoutMs: 35, settleMs: 1, betweenFieldsMs: 1, conditionalWaitMs: 1 });
  assert.equal(state.results["B.2"].status, "option_not_found");
  assert.equal(state.results["B.3"].status, "option_not_found");
  assert.equal(document.querySelector("[role='option'][aria-selected='true']"), null);
});

test("rescans and fills a conditional field revealed by another answer", async () => {
  const html = `<!doctype html><title>Form ETA-9035E</title><main>
    <h1>Labor Condition Application for Nonimmigrant Workers</h1>
    <fieldset><legend>A.1. Select visa</legend><label><input id="yes" type="radio" name="visa">H-1B</label></fieldset>
    <div id="conditional"></div>
  </main>`;
  const dom = new JSDOM(html, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  document.getElementById("yes").addEventListener("click", () => {
    document.getElementById("conditional").innerHTML = '<label for="detail">A.2. Detail</label><input id="detail">';
  });
  const state = shared.createRunState({ "A.1": "H-1B", "A.2": "Shown later" });
  await engine.fillVisibleSection(document, state, { betweenFieldsMs: 1, conditionalWaitMs: 1 });
  assert.equal(document.getElementById("detail").value, "Shown later");
  assert.equal(state.results["A.2"].status, "filled");
});

test("navigation helper refuses protected actions", () => {
  const { document } = setup();
  const buttons = Array.from(document.querySelectorAll("button"));
  const saveQuit = buttons.find((button) => button.textContent.includes("Save"));
  const continueButton = document.getElementById("continue");
  let continued = false;
  continueButton.addEventListener("click", () => { continued = true; });

  assert.throws(() => engine.safeNavigationClick(saveQuit), /Refused to click denied action/);
  engine.safeNavigationClick(continueButton);
  assert.equal(continued, true);
});

test("fills the A.1 radio markup used by the live FLAG form", async () => {
  const html = [
    "<!doctype html><title>Form ETA-9035E</title><main><form>",
    "<h1>Employment-Based Nonimmigrant Visa Information</h1>",
    "<fieldset class='usa-fieldset'><div><div class='usa-form-group'>",
    "<div><label class='usa-label' for='a1_visa_type'><span>A.1. </span><span>Indicate the type of visa classification supported by this application</span></label></div>",
    "<div><div class='usa-form-group'><div class='usa-radio'><input type='radio' name='a1_visa_type' id='a1_visa_type_H-1B' value='H-1B'><label for='a1_visa_type_H-1B'><span>H-1B</span></label></div></div>",
    "<div class='usa-form-group'><div class='usa-radio'><input type='radio' name='a1_visa_type' id='a1_visa_type_E-3' value='E-3 Australian'><label for='a1_visa_type_E-3'><span>E-3 Australian</span></label></div></div></div>",
    "</div></div></fieldset><button type='button'>Continue</button></form></main>"
  ].join("");
  const dom = new JSDOM(html, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  const state = shared.createRunState({ "A.1": "H-1B" });

  await engine.fillVisibleSection(document, state, { betweenFieldsMs: 1, conditionalWaitMs: 1 });

  assert.equal(document.getElementById("a1_visa_type_H-1B").checked, true);
  assert.equal(state.results["A.1"].status, "filled");
  assert.equal(state.results["A.1"].section, "Section A");
});

test("fills A.1 in the supplied FLAG validation form", async () => {
  const dom = new JSDOM(suppliedA1Form, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  const state = shared.createRunState({ "A.1": "H-1B" });

  await engine.fillVisibleSection(document, state, {
    verifyIntervalMs: 2, verifyTimeoutMs: 20, verifyPolls: 2,
    betweenFieldsMs: 1, conditionalWaitMs: 1
  });

  assert.equal(document.getElementById("a1_visa_type_H-1B").checked, true);
  assert.equal(state.results["A.1"].status, "filled");
});

test("retries a controlled radio after the page rolls back the first click", async () => {
  const html = `<!doctype html><title>Form ETA-9035E</title><main>
    <h1>Employment-Based Nonimmigrant Visa Information</h1>
    <fieldset><legend>A.1. Visa</legend><label><input id="h1b" type="radio" name="visa" value="H-1B">H-1B</label></fieldset>
  </main>`;
  const dom = new JSDOM(html, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  let firstClick = true;
  document.getElementById("h1b").addEventListener("click", () => {
    if (!firstClick) return;
    firstClick = false;
    setTimeout(() => { document.getElementById("h1b").checked = false; }, 1);
  });
  const state = shared.createRunState({ "A.1": "H-1B" });

  await engine.fillVisibleSection(document, state, {
    verifyIntervalMs: 5, verifyTimeoutMs: 35, verifyPolls: 2,
    betweenFieldsMs: 1, conditionalWaitMs: 1
  });

  assert.equal(document.getElementById("h1b").checked, true);
  assert.equal(state.results["A.1"].status, "filled");
});

test("uses a unique exact machine value for radio and checkbox answers", async () => {
  const html = `<!doctype html><title>Form ETA-9035E</title><main>
    <h1>Labor Condition Application for Nonimmigrant Workers</h1>
    <fieldset><legend>G.1. Employer declaration</legend>
      <label><input type="radio" name="declaration" value="Yes_4">Yes, I agree</label>
      <label><input type="radio" name="declaration" value="No_4">No, I do not agree</label>
    </fieldset>
    <fieldset><legend>H.1. Attestation</legend>
      <label><input id="attestation" type="checkbox" value="/On">I attest to this statement</label>
    </fieldset>
  </main>`;
  const dom = new JSDOM(html, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  const state = shared.createRunState({ "G.1": "Yes_4", "H.1": "/On" });

  await engine.fillVisibleSection(document, state, {
    verifyIntervalMs: 2, verifyTimeoutMs: 20, verifyPolls: 2,
    betweenFieldsMs: 1, conditionalWaitMs: 1
  });

  assert.equal(document.querySelector("input[name='declaration']:checked").value, "Yes_4");
  assert.equal(document.getElementById("attestation").checked, true);
  assert.equal(state.results["G.1"].status, "filled");
  assert.equal(state.results["H.1"].status, "filled");
});

test("rejects an ambiguous exact machine value", async () => {
  const html = `<!doctype html><title>Form ETA-9035E</title><main>
    <h1>Labor Condition Application for Nonimmigrant Workers</h1>
    <fieldset><legend>H.1. Select one attestation</legend>
      <label><input type="radio" name="attestation" value="/On">First statement</label>
      <label><input type="radio" name="attestation" value="/On">Second statement</label>
    </fieldset>
  </main>`;
  const dom = new JSDOM(html, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  const state = shared.createRunState({ "H.1": "/On" });

  await engine.fillVisibleSection(document, state, { optionTimeoutMs: 5, betweenFieldsMs: 1, conditionalWaitMs: 1 });

  assert.equal(document.querySelector("input:checked"), null);
  assert.equal(state.results["H.1"].status, "option_not_found");
});

test("splits ordered worker-count controls and a wage amount/unit composite", async () => {
  const html = `<!doctype html><title>Form ETA-9035E</title><main>
    <h1>Labor Condition Application for Nonimmigrant Workers</h1>
    <div><p>B.7. Total workers B.7a. H-1B workers B.7f. E-3 workers</p>
      <input id="total"><input id="h1b-count"><input id="e3-count">
    </div>
    <fieldset><legend>F.10/F.10a. Wage amount and unit</legend>
      <input id="wage">
      <label><input type="radio" name="wage-unit" value="Hourly">Hourly</label>
      <label><input type="radio" name="wage-unit" value="Yearly">Yearly</label>
    </fieldset>
  </main>`;
  const dom = new JSDOM(html, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  const state = shared.createRunState({
    "B.7": "1", "B.7a": "1", "B.7f": "0", "F.10": "180000", "F.10a": "Yearly"
  });

  await engine.fillVisibleSection(document, state, {
    verifyIntervalMs: 2, verifyTimeoutMs: 20, verifyPolls: 2,
    betweenFieldsMs: 1, conditionalWaitMs: 1
  });

  assert.deepEqual(
    [document.getElementById("total").value, document.getElementById("h1b-count").value, document.getElementById("e3-count").value],
    ["1", "1", "0"]
  );
  assert.equal(document.getElementById("wage").value, "180000");
  assert.equal(document.querySelector("input[name='wage-unit']:checked").value, "Yearly");
  for (const key of ["B.7", "B.7A", "B.7F", "F.10", "F.10A"]) assert.equal(state.results[key].status, "filled", key);
});

test("fills the editable part of a mixed telephone select and text group", async () => {
  const html = `<!doctype html><title>Form ETA-9035E</title><main>
    <h1>Labor Condition Application for Nonimmigrant Workers</h1>
    <div><label id="phone-label">C.10. Telephone number</label>
      <select aria-labelledby="phone-label"><option selected>+1</option><option>+44</option></select>
      <input id="phone" aria-labelledby="phone-label">
    </div>
  </main>`;
  const dom = new JSDOM(html, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  const state = shared.createRunState({ "C.10": "5551234567" });

  await engine.fillVisibleSection(document, state, {
    verifyIntervalMs: 2, verifyTimeoutMs: 20, verifyPolls: 2,
    betweenFieldsMs: 1, conditionalWaitMs: 1
  });

  assert.equal(document.getElementById("phone").value, "5551234567");
  assert.equal(document.querySelector("select").value, "+1");
  assert.equal(state.results["C.10"].status, "filled");
});

test("selects an exact datalist machine value", async () => {
  const html = `<!doctype html><title>Form ETA-9035E</title><main>
    <h1>Labor Condition Application for Nonimmigrant Workers</h1>
    <label for="naics">C.13. NAICS code</label>
    <input id="naics" role="combobox" list="naics-options">
    <datalist id="naics-options"><option value="541511">Custom Computer Programming Services</option></datalist>
  </main>`;
  const dom = new JSDOM(html, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  const state = shared.createRunState({ "C.13": "541511" });

  await engine.fillVisibleSection(document, state, {
    optionTimeoutMs: 25, settleMs: 1,
    verifyIntervalMs: 2, verifyTimeoutMs: 20, verifyPolls: 2,
    betweenFieldsMs: 1, conditionalWaitMs: 1
  });

  assert.equal(document.getElementById("naics").value, "541511");
  assert.equal(state.results["C.13"].status, "filled");
});

test("waits through an empty transition and recognizes the final page", async () => {
  const { document } = setup();
  const previousSignature = require("../extension/eta9035-adapter.js").pageSignature(document);
  document.body.replaceChildren();
  setTimeout(() => {
    document.body.innerHTML = "<main><form><h1>Review and Submit</h1><button>Submit</button></form></main>";
  }, 5);

  const result = await engine.waitForUsablePage(document, {
    previousSignature, timeoutMs: 100, pollMs: 2, stablePolls: 2
  });

  assert.equal(result.ready, true);
  assert.equal(result.kind, "final");
  assert.equal(result.changed, true);
});

test("allows navigation time before treating an existing validation message as a block", async () => {
  const dom = new JSDOM(suppliedA1Form, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  const adapter = require("../extension/eta9035-adapter.js");
  const previousSignature = adapter.pageSignature(document);
  setTimeout(() => {
    document.body.innerHTML = "<main><form><h1>Review and Submit</h1><button>Submit</button></form></main>";
  }, 5);

  const result = await engine.waitForUsablePage(document, {
    previousSignature, timeoutMs: 100, pollMs: 2, errorGraceMs: 30
  });

  assert.equal(result.kind, "final");
  assert.equal(result.changed, true);
});
