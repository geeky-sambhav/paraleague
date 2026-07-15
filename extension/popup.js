(function startPopup() {
  "use strict";

  const shared = globalThis.FlagAutofillShared;
  const elements = {
    answers: document.getElementById("answers"),
    run: document.getElementById("run"),
    resume: document.getElementById("resume"),
    stop: document.getElementById("stop"),
    inspect: document.getElementById("inspect"),
    export: document.getElementById("export"),
    clear: document.getElementById("clear"),
    message: document.getElementById("message"),
    pill: document.getElementById("status-pill"),
    summary: document.getElementById("summary"),
    results: document.getElementById("results")
  };

  function setMessage(text, tone = "") {
    elements.message.textContent = text;
    elements.message.className = `message ${tone}`.trim();
  }

  function stateMessage(type, payload = {}) {
    return chrome.runtime.sendMessage({ type, ...payload });
  }

  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0] || !tabs[0].id) throw new Error("No active Chrome tab was found.");
    return tabs[0];
  }

  async function command(type) {
    const tab = await activeTab();
    const response = await chrome.tabs.sendMessage(tab.id, { type });
    if (!response || !response.ok) throw new Error(response && response.error || "The FLAG page did not accept the extension command.");
    return response;
  }

  function downloadJson(filename, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderResults(results) {
    const rows = Object.values(results || {}).sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey, undefined, { numeric: true }));
    if (!rows.length) {
      elements.results.className = "results empty";
      elements.results.textContent = "No field results to show.";
      return;
    }
    elements.results.className = "results";
    elements.results.replaceChildren();
    for (const result of rows) {
      const row = document.createElement("div");
      row.className = "result";
      const key = document.createElement("span");
      key.className = "key";
      key.textContent = result.key;
      const state = document.createElement("span");
      state.className = "state";
      state.textContent = result.status;
      const detail = document.createElement("span");
      detail.className = "detail";
      const answer = result.answer === null
        ? "null"
        : typeof result.answer === "object"
          ? (Array.isArray(result.answer) ? "[array]" : "{object}")
          : String(result.answer);
      detail.textContent = `${answer} · ${result.message || ""}`;
      row.append(key, state, detail);
      elements.results.appendChild(row);
    }
  }

  function resultObjectFromReport(report) {
    return Object.fromEntries((report && report.results || []).map((result) => [result.canonicalKey, result]));
  }

  function renderState(run, report) {
    const current = run || report;
    const status = current && current.status || "idle";
    elements.pill.textContent = status;
    elements.pill.className = `pill ${status}`;
    const results = run ? run.results : resultObjectFromReport(report);
    renderResults(results);

    const counts = shared.resultCounts(results);
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const filled = counts.filled || 0;
    elements.summary.textContent = total ? `${filled} filled · ${total} supplied` : "No run yet";
    elements.resume.disabled = !run || run.status !== "blocked";
    elements.stop.disabled = !run;
    elements.export.disabled = !run && !report;
    elements.run.disabled = Boolean(run && ["starting", "running", "navigating"].includes(run.status));
    if (current && current.message) setMessage(current.message, status === "error" || status === "blocked" ? "error" : status === "completed" ? "success" : "");
  }

  async function refresh() {
    const response = await stateMessage("FLAG_STATE_GET");
    if (!response || !response.ok) throw new Error(response && response.error || "Unable to read extension state.");
    renderState(response.run, response.report);
    return response;
  }

  elements.run.addEventListener("click", async () => {
    try {
      const run = shared.createRunState(elements.answers.value);
      await stateMessage("FLAG_STATE_START", { run });
      await command("FLAG_COMMAND_RUN");
      setMessage("Run started. The popup may be closed while the extension navigates.", "success");
      await refresh();
    } catch (error) {
      await stateMessage("FLAG_STATE_CLEAR").catch(() => {});
      setMessage(error.message, "error");
    }
  });

  elements.resume.addEventListener("click", async () => {
    try {
      await command("FLAG_COMMAND_RESUME");
      setMessage("Run resumed after your manual correction.", "success");
      await refresh();
    } catch (error) {
      setMessage(error.message, "error");
    }
  });

  elements.stop.addEventListener("click", async () => {
    try {
      await command("FLAG_COMMAND_STOP");
    } catch {
      await stateMessage("FLAG_STATE_CLEAR");
    }
    setMessage("Run stopped and in-memory answers cleared.");
    await refresh();
  });

  elements.clear.addEventListener("click", async () => {
    await stateMessage("FLAG_STATE_CLEAR");
    elements.answers.value = "";
    setMessage("Pasted answers, active state, and the last report were cleared.");
    await refresh();
  });

  elements.inspect.addEventListener("click", async () => {
    try {
      const response = await command("FLAG_COMMAND_INSPECT");
      const section = response.diagnostic.page.section.code || "unknown";
      downloadJson(`flag-eta9035-inspection-${section}-${Date.now()}.json`, response.diagnostic);
      setMessage("Value-free section diagnostic exported.", "success");
    } catch (error) {
      setMessage(error.message, "error");
    }
  });

  elements.export.addEventListener("click", async () => {
    try {
      const { run, report } = await refresh();
      const value = report || (run && shared.buildReport(run));
      if (!value) throw new Error("No run report is available.");
      downloadJson(`flag-eta9035-report-${Date.now()}.json`, value);
      setMessage("Local run report exported.", "success");
    } catch (error) {
      setMessage(error.message, "error");
    }
  });

  refresh().catch((error) => setMessage(error.message, "error"));
  setInterval(() => refresh().catch(() => {}), 700);
})();
