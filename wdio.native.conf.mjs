import path from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";
import {
  nativeFixturePath,
  nativeImagePath,
  nativeWorkspaceRoot,
  seedNativeFiles,
} from "./tests/native/fixtures.mjs";

// Inherited by the worker when it loads this config again. Keep each run's
// recovery files and WebView profile isolated and available for inspection.
const resultsRoot = path.resolve("test-results", "native");
mkdirSync(resultsRoot, { recursive: true });
if (process.env.MDEDITOR_NATIVE_RUN_DIR === undefined) {
  process.env.MDEDITOR_NATIVE_RUN_DIR = mkdtempSync(
    path.join(resultsRoot, "run-"),
  );
  seedNativeFiles(process.env.MDEDITOR_NATIVE_RUN_DIR);
}
const runDirectory = process.env.MDEDITOR_NATIVE_RUN_DIR;

const executable = process.platform === "win32" ? "mdeditor.exe" : "mdeditor";
const appBinaryPath = path.resolve(
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "debug",
  executable,
);

export const config = {
  runner: "local",
  specs: ["./tests/native/m4-native.spec.mjs"],
  maxInstances: 1,
  logLevel: "warn",
  outputDir: runDirectory,
  framework: "mocha",
  reporters: ["spec"],
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,
  mochaOpts: {
    ui: "bdd",
    timeout: 90_000,
  },
  services: [
    [
      "tauri",
      {
        appBinaryPath,
        driverProvider: "embedded",
        embeddedPort: 4445,
        captureBackendLogs: true,
        captureFrontendLogs: false,
        startTimeout: 60_000,
        appArgs:
          process.env.MDEDITOR_NATIVE_STARTUP_TEST === "1"
            ? [nativeFixturePath(runDirectory)]
            : [],
        env: {
          MDEDITOR_NATIVE_TEST_DATA: path.join(runDirectory, "app-data"),
          MDEDITOR_NATIVE_WORKSPACE_ROOT: nativeWorkspaceRoot(runDirectory),
          MDEDITOR_NATIVE_IMAGE_PATH: nativeImagePath(runDirectory),
          WEBVIEW2_USER_DATA_FOLDER: path.join(runDirectory, "webview"),
        },
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: appBinaryPath,
      },
    },
  ],
};
