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
