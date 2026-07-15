(function attachAdapter(root, factory) {
  const shared = root.FlagAutofillShared || (typeof require === "function" ? require("./shared.js") : null);
  const api = factory(shared);
  root.FlagEta9035Adapter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createAdapter(shared) {
  "use strict";

  const CONTROL_SELECTOR = [
    "input:not([type='hidden']):not([type='button']):not([type='submit']):not([type='reset']):not([type='file'])",
    "textarea",
    "select",
    "[role='combobox']",
    "[contenteditable='true']"
  ].join(",");

  const OPTION_SELECTOR = [
    "[role='option']",
    "[role='listbox'] li",
    ".mat-option",
    ".ng-option",
    ".select__option",
    ".usa-combo-box__list-option",
    "[data-option-index]",
    "[role='listbox'] [data-value]",
    "datalist option"
  ].join(",");

  const FINAL_ACTIONS = new Set([
    "submit",
    "submit application",
    "submit case",
    "sign",
    "sign and submit",
    "file",
    "file application",
    "certify"
  ]);
  const NEVER_CLICK_ACTIONS = new Set([...FINAL_ACTIONS, "save and quit"]);

  function safeText(value, maxLength = 600) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  }

  function elementText(element) {
    if (!element) return "";
    if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.getAttribute("contenteditable") === "true") {
      return element.getAttribute("aria-label") || element.getAttribute("title") || "";
    }
    const clone = element.cloneNode(true);
    for (const control of clone.querySelectorAll("input,textarea,select,[contenteditable='true']")) {
      control.removeAttribute("value");
      if (control.tagName === "TEXTAREA" || control.getAttribute("contenteditable") === "true") control.textContent = "";
    }
    return safeText(clone.innerText || clone.textContent || "");
  }

  function isHidden(element) {
    if (!element || !element.isConnected) return true;
    let current = element;
    while (current && current.nodeType === 1) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true") return true;
      const style = current.getAttribute("style") || "";
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
      const view = current.ownerDocument && current.ownerDocument.defaultView;
      if (view && typeof view.getComputedStyle === "function") {
        const computed = view.getComputedStyle(current);
        if (computed && (computed.display === "none" || computed.visibility === "hidden")) return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function associatedLabels(control) {
    const labels = [];
    if (control.labels) {
      for (const label of Array.from(control.labels)) labels.push(label);
    }
    const id = control.getAttribute("id");
    if (id && control.ownerDocument) {
      const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
      for (const label of control.ownerDocument.querySelectorAll(`label[for="${escaped}"]`)) labels.push(label);
    }
    const enclosing = control.closest && control.closest("label");
    if (enclosing) labels.push(enclosing);
    return [...new Set(labels.filter(Boolean))];
  }

  function associatedLabelTexts(control) {
    return [...new Set(associatedLabels(control).map(elementText).filter(Boolean))];
  }

  function ariaLabelText(control) {
    const parts = [];
    const direct = control.getAttribute && control.getAttribute("aria-label");
    if (direct) parts.push(direct);
    const labelledBy = control.getAttribute && control.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const node = control.ownerDocument.getElementById(id);
        if (node) parts.push(elementText(node));
      }
    }
    return safeText(parts.join(" "));
  }

  function findQuestionContext(control) {
    const directCandidates = [...associatedLabelTexts(control), ariaLabelText(control)].filter(Boolean);
    const fieldset = control.closest && control.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector(":scope > legend") || fieldset.querySelector("legend");
      if (legend) directCandidates.push(elementText(legend));
    }
    for (const text of directCandidates) {
      const ids = shared.extractQuestionIds(text);
      if (ids.length) {
        return {
          labelText: safeText(text), questionIds: ids,
          container: control.closest(".usa-form-group,.form-group,.question,fieldset") || fieldset || control.parentElement,
          direct: true
        };
      }
    }

    let current = control.parentElement;
    let depth = 0;
    while (current && depth < 8) {
      const text = elementText(current);
      const ids = shared.extractQuestionIds(text);
      if (ids.length && text.length <= 2200) {
        return { labelText: text, questionIds: ids, container: current, direct: false };
      }
      current = current.parentElement;
      depth += 1;
    }
    return {
      labelText: safeText(directCandidates.join(" ")), questionIds: [],
      container: control.parentElement, direct: false
    };
  }

  function getQuestionControls(doc) {
    const controls = [];
    const seen = new Set();
    for (const candidate of Array.from(doc.querySelectorAll(CONTROL_SELECTOR))) {
      let control = candidate;
      if (candidate.getAttribute("role") === "combobox" && !/^(INPUT|TEXTAREA|SELECT)$/.test(candidate.tagName)) {
        control = candidate.querySelector("input,textarea,select,[contenteditable='true']") || candidate;
      }
      if (!seen.has(control) && !isHidden(control)) {
        seen.add(control);
        controls.push(control);
      }
    }
    return controls;
  }

  function discoverFieldGroups(doc) {
    const groups = new Map();
    for (const control of getQuestionControls(doc)) {
      const context = findQuestionContext(control);
      if (!context.questionIds.length) continue;
      const key = context.questionIds.join("/");
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          questionIds: context.questionIds,
          labelText: context.labelText,
          container: context.container,
          controls: [],
          bindings: []
        });
      }
      const group = groups.get(key);
      if (!group.controls.includes(control)) group.controls.push(control);
      group.bindings.push({
        control,
        questionIds: context.questionIds,
        labelText: context.labelText,
        direct: context.direct
      });
      if (context.labelText.length < group.labelText.length) group.labelText = context.labelText;
    }

    const discovered = [];
    for (const group of groups.values()) {
      if (group.questionIds.length > 1 && group.questionIds.length === group.controls.length &&
          group.controls.every((control) => !["radio", "checkbox"].includes((control.type || "").toLowerCase()))) {
        group.questionIds.forEach((questionId, index) => {
          const binding = group.bindings.find((item) => item.control === group.controls[index]);
          discovered.push({
            key: questionId,
            questionIds: [questionId],
            labelText: binding && binding.labelText || group.labelText,
            container: binding && binding.control.parentElement || group.container,
            controls: [group.controls[index]],
            bindings: binding ? [{ ...binding, questionIds: [questionId] }] : []
          });
        });
      } else {
        discovered.push(group);
      }
    }
    return discovered;
  }

  function getControlOptionText(control) {
    const labels = associatedLabelTexts(control);
    if (labels.length) return safeText(labels.sort((a, b) => a.length - b.length)[0]);
    const aria = ariaLabelText(control);
    if (aria) return aria;
    const parentText = control.parentElement && elementText(control.parentElement);
    if (parentText && parentText.length <= 240) return parentText;
    return control.getAttribute("value") || "";
  }

  function optionTexts(element) {
    if (!element) return [];
    const text = ["INPUT", "SELECT"].includes(element.tagName)
      ? getControlOptionText(element)
      : safeText(element.innerText || element.textContent || "", 400);
    return [...new Set([text].filter(Boolean))];
  }

  function optionValues(element) {
    if (!element || !element.getAttribute) return [];
    const values = [
      element.getAttribute("value"),
      element.getAttribute("data-value"),
      element.getAttribute("data-option-value"),
      element.getAttribute("data-key")
    ];
    return [...new Set(values.map((value) => safeText(value, 300)).filter(Boolean))];
  }

  function looksLikeCombobox(control) {
    const role = control.getAttribute("role");
    const type = (control.getAttribute("type") || "").toLowerCase();
    return role === "combobox" || control.hasAttribute("aria-autocomplete") ||
      control.hasAttribute("aria-controls") || control.hasAttribute("aria-owns") || type === "search";
  }

  function findOpenOptions(doc, control) {
    const candidates = [];
    const seen = new Set();
    const controlledIds = [control.getAttribute("aria-controls"), control.getAttribute("aria-owns"), control.getAttribute("list")]
      .filter(Boolean)
      .flatMap((value) => value.split(/\s+/));
    for (const id of controlledIds) {
      const list = doc.getElementById(id);
      if (!list) continue;
      if (list.matches(OPTION_SELECTOR)) candidates.push(list);
      candidates.push(...Array.from(list.querySelectorAll(OPTION_SELECTOR)));
      if (!candidates.length) candidates.push(...Array.from(list.querySelectorAll("li,button,[tabindex],option,[data-value]")));
    }
    if (!candidates.length) candidates.push(...Array.from(doc.querySelectorAll(OPTION_SELECTOR)));
    return candidates.filter((option) => {
      const datalistOption = option.tagName === "OPTION" && option.closest("datalist");
      if (seen.has(option) || (!datalistOption && isHidden(option))) return false;
      seen.add(option);
      return Boolean(optionTexts(option).length || optionValues(option).length);
    });
  }

  function hasEtaMarker(doc) {
    const pageText = safeText(doc.body && (doc.body.innerText || doc.body.textContent), 12000);
    return /ETA[\s-]*9035(?:E)?|Labor Condition Application for Nonimmigrant Workers/i
      .test(`${doc.title || ""} ${pageText}`);
  }

  function isEta9035Document(doc) {
    return hasEtaMarker(doc) && discoverFieldGroups(doc).length > 0;
  }

  function applicationRoot(doc) {
    const visibleForms = Array.from(doc.querySelectorAll("form")).filter((form) => !isHidden(form));
    const questionForm = visibleForms.find((form) => shared.extractQuestionIds(elementText(form)).length > 0);
    if (questionForm) return questionForm;
    const mainForm = visibleForms.find((form) => form.closest("main"));
    return mainForm || visibleForms[0] || doc.querySelector("main") || doc.body || doc.documentElement || doc;
  }

  function isFirstSection(doc) {
    if (isFinalPage(doc)) return false;
    const hasA1 = discoverFieldGroups(doc).some((group) => group.questionIds.includes("A.1"));
    if (!hasA1) return false;

    const root = applicationRoot(doc);
    const headingMatch = Array.from(root.querySelectorAll("h1,h2,h3,[role='heading']"))
      .filter((element) => !isHidden(element))
      .some((element) => shared.normalizeOptionText(elementText(element))
        .includes("employment based nonimmigrant visa information"));
    const active = doc.querySelector(
      "nav [aria-current='step'],nav [aria-current='page'],aside [aria-current='step'],aside [aria-current='page'],.active[role='tab']"
    );
    const activeMatch = active && shared.normalizeOptionText(navigationText(active))
      .includes("employment based nonimmigrant visa information");
    return headingMatch || Boolean(activeMatch);
  }

  function navigationText(element) {
    return safeText(elementText(element), 180);
  }

  function findFirstSectionNavigation(doc) {
    const selector = "nav a,nav button,nav [role='button'],nav [role='link'],aside a,aside button,aside [role='button'],aside [role='link'],a,button,[role='button'],[role='link'],li";
    const matches = Array.from(doc.querySelectorAll(selector)).filter((candidate) => {
      if (isHidden(candidate)) return false;
      const text = shared.normalizeOptionText(navigationText(candidate));
      return text.includes("employment based nonimmigrant visa information") || (text.startsWith("a ") && text.includes("visa information"));
    });
    const clickable = matches.map((element) => {
      if (element.matches("a,button,[role='button'],[role='link']")) return element;
      return element.querySelector("a,button,[role='button'],[role='link']") || element;
    });
    clickable.sort((a, b) => navigationText(a).length - navigationText(b).length);
    return clickable[0] || null;
  }

  function actionText(element) {
    return safeText(element.getAttribute("aria-label") || element.getAttribute("title") ||
      element.getAttribute("value") || elementText(element), 120);
  }

  function actionCandidates(root) {
    return Array.from(root.querySelectorAll("button,input[type='button'],input[type='submit'],a[role='button'],[role='button']"))
      .filter((element) => !isHidden(element) && !element.disabled);
  }

  function findContinue(doc) {
    const matches = actionCandidates(applicationRoot(doc))
      .filter((element) => shared.normalizeOptionText(actionText(element)) === "continue");
    return matches.length === 1 ? matches[0] : null;
  }

  function isDeniedAction(element) {
    return NEVER_CLICK_ACTIONS.has(shared.normalizeOptionText(actionText(element)));
  }

  function finalPageSignals(doc) {
    const root = applicationRoot(doc);
    const headings = Array.from(root.querySelectorAll("h1,h2,h3,[role='heading']"))
      .filter((element) => !isHidden(element))
      .map((element) => safeText(elementText(element), 200))
      .filter((text) => {
        const normalized = shared.normalizeOptionText(text);
        return normalized.includes("review and submit") || normalized.includes("sign and submit");
      });
    const actions = actionCandidates(root)
      .map((element) => safeText(actionText(element), 120))
      .filter((text) => FINAL_ACTIONS.has(shared.normalizeOptionText(text)));
    return {
      root: root === doc ? "document" : String(root.tagName || "document").toLowerCase(),
      headings: [...new Set(headings)],
      actions: [...new Set(actions)]
    };
  }

  function isFinalPage(doc) {
    const signals = finalPageSignals(doc);
    return signals.headings.length > 0 || signals.actions.length > 0;
  }

  function detectSection(doc) {
    const groups = discoverFieldGroups(doc);
    const firstId = groups[0] && groups[0].questionIds[0];
    const code = firstId ? firstId.split(".")[0] : null;
    const activeCandidates = Array.from(doc.querySelectorAll(
      "nav [aria-current='step'],nav [aria-current='page'],aside [aria-current='step'],aside [aria-current='page']"
    ));
    const active = activeCandidates.find((element) => {
      if (!code) return true;
      const text = navigationText(element).trim();
      return new RegExp(`^${code}(?:\\b|[.:-])`, "i").test(text);
    });
    return {
      code,
      title: active ? navigationText(active) : (code ? `Section ${code}` : "Unknown section")
    };
  }

  function classifyDocument(doc) {
    if (isFinalPage(doc)) return { kind: "final", section: detectSection(doc) };
    if (isEta9035Document(doc)) return { kind: "form", section: detectSection(doc) };
    if (doc.readyState !== "complete" || hasEtaMarker(doc)) {
      return { kind: "loading", section: detectSection(doc) };
    }
    return { kind: "unrelated", section: detectSection(doc) };
  }

  function sanitizeUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const path = url.pathname.split("/").map((segment) => {
        if (!segment) return segment;
        if (/^[0-9]{4,}$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(segment) || /^(?=.*\d)[a-z0-9_-]{14,}$/i.test(segment)) return ":id";
        return segment;
      }).join("/");
      return `${url.origin}${path}`;
    } catch {
      return "unavailable";
    }
  }

  function pageSignature(doc) {
    const section = detectSection(doc);
    const ids = discoverFieldGroups(doc).flatMap((group) => group.questionIds).join(",");
    return `${sanitizeUrl(doc.location && doc.location.href)}|${section.code || "?"}|${ids}`;
  }

  function safeAttributes(control) {
    const result = {
      tag: control.tagName.toLowerCase(), type: control.getAttribute("type") || null,
      role: control.getAttribute("role") || null, name: control.getAttribute("name") || null,
      id: control.getAttribute("id") || null, placeholder: control.getAttribute("placeholder") || null,
      ariaLabel: control.getAttribute("aria-label") || null,
      ariaLabelledby: control.getAttribute("aria-labelledby") || null,
      ariaControls: control.getAttribute("aria-controls") || null,
      ariaAutocomplete: control.getAttribute("aria-autocomplete") || null
    };
    for (const name of ["data-testid", "data-test", "data-cy", "data-qa", "data-component"]) {
      if (control.hasAttribute(name)) result[name] = safeText(control.getAttribute(name), 160);
    }
    return result;
  }

  function groupOptions(group) {
    const options = [];
    for (const control of group.controls) {
      if (control.tagName === "SELECT") {
        options.push(...Array.from(control.options).map((option) => safeText(option.textContent, 220)).filter(Boolean));
      } else if (["radio", "checkbox"].includes((control.type || "").toLowerCase())) {
        options.push(getControlOptionText(control));
      } else if (looksLikeCombobox(control)) {
        options.push(...findOpenOptions(control.ownerDocument, control).map((option) => elementText(option)));
      }
    }
    return [...new Set(options.filter(Boolean))].slice(0, 300);
  }

  function inspectDocument(doc) {
    const groups = discoverFieldGroups(doc);
    const finalSignals = finalPageSignals(doc);
    const navigation = Array.from(doc.querySelectorAll("nav a,nav button,nav [role='button'],nav [role='link'],aside a,aside button,aside [role='button'],aside [role='link']"))
      .filter((element) => !isHidden(element))
      .map((element) => ({
        text: navigationText(element), tag: element.tagName.toLowerCase(), role: element.getAttribute("role"),
        hrefPattern: element.hasAttribute("href") ? sanitizeUrl(element.href) : null,
        ariaCurrent: element.getAttribute("aria-current")
      })).filter((item) => item.text).slice(0, 100);
    const frames = Array.from(doc.querySelectorAll("iframe")).map((frame) => ({
      title: safeText(frame.getAttribute("title"), 160), srcPattern: sanitizeUrl(frame.getAttribute("src") || "")
    }));
    const openShadowRoots = Array.from(doc.querySelectorAll("*")).filter((element) => Boolean(element.shadowRoot)).length;
    return {
      inspectorVersion: 1,
      generatedAt: new Date().toISOString(),
      page: {
        urlPattern: sanitizeUrl(doc.location && doc.location.href), title: safeText(doc.title, 200),
        formDetected: isEta9035Document(doc), firstSectionDetected: isFirstSection(doc),
        finalPageDetected: finalSignals.headings.length > 0 || finalSignals.actions.length > 0,
        finalPageSignals: finalSignals, section: detectSection(doc)
      },
      fields: groups.map((group) => ({
        questionIds: group.questionIds, labelText: safeText(group.labelText, 900),
        controls: group.controls.map(safeAttributes), visibleOptions: groupOptions(group)
      })),
      navigation, frames, openShadowRoots
    };
  }

  return {
    safeText, elementText, isHidden, associatedLabels, discoverFieldGroups, getControlOptionText,
    optionTexts, optionValues, looksLikeCombobox, findOpenOptions, hasEtaMarker, isEta9035Document,
    isFirstSection, findFirstSectionNavigation, actionText, findContinue, isDeniedAction, isFinalPage,
    detectSection, classifyDocument, pageSignature, inspectDocument
  };
});
