"use strict";

const RUN_KEY = "flagEta9035ActiveRun";
const REPORT_KEY = "flagEta9035LastReport";

async function readState() {
  const stored = await chrome.storage.session.get([RUN_KEY, REPORT_KEY]);
  return { run: stored[RUN_KEY] || null, report: stored[REPORT_KEY] || null };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !String(message.type || "").startsWith("FLAG_STATE_")) return false;

  (async () => {
    switch (message.type) {
      case "FLAG_STATE_GET":
        sendResponse({ ok: true, ...(await readState()) });
        break;
      case "FLAG_STATE_SAVE":
        await chrome.storage.session.set({ [RUN_KEY]: message.run });
        sendResponse({ ok: true });
        break;
      case "FLAG_STATE_START":
        await chrome.storage.session.remove(REPORT_KEY);
        await chrome.storage.session.set({ [RUN_KEY]: message.run });
        sendResponse({ ok: true });
        break;
      case "FLAG_STATE_FINISH":
        await chrome.storage.session.set({ [REPORT_KEY]: message.report });
        await chrome.storage.session.remove(RUN_KEY);
        sendResponse({ ok: true });
        break;
      case "FLAG_STATE_CLEAR":
        await chrome.storage.session.remove([RUN_KEY, REPORT_KEY]);
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: "Unknown state operation." });
    }
  })().catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
