const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));

test("manifest requests only the planned minimum permissions and FLAG host", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["activeTab", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://flag.dol.gov/*"]);
  assert.equal(manifest.background.service_worker, "background.js");
});

test("every manifest entrypoint exists and no extension script performs network requests", () => {
  const entrypoints = [
    manifest.action.default_popup,
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((entry) => entry.js)
  ];
  for (const entrypoint of entrypoints) {
    assert.equal(fs.existsSync(path.join(root, "extension", entrypoint)), true, entrypoint);
  }

  const scripts = fs.readdirSync(path.join(root, "extension")).filter((name) => name.endsWith(".js"));
  const source = scripts.map((name) => fs.readFileSync(path.join(root, "extension", name), "utf8")).join("\n");
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(/);
});
