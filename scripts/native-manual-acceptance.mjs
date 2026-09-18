import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  nativeFixturePath,
  seedNativeFiles,
} from "../tests/native/fixtures.mjs";

if (process.platform !== "win32") {
  throw new Error(
    "The M4 manual acceptance launcher currently supports Windows only.",
  );
}

const resultsRoot = path.resolve("test-results", "native-manual");
mkdirSync(resultsRoot, { recursive: true });
const runDirectory = mkdtempSync(path.join(resultsRoot, "run-"));
seedNativeFiles(runDirectory);

const inputPath = nativeFixturePath(runDirectory);
const outputDirectory = path.join(runDirectory, "files", "输出 文件");
mkdirSync(outputDirectory, { recursive: true });
const resultTemplatePath = path.join(runDirectory, "MANUAL_RESULT.md");
const summaryPath = path.join(runDirectory, "artifact-summary.json");
const appBinaryPath = path.resolve(
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "debug",
  "mdeditor.exe",
);

if (!existsSync(appBinaryPath)) {
  throw new Error(`Manual acceptance binary is missing: ${appBinaryPath}`);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function registryValue(key, name) {
  const result = spawnSync("reg.exe", ["query", key, "/v", name], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const valueLine = result.stdout
    .split(/\r?\n/u)
    .find((line) => line.trimStart().startsWith(`${name} `));
  return valueLine?.match(/\sREG_\w+\s+(.+)$/u)?.[1]?.trim() ?? null;
}

function registryValues(key) {
  const result = spawnSync("reg.exe", ["query", key], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*(\S+)\s+(REG_\w+)\s+(.+)$/u))
    .filter((match) => match !== null)
    .map((match) => ({
      name: match[1],
      type: match[2],
      value: match[3].trim(),
    }));
}

function detectWebView2Version() {
  const clientId = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
  const keys = [
    `HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\${clientId}`,
    `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${clientId}`,
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${clientId}`,
  ];
  return keys.map((key) => registryValue(key, "pv")).find(Boolean) ?? "unknown";
}

function detectDisplayScaling() {
  const value = registryValue(
    "HKCU\\Control Panel\\Desktop\\WindowMetrics",
    "AppliedDPI",
  );
  const dpi = value === null ? Number.NaN : Number(value);
  return Number.isFinite(dpi) && dpi > 0
    ? `${Math.round((dpi / 96) * 100)}% (${dpi} DPI)`
    : "unknown";
}

function detectKeyboardLayouts() {
  return registryValues("HKCU\\Keyboard Layout\\Preload")
    .filter((entry) => entry.type === "REG_SZ")
    .sort((left, right) =>
      left.name.localeCompare(right.name, "en", { numeric: true }),
    )
    .map((entry) => {
      const layoutText = registryValue(
        `HKLM\\SYSTEM\\CurrentControlSet\\Control\\Keyboard Layouts\\${entry.value}`,
        "Layout Text",
      );
      return layoutText === null
        ? entry.value
        : `${layoutText} (${entry.value})`;
    });
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolute) : [absolute];
  });
}

const initialHash = sha256(inputPath);
const binaryHash = sha256(appBinaryPath);
const commit = commandOutput("git", ["rev-parse", "HEAD"]);
const worktreeStatus = commandOutput("git", ["status", "--porcelain"]);
const worktreeState = worktreeStatus === "" ? "clean" : "dirty";
const generatedAt = new Date().toISOString();
const windowsVersion = `${os.version()} (${os.release()}, ${os.arch()})`;
const webView2Version = detectWebView2Version();
const detectedDisplayScaling = detectDisplayScaling();
const configuredKeyboardLayouts = detectKeyboardLayouts();
writeFileSync(
  resultTemplatePath,
  [
    "# M4/M6 Windows manual acceptance result",
    "",
    `- Run directory: \`${path.basename(runDirectory)}\``,
    `- Seeded input: \`${path.relative(runDirectory, inputPath)}\``,
    `- Initial SHA-256: \`${initialHash}\``,
    `- Manual binary SHA-256: \`${binaryHash}\``,
    `- Generated at: ${generatedAt}`,
    `- Windows version: ${windowsVersion}`,
    `- WebView2 version: ${webView2Version}`,
    `- Configured keyboard layouts: ${configuredKeyboardLayouts.join("; ") || "unknown"}`,
    "- IME name/version:",
    `- Display scaling: ${detectedDisplayScaling === "unknown" ? "" : detectedDisplayScaling}`,
    "- Display resolution:",
    "- Contrast theme:",
    "- Highest tested scaling:",
    "- Physical keyboard navigation:",
    "- Native minimum window size:",
    `- Commit/worktree: \`${commit}\` (${worktreeState})`,
    "",
    "## Results",
    "",
    "- [ ] System IME and writing flow passed",
    "- [ ] Native open/save-as/export dialogs passed",
    "- [ ] Print/PDF dialog and output passed",
    "- [ ] Cancellation preserved editor and file-system state",
    "- [ ] External-change overwrite protection passed",
    "- [ ] Keyboard flow reached editor, tabs, toolbar, settings and export",
    "- [ ] Windows contrast theme kept text and focus distinguishable",
    "- [ ] High scaling and minimum-width window kept controls reachable",
    "- [ ] Display-only operations preserved document bytes and dirty state",
    "",
    "## Notes",
    "",
  ].join("\n"),
  "utf8",
);

console.log("M4/M6 Windows manual acceptance workspace prepared.");
console.log(
  `Checklist: ${path.resolve("docs", "M4_WINDOWS_MANUAL_ACCEPTANCE.md")}`,
);
console.log(
  `Display checklist: ${path.resolve("docs", "M6_WINDOWS_DISPLAY_ACCEPTANCE.md")}`,
);
console.log(`Input fixture: ${inputPath}`);
console.log(`Choose outputs inside: ${outputDirectory}`);
console.log(`Record results in: ${resultTemplatePath}`);
const prepareOnly = process.argv.includes("--prepare-only");
let exitCode = null;
if (prepareOnly) {
  console.log("Preparation-only mode: the application will not be launched.");
} else {
  console.log(
    "Close MDEditor when finished; artifact hashes will then be recorded.",
  );
  const child = spawn(appBinaryPath, [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MDEDITOR_NATIVE_TEST_DATA: path.join(runDirectory, "app-data"),
      WEBVIEW2_USER_DATA_FOLDER: path.join(runDirectory, "webview"),
    },
    stdio: "inherit",
  });

  exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

const artifacts = listFiles(path.join(runDirectory, "files")).map((file) => ({
  path: path.relative(runDirectory, file),
  bytes: statSync(file).size,
  sha256: sha256(file),
}));
writeFileSync(
  summaryPath,
  `${JSON.stringify(
    {
      runDirectory,
      appExitCode: exitCode,
      generatedAt,
      windowsVersion,
      webView2Version,
      detectedDisplayScaling,
      configuredKeyboardLayouts,
      commit,
      worktreeState,
      manualBinarySha256: binaryHash,
      initialFixtureSha256: initialHash,
      artifacts,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(`Artifact summary: ${summaryPath}`);
if (exitCode === 0) {
  console.log("Fill MANUAL_RESULT.md, then verify the evidence bundle with:");
  console.log(`pnpm test:native:manual:verify -- "${runDirectory}"`);
}
if (exitCode !== null) process.exitCode = exitCode;
