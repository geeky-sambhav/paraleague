const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM } = require("jsdom");

test("a control-free final page completes an active run without submitting", async () => {
  const dom = new JSDOM(`<!doctype html><title>Form ETA-9035E</title><body><main><form>
    <h1>Review and Submit</h1><button type="button">Sign and Submit</button>
  </form></main></body>`, {
    url: "https://flag.dol.gov/case/test/review",
    pretendToBeVisual: true
  });

  const shared = require("../extension/shared.js");
  global.document = dom.window.document;
  global.window = dom.window;
  global.FlagAutofillShared = shared;
  global.FlagEta9035Adapter = require("../extension/eta9035-adapter.js");
  global.FlagAutofillEngine = require("../extension/autofill-engine.js");

  let run = shared.createRunState({ "A.1": "H-1B", "E.2": "Kennedy" });
  run.status = "navigating";
  run.phase = "fill_sections";
  run.currentSection = "Section K";
  shared.updateResult(run, "A.1", { status: "filled", section: "Section A", message: "Filled." });
  let report = null;
  let commandListener = null;

  global.chrome = {
    runtime: {
      onMessage: { addListener(listener) { commandListener = listener; } },
      async sendMessage(message) {
        if (message.type === "FLAG_STATE_GET") return { ok: true, run, report };
        if (message.type === "FLAG_STATE_SAVE") {
          run = message.run;
          return { ok: true };
        }
        if (message.type === "FLAG_STATE_FINISH") {
          report = message.report;
          run = null;
          return { ok: true };
        }
        throw new Error(`Unexpected message: ${message.type}`);
      }
    }
  };

  const contentPath = path.join(__dirname, "..", "extension", "content.js");
  delete require.cache[require.resolve(contentPath)];
  require(contentPath);
  assert.equal(typeof commandListener, "function");
  commandListener({ type: "FLAG_COMMAND_RUN" }, null, () => {});

  const deadline = Date.now() + 300;
  while (!report && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.ok(report);
  assert.equal(report.status, "completed");
  assert.match(report.message, /final review\/sign-and-submit page/);
  assert.equal(report.counts.not_found, 1);

  delete global.chrome;
  delete global.document;
  delete global.window;
  delete global.FlagAutofillShared;
  delete global.FlagEta9035Adapter;
  delete global.FlagAutofillEngine;
});

test("a required blank answer is promoted to a field-specific portal block", async () => {
  const dom = new JSDOM(`<!doctype html><title>Form ETA-9035E</title><body><main><form>
    <h1>Employment Point of Contact Information</h1>
    <div class="form-level-error" role="alert"><ul><li>Field D.1: This field is required.</li></ul></div>
    <label for="d1">D.1. Contact's Last Name</label><input id="d1">
    <button type="button">Continue</button>
  </form></main></body>`, {
    url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true
  });
  const shared = require("../extension/shared.js");
  global.document = dom.window.document;
  global.window = dom.window;
  global.FlagAutofillShared = shared;
  global.FlagEta9035Adapter = require("../extension/eta9035-adapter.js");
  global.FlagAutofillEngine = require("../extension/autofill-engine.js");

  let run = shared.createRunState({ "D.1": "" });
  run.status = "running";
  run.phase = "fill_sections";
  let commandListener = null;
  global.chrome = {
    runtime: {
      onMessage: { addListener(listener) { commandListener = listener; } },
      async sendMessage(message) {
        if (message.type === "FLAG_STATE_GET") return { ok: true, run, report: null };
        if (message.type === "FLAG_STATE_SAVE") { run = message.run; return { ok: true }; }
        throw new Error(`Unexpected message: ${message.type}`);
      }
    }
  };

  const contentPath = path.join(__dirname, "..", "extension", "content.js");
  delete require.cache[require.resolve(contentPath)];
  require(contentPath);
  commandListener({ type: "FLAG_COMMAND_RUN" }, null, () => {});

  const deadline = Date.now() + 1800;
  while (run.status !== "blocked" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(run.status, "blocked");
  assert.equal(run.results["D.1"].status, "blocked_by_portal");
  assert.equal(run.results["D.1"].message, "Field D.1: This field is required.");

  delete global.chrome;
  delete global.document;
  delete global.window;
  delete global.FlagAutofillShared;
  delete global.FlagEta9035Adapter;
  delete global.FlagAutofillEngine;
});

test("Section F adds one verified row before continuing", async () => {
  const dom = new JSDOM(`<!doctype html><title>Form ETA-9035E</title><body><main><form>
    <h1>Employment and Wage Information</h1>
    <label for="f1">F.1. Workers</label><input id="f1" name="_section_f_f1_number_workers">
    <button id="add" type="button">Add Place of Employment</button>
    <h3 id="count">0 Entries for Place of Employment</h3><table><tbody></tbody></table>
    <button id="continue" type="button">Continue</button>
  </form></main></body>`, {
    url: "https://flag.dol.gov/case/test/edit", pretendToBeVisual: true
  });
  const shared = require("../extension/shared.js");
  global.document = dom.window.document;
  global.window = dom.window;
  global.FlagAutofillShared = shared;
  global.FlagEta9035Adapter = require("../extension/eta9035-adapter.js");
  global.FlagAutofillEngine = require("../extension/autofill-engine.js");
  let addClicks = 0;
  let continueClicks = 0;
  document.getElementById("add").addEventListener("click", () => {
    addClicks += 1;
    document.getElementById("count").textContent = "1 Entry for Place of Employment";
    document.querySelector("tbody").innerHTML = "<tr><td>1</td></tr>";
  });
  document.getElementById("continue").addEventListener("click", () => {
    continueClicks += 1;
    document.querySelector("main").innerHTML = "<form><h1>Review and Submit</h1><button type='button'>Submit</button></form>";
  });

  let run = shared.createRunState({ "F.1": "1" });
  run.status = "running";
  run.phase = "fill_sections";
  let report = null;
  let commandListener = null;
  global.chrome = {
    runtime: {
      onMessage: { addListener(listener) { commandListener = listener; } },
      async sendMessage(message) {
        if (message.type === "FLAG_STATE_GET") return { ok: true, run, report };
        if (message.type === "FLAG_STATE_SAVE") { run = message.run; return { ok: true }; }
        if (message.type === "FLAG_STATE_FINISH") { report = message.report; run = null; return { ok: true }; }
        throw new Error(`Unexpected message: ${message.type}`);
      }
    }
  };

  const contentPath = path.join(__dirname, "..", "extension", "content.js");
  delete require.cache[require.resolve(contentPath)];
  require(contentPath);
  commandListener({ type: "FLAG_COMMAND_RUN" }, null, () => {});

  const deadline = Date.now() + 1800;
  while (!report && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.ok(report);
  assert.equal(report.status, "completed");
  assert.equal(addClicks, 1);
  assert.equal(continueClicks, 1);

  delete global.chrome;
  delete global.document;
  delete global.window;
  delete global.FlagAutofillShared;
  delete global.FlagEta9035Adapter;
  delete global.FlagAutofillEngine;
});
