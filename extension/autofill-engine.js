(function attachEngine(root, factory) {
  const shared = root.FlagAutofillShared || (typeof require === "function" ? require("./shared.js") : null);
  const adapter = root.FlagEta9035Adapter || (typeof require === "function" ? require("./eta9035-adapter.js") : null);
  const api = factory(shared, adapter);
  root.FlagAutofillEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createEngine(shared, adapter) {
  "use strict";

  const TRUE_VALUES = new Set(["true", "yes", "y", "checked", "1"]);
  const FALSE_VALUES = new Set(["false", "no", "n", "unchecked", "0"]);

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function windowFor(element) {
    return element.ownerDocument.defaultView || globalThis;
  }

  function setNativeProperty(element, property, value) {
    const win = windowFor(element);
    const prototypes = [];
    if (element.tagName === "INPUT" && win.HTMLInputElement) prototypes.push(win.HTMLInputElement.prototype);
    if (element.tagName === "TEXTAREA" && win.HTMLTextAreaElement) prototypes.push(win.HTMLTextAreaElement.prototype);
    if (element.tagName === "SELECT" && win.HTMLSelectElement) prototypes.push(win.HTMLSelectElement.prototype);
    prototypes.push(Object.getPrototypeOf(element));
    const descriptor = prototypes.map((prototype) => prototype && Object.getOwnPropertyDescriptor(prototype, property))
      .find((item) => item && item.set);
    if (descriptor) descriptor.set.call(element, value);
    else element[property] = value;
  }

  function fireValueEvents(element) {
    const win = windowFor(element);
    element.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new win.Event("change", { bubbles: true, composed: true }));
  }

  function blurElement(element) {
    const win = windowFor(element);
    if (typeof element.blur === "function") element.blur();
    element.dispatchEvent(new win.Event("blur", { bubbles: false, composed: true }));
  }

  function clickElement(element) {
    const win = windowFor(element);
    if (typeof element.focus === "function") element.focus();
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const EventType = type.startsWith("pointer") && win.PointerEvent ? win.PointerEvent : win.MouseEvent;
      element.dispatchEvent(new EventType(type, { bubbles: true, composed: true, button: 0 }));
    }
    if (typeof element.click === "function") element.click();
    else element.dispatchEvent(new win.MouseEvent("click", { bubbles: true, composed: true, button: 0 }));
  }

  function htmlDateValue(value) {
    const text = String(value).trim();
    const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return text;
    return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  }

  function setEditableValue(element, rawValue, options = {}) {
    const value = element.getAttribute("type") === "date" ? htmlDateValue(rawValue) : String(rawValue);
    if (element.isContentEditable) element.textContent = value;
    else setNativeProperty(element, "value", value);
    fireValueEvents(element);
    if (options.blur !== false) blurElement(element);
    return value;
  }

  function editableValue(element) {
    return element.isContentEditable ? String(element.textContent || "") : String(element.value ?? "");
  }

  function response(status, message) {
    return { status, message };
  }

  function uniqueControls(controls) {
    return [...new Set(controls)];
  }

  function controlsForEntries(group, entries, predicate = () => true) {
    const keys = new Set(entries.map((entry) => entry.key));
    const bound = uniqueControls((group.bindings || [])
      .filter((binding) => binding.questionIds.some((key) => keys.has(key)))
      .map((binding) => binding.control)
      .filter(predicate));
    return bound.length ? bound : group.controls.filter(predicate);
  }

  function exactOptionChoice(options, expected, combined = false) {
    const labelMatches = options.filter((option) => adapter.optionTexts(option)
      .some((text) => shared.optionMatches(text, expected, combined)));
    if (labelMatches.length) return { option: labelMatches.length === 1 ? labelMatches[0] : null, count: labelMatches.length };
    if (combined || expected.length !== 1) return { option: null, count: 0 };
    const valueMatches = options.filter((option) => adapter.optionValues(option)
      .some((value) => shared.exactNormalizedMatch(value, expected[0])));
    return { option: valueMatches.length === 1 ? valueMatches[0] : null, count: valueMatches.length };
  }

  function optionOrValueMatches(option, expected, combined = false) {
    return adapter.optionTexts(option).some((text) => shared.optionMatches(text, expected, combined)) ||
      (!combined && expected.length === 1 && adapter.optionValues(option)
        .some((value) => shared.exactNormalizedMatch(value, expected[0])));
  }

  async function waitForStable(predicate, options = {}) {
    const intervalMs = options.verifyIntervalMs ?? 70;
    const timeoutMs = options.verifyTimeoutMs ?? 420;
    const requiredPolls = options.verifyPolls ?? 2;
    const deadline = Date.now() + timeoutMs;
    let stablePolls = 0;
    while (Date.now() < deadline) {
      await delay(intervalMs);
      stablePolls = predicate() ? stablePolls + 1 : 0;
      if (stablePolls >= requiredPolls) return true;
    }
    return false;
  }

  function editableControls(group, entries) {
    return controlsForEntries(group, entries, (control) => {
      const type = (control.getAttribute("type") || "text").toLowerCase();
      return control.tagName !== "SELECT" && !["radio", "checkbox"].includes(type) && !adapter.looksLikeCombobox(control);
    });
  }

  async function fillText(group, entries, options = {}) {
    const controls = editableControls(group, entries);
    if (controls.length !== 1 || entries.length !== 1) {
      return response("verification_failed", "Expected one editable control for this question.");
    }
    const control = controls[0];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const expected = setEditableValue(control, entries[0].text);
      if (await waitForStable(() => editableValue(control) === expected, options)) {
        return response("filled", "Text value written and verified.");
      }
    }
    return response("verification_failed", "The page did not retain the supplied text value.");
  }

  async function fillNativeSelect(group, entries, options = {}) {
    const selects = controlsForEntries(group, entries, (control) => control.tagName === "SELECT");
    if (selects.length !== 1) return response("verification_failed", "Expected one native dropdown.");
    const select = selects[0];
    const expected = entries.map((entry) => entry.text);
    const combined = group.questionIds.length > 1 || expected.length > 1;
    const choice = exactOptionChoice(Array.from(select.options).filter((option) => !option.disabled), expected, combined);
    if (!choice.option) {
      return response("option_not_found", choice.count ? "More than one dropdown option matched." : "No exact dropdown option matched.");
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      setNativeProperty(select, "value", choice.option.value);
      fireValueEvents(select);
      blurElement(select);
      const retained = await waitForStable(() => {
        const selected = select.selectedOptions && select.selectedOptions[0];
        return Boolean(selected && optionOrValueMatches(selected, expected, combined));
      }, options);
      if (retained) return response("filled", "Native dropdown option selected and verified.");
    }
    return response("verification_failed", "The native dropdown did not retain the selected option.");
  }

  function associatedActivation(control) {
    const labels = adapter.associatedLabels(control).filter((label) => !adapter.isHidden(label));
    labels.sort((left, right) => adapter.elementText(left).length - adapter.elementText(right).length);
    return labels[0] || control;
  }

  async function retainChecked(control, checked, options = {}) {
    if (control.checked !== checked) clickElement(associatedActivation(control));
    if (await waitForStable(() => control.checked === checked, options)) return true;
    setNativeProperty(control, "checked", checked);
    fireValueEvents(control);
    blurElement(control);
    return waitForStable(() => control.checked === checked, options);
  }

  async function fillRadio(group, entries, options = {}) {
    if (entries.length !== 1) return response("verification_failed", "A radio group accepts one answer.");
    const radios = controlsForEntries(group, entries, (control) => (control.type || "").toLowerCase() === "radio");
    const choice = exactOptionChoice(radios, [entries[0].text]);
    if (!choice.option) {
      return response("option_not_found", choice.count ? "More than one radio option matched." : "No exact radio option matched.");
    }
    return await retainChecked(choice.option, true, options)
      ? response("filled", "Radio option selected and verified.")
      : response("verification_failed", "The radio option did not remain selected.");
  }

  function setChecked(control, checked) {
    setNativeProperty(control, "checked", checked);
    fireValueEvents(control);
  }

  async function fillCheckbox(group, entries, options = {}) {
    if (entries.length !== 1) return response("verification_failed", "A flat answer can target one checkbox choice.");
    const checkboxes = controlsForEntries(group, entries, (control) => (control.type || "").toLowerCase() === "checkbox");
    const normalized = shared.normalizeOptionText(entries[0].text);
    if (checkboxes.length === 1 && (TRUE_VALUES.has(normalized) || FALSE_VALUES.has(normalized))) {
      const expected = TRUE_VALUES.has(normalized);
      return await retainChecked(checkboxes[0], expected, options)
        ? response("filled", "Checkbox state written and verified.")
        : response("verification_failed", "The checkbox did not retain its state.");
    }

    const choice = exactOptionChoice(checkboxes, [entries[0].text]);
    if (!choice.option) {
      return response("option_not_found", choice.count ? "More than one checkbox option matched." : "No exact checkbox option matched.");
    }
    for (const checkbox of checkboxes) {
      if (checkbox !== choice.option && checkbox.checked) setChecked(checkbox, false);
    }
    return await retainChecked(choice.option, true, options)
      ? response("filled", "Checkbox option selected and verified.")
      : response("verification_failed", "The checkbox option did not remain selected.");
  }

  function comboboxSignals(group, control) {
    const values = [editableValue(control)];
    const container = group.container;
    if (container) {
      for (const hidden of container.querySelectorAll("input[type='hidden']")) values.push(hidden.value);
      for (const selected of container.querySelectorAll("[role='option'][aria-selected='true'],[role='option'].selected")) {
        values.push(...adapter.optionTexts(selected), ...adapter.optionValues(selected));
      }
      const selectedDisplay = container.querySelector("[data-value],.selected-value,.select-value");
      if (selectedDisplay) values.push(...adapter.optionTexts(selectedDisplay), ...adapter.optionValues(selectedDisplay));
    }
    return values.filter(Boolean);
  }

  async function waitForMatchingOption(doc, control, expected, combined, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastChoice = { option: null, count: 0 };
    while (Date.now() < deadline) {
      lastChoice = exactOptionChoice(adapter.findOpenOptions(doc, control), expected, combined);
      if (lastChoice.option || lastChoice.count > 1) return lastChoice;
      await delay(80);
    }
    return lastChoice;
  }

  async function fillCombobox(group, entries, options = {}) {
    const controls = controlsForEntries(group, entries, adapter.looksLikeCombobox);
    if (controls.length !== 1) return response("verification_failed", "Expected one searchable dropdown control.");
    const control = controls[0];
    const expected = entries.map((entry) => entry.text);
    const combined = group.questionIds.length > 1 || expected.length > 1;
    const query = expected[0];
    let ambiguous = false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      clickElement(control);
      setEditableValue(control, query, { blur: false });
      const win = windowFor(control);
      for (const type of ["keydown", "keyup"]) {
        control.dispatchEvent(new win.KeyboardEvent(type, {
          bubbles: true,
          composed: true,
          key: query.slice(-1) || "Unidentified"
        }));
      }

      const match = await waitForMatchingOption(
        control.ownerDocument, control, expected, combined, options.optionTimeoutMs || 3500
      );
      if (!match.option) {
        ambiguous = match.count > 1;
        continue;
      }

      const clickedExactOption = optionOrValueMatches(match.option, expected, combined);
      const datalistOption = match.option.tagName === "OPTION" && match.option.closest("datalist");
      if (datalistOption) {
        setEditableValue(control, match.option.value || match.option.textContent, { blur: true });
      } else {
        clickElement(match.option);
      }
      await delay(options.settleMs || 120);

      const retained = await waitForStable(() => {
        const signals = comboboxSignals(group, control);
        const signalVerified = signals.some((signal) => shared.optionMatches(signal, expected, combined) ||
          (!combined && expected.length === 1 && shared.exactNormalizedMatch(signal, expected[0])));
        const queryRetained = shared.exactNormalizedMatch(editableValue(control), query);
        const selectionClosed = control.getAttribute("aria-expanded") === "false" || !match.option.isConnected ||
          match.option.getAttribute("aria-selected") === "true" || Boolean(datalistOption);
        return signalVerified || (queryRetained && selectionClosed && clickedExactOption);
      }, options);
      if (retained) return response("filled", "Searchable dropdown option selected and verified.");
    }

    if (ambiguous) return response("option_not_found", "More than one searchable dropdown option matched.");
    return response("option_not_found", "No exact searchable dropdown option matched.");
  }

  function narrowGroupForEntry(group, entry) {
    const exactBindings = (group.bindings || []).filter((binding) =>
      binding.questionIds.length === 1 && binding.questionIds.includes(entry.key));
    if (exactBindings.length) {
      const controls = uniqueControls(exactBindings.map((binding) => binding.control));
      return { ...group, key: entry.key, questionIds: [entry.key], controls, bindings: exactBindings };
    }

    const optionControls = group.controls.filter((control) =>
      ["radio", "checkbox"].includes((control.type || "").toLowerCase()) || control.tagName === "SELECT");
    const optionChoice = exactOptionChoice(optionControls, [entry.text]);
    if (optionChoice.option) {
      const type = (optionChoice.option.type || "").toLowerCase();
      const name = optionChoice.option.getAttribute("name");
      const controls = type === "radio" && name
        ? group.controls.filter((control) => (control.type || "").toLowerCase() === "radio" && control.getAttribute("name") === name)
        : [optionChoice.option];
      return { ...group, key: entry.key, questionIds: [entry.key], controls };
    }

    const editables = editableControls(group, [entry]);
    if (editables.length === 1) {
      return { ...group, key: entry.key, questionIds: [entry.key], controls: editables };
    }
    return { ...group, key: entry.key, questionIds: [entry.key] };
  }

  async function fillFieldGroup(group, entries, options) {
    const radios = controlsForEntries(group, entries, (control) => (control.type || "").toLowerCase() === "radio");
    const checkboxes = controlsForEntries(group, entries, (control) => (control.type || "").toLowerCase() === "checkbox");
    if (entries.length === 1 && exactOptionChoice(radios, [entries[0].text]).option) return fillRadio(group, entries, options);
    if (entries.length === 1 && (exactOptionChoice(checkboxes, [entries[0].text]).option ||
        (checkboxes.length === 1 && (TRUE_VALUES.has(shared.normalizeOptionText(entries[0].text)) ||
          FALSE_VALUES.has(shared.normalizeOptionText(entries[0].text)))))) {
      return fillCheckbox(group, entries, options);
    }
    if (group.controls.some(adapter.looksLikeCombobox)) return fillCombobox(group, entries, options);
    if (editableControls(group, entries).length) return fillText(group, entries, options);
    if (group.controls.some((control) => control.tagName === "SELECT")) return fillNativeSelect(group, entries, options);
    if (radios.length) return fillRadio(group, entries, options);
    if (checkboxes.length) return fillCheckbox(group, entries, options);
    return fillText(group, entries, options);
  }

  async function fillVisibleSection(doc, state, options = {}) {
    const section = adapter.detectSection(doc);
    state.currentSection = section.title;
    let attempted = 0;

    for (let pass = 0; pass < (options.maxPasses || 5); pass += 1) {
      const groups = adapter.discoverFieldGroups(doc);
      const pendingGroups = groups.flatMap((group) => {
        const entries = group.questionIds
          .filter((key) => state.answers[key] && state.results[key] && state.results[key].status === "pending")
          .map((key) => state.answers[key]);
        if (entries.length <= 1 || (entries.length > 1 && group.controls.filter(adapter.looksLikeCombobox).length === 1)) {
          return entries.length ? [{ group: entries.length === 1 ? narrowGroupForEntry(group, entries[0]) : group, entries }] : [];
        }
        return entries.map((entry) => ({ group: narrowGroupForEntry(group, entry), entries: [entry] }));
      });
      if (!pendingGroups.length) break;

      for (const { group, entries } of pendingGroups) {
        let outcome;
        try {
          outcome = await fillFieldGroup(group, entries, options);
        } catch (error) {
          outcome = response("verification_failed", `Control interaction failed: ${error.message}`);
        }
        for (const entry of entries) {
          shared.updateResult(state, entry.key, {
            status: outcome.status,
            section: section.title,
            message: outcome.message
          });
        }
        attempted += entries.length;
        await delay(options.betweenFieldsMs ?? options.afterFieldMs ?? 70);
      }
      await delay(options.conditionalWaitMs || 160);
    }
    return { state, attempted, section };
  }

  function portalErrors(doc) {
    const selector = "[role='alert'],.usa-error-message,.error-message,.form-level-error,[class*='field-error'],[class*='validation-error']";
    return [...new Set(Array.from(doc.querySelectorAll(selector))
      .filter((element) => !adapter.isHidden(element))
      .map((element) => adapter.safeText(element.innerText || element.textContent, 300))
      .filter(Boolean))].slice(0, 20);
  }

  async function waitForUsablePage(doc, options = {}) {
    const timeoutMs = options.timeoutMs || 8000;
    const previousSignature = options.previousSignature || null;
    const stablePollsRequired = options.stablePolls || 2;
    const errorGraceMs = options.errorGraceMs ?? 600;
    const startedAt = Date.now();
    const deadline = Date.now() + timeoutMs;
    let stableSignature = null;
    let stablePolls = 0;
    let lastState = adapter.classifyDocument(doc);

    while (Date.now() < deadline) {
      lastState = adapter.classifyDocument(doc);
      if (lastState.kind === "final") {
        return { ready: true, changed: true, kind: "final", signature: adapter.pageSignature(doc), errors: [] };
      }
      if (lastState.kind === "form") {
        const signature = adapter.pageSignature(doc);
        const errors = portalErrors(doc);
        if (previousSignature && signature === previousSignature && errors.length && Date.now() - startedAt >= errorGraceMs) {
          return { ready: true, changed: false, kind: "form", signature, errors };
        }
        if (!previousSignature || signature !== previousSignature) {
          if (signature === stableSignature) stablePolls += 1;
          else {
            stableSignature = signature;
            stablePolls = 1;
          }
          if (stablePolls >= stablePollsRequired) {
            return { ready: true, changed: Boolean(previousSignature), kind: "form", signature, errors };
          }
        } else {
          stableSignature = null;
          stablePolls = 0;
        }
      } else {
        stableSignature = null;
        stablePolls = 0;
      }
      await delay(options.pollMs || 100);
    }

    return {
      ready: false,
      changed: false,
      kind: lastState.kind,
      signature: previousSignature,
      errors: portalErrors(doc)
    };
  }

  async function waitForPageChange(doc, previousSignature, timeoutMs = 6000) {
    return waitForUsablePage(doc, { previousSignature, timeoutMs });
  }

  function safeNavigationClick(element) {
    if (!element) throw new Error("Navigation control was not found.");
    if (adapter.isDeniedAction(element)) throw new Error(`Refused to click denied action: ${adapter.actionText(element)}`);
    clickElement(element);
  }

  return {
    delay,
    setNativeProperty,
    fireValueEvents,
    clickElement,
    htmlDateValue,
    setEditableValue,
    fillText,
    fillNativeSelect,
    fillRadio,
    fillCheckbox,
    fillCombobox,
    fillFieldGroup,
    fillVisibleSection,
    fillSection: fillVisibleSection,
    portalErrors,
    waitForUsablePage,
    waitForPageChange,
    safeNavigationClick
  };
});
