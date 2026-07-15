# FLAG ETA-9035 Autofill MVP

An unpacked Chrome Manifest V3 extension that fills an authenticated FLAG ETA-9035/9035E draft from pasted flat JSON, advances through the form with **Continue**, and stops before any sign, file, certify, or submit action.

## Install and test

```bash
cd /Users/sambhav/Desktop/paraleague
npm install
npm test
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select:

```text
/Users/sambhav/Desktop/paraleague/extension
```

Reload any already-open `https://flag.dol.gov` tab after installing the extension.

## Use

1. Sign in to FLAG yourself and open an unsubmitted ETA-9035/9035E draft.
2. Open the extension, paste a flat JSON object, and select **Run from first section**.
3. The extension returns to section A, overwrites nonblank supplied answers, skips blank answers, and clicks **Continue** through reachable sections.
4. If FLAG prevents navigation, correct the page manually and select **Resume**.
5. The extension stops on the final review/sign-and-submit page. It never clicks **Save & Quit**, **Sign**, **File**, **Certify**, or **Submit**.

The controller waits for FLAG's client-side form to settle between sections. Temporary loading DOMs are ignored; a real FLAG validation error leaves the run blocked and resumable instead of discarding the remaining answers.

Answers and reports use `chrome.storage.session`; they are not written to persistent extension storage or sent over the network. **Clear** removes the current in-memory run and report.

A corrected, valid version of the original example is available at `examples/sample-answers.json`.

## Authenticated-page diagnostic workflow

The public site does not expose the authenticated form DOM. The extension therefore includes a value-free inspector:

1. Open each form section while logged in.
2. Select **Inspect section** and keep the downloaded JSON.
3. For each kind of searchable dropdown, open its option list using dummy data and inspect the section again.
4. Review the exports, then provide them to the developer to replace generic label discovery with verified stable selectors where needed.

The inspector exports question labels, safe control attributes, visible option labels, sanitized URL patterns, section navigation metadata, and iframe/shadow-root counts. It does not export input values, cookies, tokens, local/session storage, or credentials.

## Input behavior

- Input must be one flat JSON object.
- Keys are question identifiers such as `A.1`, `B.7a`, and `C.10`; matching is case-insensitive and whitespace-insensitive.
- String, number, boolean, and `null` values are accepted without business-format validation.
- `null` and blank strings are skipped. `0` and `false` are real answers.
- Arrays and nested objects are reported as `unsupported_value`.
- Existing nonblank portal values are overwritten.
- Radio/select/dropdown options first use exact normalized visible-label matching. If no label matches, one unique exact underlying HTML value is accepted (for example `Yes_4` or `/On`); fuzzy matching is never used.
- Combined controls such as `B.2/B.3` are filled by combining their separate answer entries internally; for example, `B.2` supplies the SOC code and `B.3` supplies the occupation title.
- Known PDF-to-FLAG choice tokens are normalized only for their specific questions (`Yearly` to `Year` for F.10a/F.11a, `Yes_4` to `Yes` for G.1, and `/On` to `Yes` for H.1/H.2).
- Section F commits one completed worksite with **Add Place of Employment** before continuing and verifies that the table row was created.
- React-controlled fields are rechecked after the portal settles and retried once if the first value is rolled back.
- Repeated rows, file uploads, nested answers, and forms other than ETA-9035/9035E are outside this MVP.

## Project layout

- `extension/manifest.json`: minimum Chrome permissions and content-script registration.
- `extension/background.js`: in-memory session-state coordinator shared across popup and page navigations.
- `extension/popup.*`: JSON input, controls, status, report and diagnostic exports.
- `extension/shared.js`: JSON parsing, question normalization, state and reports.
- `extension/eta9035-adapter.js`: form detection, field discovery, navigation, final-action barrier and safe inspection.
- `extension/autofill-engine.js`: control-specific fill and verification handlers.
- `extension/content.js`: automatic cross-page orchestration and resume behavior.
- `test/`: sanitized DOM fixtures and Node/jsdom tests.

## Important limitation

The generic adapter is intentionally evidence-based and conservative, but it has not been run against a logged-in FLAG draft. The value-free inspection exports are required to finalize any site-specific selectors or custom dropdown variants that the authenticated portal uses.
