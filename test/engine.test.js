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

test("fills the live-shaped B.2/B.3 React autosuggest from separate answer keys", async () => {
  const html = `<!doctype html><title>Form ETA-9035E</title><main>
    <h1>Temporary Need Information</h1><div class="usa-form-group">
      <label for="b2_soc_code">B.2/B.3. SOC (ONET/OES) Code and Occupation Title</label>
      <div id="soc-root" role="combobox" aria-owns="react-autowhatever-1" aria-expanded="false">
        <input id="soc" aria-autocomplete="list" aria-controls="react-autowhatever-1">
        <div id="react-autowhatever-1" role="listbox"></div>
      </div>
    </div>
  </main>`;
  const dom = new JSDOM(html, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  const input = document.getElementById("soc");
  const root = document.getElementById("soc-root");
  const list = document.getElementById("react-autowhatever-1");
  input.addEventListener("input", () => {
    root.setAttribute("aria-expanded", "true");
    list.innerHTML = `<ul><li role="option">15-1251.00 —— Computer Programmers</li>
      <li role="option">15-1252.00 —— Software Developers</li></ul>`;
    for (const option of list.querySelectorAll("[role='option']")) {
      option.addEventListener("click", () => {
        input.value = option.textContent.trim();
        option.setAttribute("aria-selected", "true");
        root.setAttribute("aria-expanded", "false");
      });
    }
  });
  const state = shared.createRunState({ "B.2": "15-1252.00", "B.3": "Software Developers" });

  await engine.fillVisibleSection(document, state, {
    optionTimeoutMs: 60, settleMs: 1, verifyIntervalMs: 2, verifyTimeoutMs: 20, verifyPolls: 2,
    betweenFieldsMs: 1, conditionalWaitMs: 1
  });

  assert.equal(input.value, "15-1252.00 —— Software Developers");
  assert.equal(state.results["B.2"].status, "filled");
  assert.equal(state.results["B.3"].status, "filled");
});

test("selects a unique live NAICS suggestion by its exact leading code", async () => {
  const html = `<!doctype html><title>Form ETA-9035E</title><main>
    <h1>Employer Information</h1><div><label>C.13. NAICS Code</label>
      <div role="combobox" aria-expanded="false"><input id="naics" aria-autocomplete="list" aria-controls="naics-list"><div id="naics-list" role="listbox"></div></div>
    </div>
  </main>`;
  const dom = new JSDOM(html, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  const input = document.getElementById("naics");
  const list = document.getElementById("naics-list");
  input.addEventListener("input", () => {
    list.innerHTML = '<div role="option">541511 — Custom Computer Programming Services</div>';
    list.firstElementChild.addEventListener("click", () => {
      input.value = list.firstElementChild.textContent;
      list.firstElementChild.setAttribute("aria-selected", "true");
    });
  });
  const state = shared.createRunState({ "C.13": "541511" });

  await engine.fillVisibleSection(document, state, {
    optionTimeoutMs: 60, settleMs: 1, verifyIntervalMs: 2, verifyTimeoutMs: 20, verifyPolls: 2,
    betweenFieldsMs: 1, conditionalWaitMs: 1
  });

  assert.equal(input.value, "541511 — Custom Computer Programming Services");
  assert.equal(state.results["C.13"].status, "filled");
});

test("verifies FLAG-formatted telephone and currency values semantically", async () => {
  const html = `<!doctype html><title>Form ETA-9035E</title><main><h1>Employer Information</h1>
    <div><label for="phone">C.10. Telephone Number</label><input id="phone" type="tel"></div>
    <div><label for="wage">F.11. Prevailing Wage</label><input id="wage" name="_section_f_f11_prevailing_wage" inputmode="numeric" placeholder="$nnnnnnnnnn.nn"></div>
  </main>`;
  const dom = new JSDOM(html, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  document.getElementById("phone").addEventListener("input", (event) => { event.target.value = "(555) 123-4567"; });
  document.getElementById("wage").addEventListener("input", (event) => { event.target.value = "$165,000.00"; });
  const state = shared.createRunState({ "C.10": "5551234567", "F.11": "165000" });

  await engine.fillVisibleSection(document, state, {
    verifyIntervalMs: 2, verifyTimeoutMs: 20, verifyPolls: 2, betweenFieldsMs: 1, conditionalWaitMs: 1
  });

  assert.equal(state.results["C.10"].status, "filled");
  assert.equal(state.results["F.11"].status, "filled");
});

test("normalizes portal aliases and waits for enabled dependent choices", async () => {
  const html = `<!doctype html><title>Form ETA-9035E</title><main><h1>Employment and Wage Information</h1>
    <div><label>F.10. Wage Rate</label><input id="amount" name="_section_f_f10_nonimmigrant_wage_from"></div>
    <fieldset><legend>F.10a. Per</legend>
      <label><input type="radio" name="period" value="Hour" disabled>Hour</label>
      <label><input id="year" type="radio" name="period" value="Year" disabled>Year</label>
    </fieldset>
    <fieldset><legend>G.1. Agreement</legend><label><input id="agree" type="radio" name="agreement" value="YES">Yes</label><label><input type="radio" name="agreement" value="NO">No</label></fieldset>
    <fieldset><legend>H.1. Dependent</legend><label><input id="dependent" type="radio" name="dependent" value="YES">Yes</label><label><input type="radio" name="dependent" value="NO">No</label></fieldset>
  </main>`;
  const dom = new JSDOM(html, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  document.getElementById("amount").addEventListener("input", () => {
    for (const radio of document.querySelectorAll("input[name='period']")) radio.disabled = false;
  });
  const state = shared.createRunState({ "F.10": "180000", "F.10a": "Yearly", "G.1": "Yes_4", "H.1": "/On" });

  await engine.fillVisibleSection(document, state, {
    verifyIntervalMs: 2, verifyTimeoutMs: 20, verifyPolls: 2, betweenFieldsMs: 1, conditionalWaitMs: 1
  });

  assert.equal(document.getElementById("year").checked, true);
  assert.equal(document.getElementById("agree").checked, true);
  assert.equal(document.getElementById("dependent").checked, true);
  for (const key of ["F.10", "F.10A", "G.1", "H.1"]) assert.equal(state.results[key].status, "filled", key);
});

test("reports live radio choices for invalid source values", async () => {
  const html = `<!doctype html><title>Form ETA-9035E</title><main><h1>Attorney Information</h1>
    <fieldset><legend>E.1. Representation</legend>
      <label><input type="radio" name="represented" value="Attorney">Attorney</label>
      <label><input type="radio" name="represented" value="Agent">Agent</label>
      <label><input type="radio" name="represented" value="None">None</label>
    </fieldset>
  </main>`;
  const dom = new JSDOM(html, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const state = shared.createRunState({ "E.1": "Yes" });

  await engine.fillVisibleSection(dom.window.document, state, { betweenFieldsMs: 1, conditionalWaitMs: 1 });

  assert.equal(state.results["E.1"].status, "option_not_found");
  assert.match(state.results["E.1"].message, /Attorney, Agent, None/);
});

test("adds and verifies exactly one place-of-employment row", async () => {
  const html = `<!doctype html><title>Form ETA-9035E</title><main><form><h1>Employment and Wage Information</h1>
    <button id="add" type="button">Add Place of Employment</button><button id="clear" type="button">Clear Form</button>
    <h3 id="count">0 Entries for Place of Employment</h3><table><tbody></tbody></table>
  </form></main>`;
  const dom = new JSDOM(html, { url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true });
  const { document } = dom.window;
  let clicks = 0;
  document.getElementById("add").addEventListener("click", () => {
    clicks += 1;
    document.getElementById("count").textContent = "1 Entry for Place of Employment";
    document.querySelector("tbody").innerHTML = "<tr><td>1</td></tr>";
  });

  const outcome = await engine.commitPlaceOfEmployment(document, document.getElementById("add"), {
    actionTimeoutMs: 30, actionPollMs: 1
  });

  assert.equal(outcome.status, "filled");
  assert.equal(outcome.before, 0);
  assert.equal(outcome.after, 1);
  assert.equal(clicks, 1);
  assert.throws(() => engine.safeNavigationClick(document.getElementById("clear")), /Refused/);
});

test("extracts individual field-level portal errors", () => {
  const html = `<!doctype html><main><div class="form-level-error" role="alert"><ul>
    <li>Field D.1: This field is required.</li><li>Field D.2: This field is required.</li>
  </ul></div></main>`;
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  assert.deepEqual(engine.portalErrors(dom.window.document), [
    "Field D.1: This field is required.", "Field D.2: This field is required."
  ]);
});
