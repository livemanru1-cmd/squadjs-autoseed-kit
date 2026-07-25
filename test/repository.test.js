import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const requiredFiles = [
  "overlay/squad-server/plugins/autoseed-exporter.js",
  "overlay/squad-server/utils/build-identity.js",
  "overlay/squad-server/utils/public-session.js"
];

test("overlay includes every relative dependency required by the exporter", () => {
  for (const file of requiredFiles) {
    assert.ok(readFileSync(new URL(`../${file}`, import.meta.url), "utf8").length > 0, file);
  }
});

test("public page example contains no secret value or non-HTTPS exporter", () => {
  const configText = readFileSync(new URL("../site/config.js", import.meta.url), "utf8");
  assert.doesNotMatch(configText, /apiKey|token|password|secret/i);
  assert.doesNotMatch(configText, /http:\/\//i);
  assert.match(configText, /https:\/\/exporter\.example\.org/);
});

test("portable exporter never disables TLS certificate verification", () => {
  const exporter = readFileSync(
    new URL("../overlay/squad-server/plugins/autoseed-exporter.js", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(exporter, /rejectUnauthorized:\s*false/);
});
