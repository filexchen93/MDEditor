import { mkdirSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const resultsRoot = path.resolve("test-results", "native-restart");
mkdirSync(resultsRoot, { recursive: true });
const runDirectory = mkdtempSync(path.join(resultsRoot, "run-"));
const wdio = path.resolve("node_modules", "@wdio", "cli", "bin", "wdio.js");
const config = path.resolve("wdio.native.conf.mjs");
const phases = [
  path.resolve("tests", "native", "restart-seed.spec.mjs"),
  path.resolve("tests", "native", "restart-restore.spec.mjs"),
];

for (const spec of phases) {
  const result = spawnSync(
    process.execPath,
    [wdio, "run", config, "--spec", spec],
    {
      cwd: process.cwd(),
      env: { ...process.env, MDEDITOR_NATIVE_RUN_DIR: runDirectory },
      stdio: "inherit",
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
