import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const installerPath = join(repositoryRoot, "scripts/install.sh");
const overlayRoot = join(repositoryRoot, "overlay");
const installedFiles = [
  "squad-server/plugins/autoseed-exporter.js",
  "squad-server/utils/build-identity.js",
  "squad-server/utils/public-session.js"
];

function runInstaller(targetRoot, ...args) {
  return spawnSync("bash", [installerPath, targetRoot, ...args], {
    encoding: "utf8"
  });
}

test("installer performs a clean idempotent install and protects local changes", (t) => {
  const targetRoot = mkdtempSync(join(tmpdir(), "squadjs-autoseed-kit-"));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));
  writeFileSync(join(targetRoot, "package.json"), "{}\n", "utf8");

  const firstInstall = runInstaller(targetRoot);
  assert.equal(firstInstall.status, 0, firstInstall.stderr);

  for (const relativePath of installedFiles) {
    assert.deepEqual(
      readFileSync(join(targetRoot, relativePath)),
      readFileSync(join(overlayRoot, relativePath)),
      relativePath
    );
  }

  const repeatedInstall = runInstaller(targetRoot);
  assert.equal(repeatedInstall.status, 0, repeatedInstall.stderr);

  const protectedPath = join(targetRoot, installedFiles[0]);
  mkdirSync(dirname(protectedPath), { recursive: true });
  writeFileSync(protectedPath, "local change\n", "utf8");

  const protectedInstall = runInstaller(targetRoot);
  assert.equal(protectedInstall.status, 4);
  assert.match(protectedInstall.stderr, /не будет заменён без --force/);
  assert.equal(readFileSync(protectedPath, "utf8"), "local change\n");

  const forcedInstall = runInstaller(targetRoot, "--force");
  assert.equal(forcedInstall.status, 0, forcedInstall.stderr);
  assert.deepEqual(
    readFileSync(protectedPath),
    readFileSync(join(overlayRoot, installedFiles[0]))
  );
});
