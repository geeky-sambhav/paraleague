(function startContentController() {
  "use strict";

  const shared = globalThis.FlagAutofillShared;
  const adapter = globalThis.FlagEta9035Adapter;
  const engine = globalThis.FlagAutofillEngine;
  let processing = false;

  function stateMessage(type, payload = {}) {
    return chrome.runtime.sendMessage({ type, ...payload });
  }

  async function readStoredState() {
    const response = await stateMessage("FLAG_STATE_GET");
    if (!response || !response.ok) throw new Error(response && response.error || "Unable to read extension state.");
    return response;
  }

  async function saveRun(run) {
    run.updatedAt = new Date().toISOString();
    const response = await stateMessage("FLAG_STATE_SAVE", { run });
    if (!response || !response.ok) throw new Error(response && response.error || "Unable to save extension state.");
  }

  async function finishRun(run) {
    const report = { ...shared.buildReport(run), portalErrors: run.portalErrors || [] };
    const response = await stateMessage("FLAG_STATE_FINISH", { report });
    if (!response || !response.ok) throw new Error(response && response.error || "Unable to save the final report.");
    updateBadge(run);
  }

  function badgeHost() {
    let host = document.getElementById("flag-eta9035-autofill-status");
    if (!host) {
      host = document.createElement("div");
      host.id = "flag-eta9035-autofill-status";
      host.style.cssText = "all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          .card{width:280px;border:1px solid #aeb8c8;border-left:5px solid #086aa8;border-radius:8px;padding:11px 13px;background:#fff;color:#172235;box-shadow:0 7px 28px rgba(22,34,53,.22);font:13px/1.35 system-ui,sans-serif}
          .title{margin:0 0 3px;font-weight:800}.message{margin:0;color:#526176}.blocked{border-left-color:#a71919}.completed{border-left-color:#287a42}
        </style>
        <div class="card"><p class="title"></p><p class="message"></p></div>`;
      document.documentElement.appendChild(host);
    }
    return host;
  }

  function updateBadge(state) {
    const host = badgeHost();
    const card = host.shadowRoot.querySelector(".card");
    card.className = `card ${state.status || ""}`;
    host.shadowRoot.querySelector(".title").textContent = `FLAG Autofill: ${state.status || "running"}`;
    host.shadowRoot.querySelector(".message").textContent = state.message || "Working on this section.";
  }

  function removeBadge() {
    const host = document.getElementById("flag-eta9035-autofill-status");
    if (host) host.remove();
  }

  async function complete(run, message) {
    shared.finalizePending(run, "not_found", "Question was not found before the final review page.");
    run.status = "completed";
    run.phase = "complete";
    run.message = message;
    run.completedAt = new Date().toISOString();
    await finishRun(run);
  }

  async function block(run, message, errors = []) {
    run.status = "blocked";
    run.phase = "blocked";
    run.message = message;
    run.portalErrors = errors;
    const section = adapter.detectSection(document);

    const portalMessagesByQuestion = new Map();
    for (const error of errors) {
      for (const key of shared.extractQuestionIds(error)) {
        if (!portalMessagesByQuestion.has(key)) portalMessagesByQuestion.set(key, error);
      }
    }
    for (const [key, error] of portalMessagesByQuestion) {
      const result = run.results[key];
      if (!result || ["skipped_blank", "unsupported_value"].includes(result.status)) continue;
      shared.updateResult(run, key, {
        status: "blocked_by_portal",
        section: section.title,
        message: error
      });
    }

    for (const [key, result] of Object.entries(run.results)) {
      if (result.status === "pending" && section.code && key.startsWith(`${section.code}.`)) {
        shared.updateResult(run, key, {
          status: "blocked_by_portal",
          section: section.title,
          message: "The portal blocked navigation from this section."
        });
      }
    }
    await saveRun(run);
    updateBadge(run);
  }

  async function completeFromFinalPage(run) {
    if (!run.currentSection) {
      await block(
        run,
        "A final-page signal was detected before any form section was processed. Export an Inspect Section diagnostic before resuming."
      );
      return;
    }
    await complete(run, "Reached the final review/sign-and-submit page and stopped without submitting.");
  }

  async function seekFirstSection(run) {
    if (adapter.isFirstSection(document)) {
      run.phase = "fill_sections";
      run.status = "running";
      run.navigationAttempts = 0;
      run.message = "First section found. Filling answers.";
      await saveRun(run);
      return true;
    }

    const firstSection = adapter.findFirstSectionNavigation(document);
    if (!firstSection) {
      await block(run, "Could not locate the first ETA-9035 section. Export an Inspect Section diagnostic for selector tuning.");
      return false;
    }
    if ((run.navigationAttempts || 0) >= 3) {
      await block(run, "The first-section navigation did not reach section A after three attempts.");
      return false;
    }

    const previousSignature = adapter.pageSignature(document);
    run.status = "navigating";
    run.phase = "seek_first_section";
    run.navigationAttempts = (run.navigationAttempts || 0) + 1;
    run.message = "Navigating to the first section.";
    await saveRun(run);
    updateBadge(run);
    engine.safeNavigationClick(firstSection);
    const changed = await engine.waitForUsablePage(document, { previousSignature, timeoutMs: 7000 });
    if (changed.ready && changed.changed) return true;
    if (adapter.isFirstSection(document)) return true;
    await block(
      run,
      changed.kind === "unrelated"
        ? "The portal did not reach a recognized ETA-9035 section."
        : "The portal did not navigate to the first section.",
      changed.errors || engine.portalErrors(document)
    );
    return false;
  }

  async function processCurrentSection(run) {
    if (adapter.isFinalPage(document)) {
      await completeFromFinalPage(run);
      return false;
    }

    const signature = adapter.pageSignature(document);
    const seen = run.processedSignatures[signature] || 0;
    if (seen >= 3) {
      await block(run, "Stopped to prevent a navigation loop on the same section.", engine.portalErrors(document));
      return false;
    }
    run.processedSignatures[signature] = seen + 1;
    run.status = "running";
    run.phase = "fill_sections";
    run.message = "Filling the visible section.";
    await saveRun(run);
    updateBadge(run);

    await engine.fillVisibleSection(document, run);
    await saveRun(run);

    if (adapter.isFinalPage(document)) {
      await completeFromFinalPage(run);
      return false;
    }

    const continueButton = adapter.findContinue(document);
    if (!continueButton) {
      await block(run, "Could not find one unambiguous Continue button. No other action was clicked.", engine.portalErrors(document));
      return false;
    }

    const beforeNavigation = adapter.pageSignature(document);
    run.status = "navigating";
    run.message = "Section attempted. Continuing to the next section.";
    await saveRun(run);
    updateBadge(run);
    engine.safeNavigationClick(continueButton);

    const changed = await engine.waitForUsablePage(document, { previousSignature: beforeNavigation, timeoutMs: 9000 });
    if (changed.ready && changed.changed) return true;
    const errors = changed.errors || engine.portalErrors(document);
    await block(
      run,
      errors.length
        ? `FLAG prevented Continue: ${errors.join(" | ")}`
        : changed.kind === "unrelated"
          ? "FLAG left the ETA-9035 form without reaching a recognized section."
          : "FLAG did not navigate after Continue.",
      errors
    );
    return false;
  }

  async function orchestrate() {
    if (processing) return;
    processing = true;
    try {
      const { run } = await readStoredState();
      if (!run || !["starting", "running", "navigating"].includes(run.status)) return;
      updateBadge(run);

      const page = await engine.waitForUsablePage(document, { timeoutMs: 9000 });
      if (page.kind === "final" && page.ready) {
        await completeFromFinalPage(run);
        return;
      }
      if (!page.ready || page.kind !== "form") {
        await block(
          run,
          "This page did not settle on a recognized authenticated ETA-9035/9035E form section.",
          page.errors || engine.portalErrors(document)
        );
        return;
      }

      if (run.phase === "seek_first_section") {
        const ready = await seekFirstSection(run);
        if (!ready) return;
        if (!adapter.isFirstSection(document)) {
          processing = false;
          await engine.delay(200);
          return orchestrate();
        }
        run.phase = "fill_sections";
        run.status = "running";
        await saveRun(run);
      }

      const continueInSameDocument = await processCurrentSection(run);
      if (continueInSameDocument) {
        processing = false;
        await engine.delay(150);
        return orchestrate();
      }
    } catch (error) {
      try {
        const { run } = await readStoredState();
        if (run) await block(run, `Autofill stopped safely: ${error.message}`);
      } catch {
        // The popup can still clear session state if state reporting itself failed.
      }
    } finally {
      processing = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !String(message.type || "").startsWith("FLAG_COMMAND_")) return false;
    (async () => {
      switch (message.type) {
        case "FLAG_COMMAND_RUN":
          sendResponse({ ok: true });
          orchestrate();
          break;
        case "FLAG_COMMAND_RESUME": {
          const { run } = await readStoredState();
          if (!run) throw new Error("No blocked run is available to resume.");
          run.status = "running";
          run.phase = "fill_sections";
          run.portalErrors = [];
          run.message = "Resuming after manual correction.";
          await saveRun(run);
          sendResponse({ ok: true });
          orchestrate();
          break;
        }
        case "FLAG_COMMAND_STOP":
          await stateMessage("FLAG_STATE_CLEAR");
          removeBadge();
          sendResponse({ ok: true });
          break;
        case "FLAG_COMMAND_INSPECT":
          sendResponse({ ok: true, diagnostic: adapter.inspectDocument(document) });
          break;
        default:
          sendResponse({ ok: false, error: "Unknown content command." });
      }
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  engine.delay(350).then(async () => {
    try {
      const { run } = await readStoredState();
      if (run && ["starting", "running", "navigating"].includes(run.status)) await orchestrate();
    } catch {
      // The popup reports state-access errors; do not disturb the portal page.
    }
  });
})();
