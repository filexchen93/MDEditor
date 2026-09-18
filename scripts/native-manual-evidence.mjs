import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_RESULTS = [
  "System IME and writing flow passed",
  "Native open/save-as/export dialogs passed",
  "Print/PDF dialog and output passed",
  "Cancellation preserved editor and file-system state",
  "External-change overwrite protection passed",
  "Keyboard flow reached editor, tabs, toolbar, settings and export",
  "Windows contrast theme kept text and focus distinguishable",
  "High scaling and minimum-width window kept controls reachable",
  "Display-only operations preserved document bytes and dirty state",
];

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function resultField(markdown, label) {
  const prefix = `- ${label}:`;
  const line = markdown
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length).trim().replaceAll("`", "") ?? "";
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function findLatestCompletedRun(resultsRoot) {
  if (!existsSync(resultsRoot)) return null;
  return (
    readdirSync(resultsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
      .map((entry) => path.join(resultsRoot, entry.name))
      .filter((directory) => {
        const summaryPath = path.join(directory, "artifact-summary.json");
        if (!existsSync(summaryPath)) return false;
        try {
          return (
            JSON.parse(readFileSync(summaryPath, "utf8")).appExitCode !== null
          );
        } catch {
          return false;
        }
      })
      .sort(
        (left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs,
      )[0] ?? null
  );
}

export function verifyManualAcceptanceRun(runDirectory) {
  const resolvedRunDirectory = path.resolve(runDirectory);
  const resultPath = path.join(resolvedRunDirectory, "MANUAL_RESULT.md");
  const summaryPath = path.join(resolvedRunDirectory, "artifact-summary.json");
  const problems = [];

  if (!existsSync(resultPath)) problems.push("MANUAL_RESULT.md is missing");
  if (!existsSync(summaryPath))
    problems.push("artifact-summary.json is missing");
  if (problems.length > 0) throw new Error(problems.join("\n"));

  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (error) {
    throw new Error(`artifact-summary.json is invalid: ${error.message}`, {
      cause: error,
    });
  }
  const result = readFileSync(resultPath, "utf8");

  if (path.resolve(summary.runDirectory ?? "") !== resolvedRunDirectory) {
    problems.push("summary runDirectory does not match the selected run");
  }
  if (summary.appExitCode !== 0) {
    problems.push(
      `manual application exit code is ${String(summary.appExitCode)}, expected 0`,
    );
  }
  if (
    resultField(result, "Run directory") !== path.basename(resolvedRunDirectory)
  ) {
    problems.push("result run directory does not match the selected run");
  }
  if (resultField(result, "Initial SHA-256") !== summary.initialFixtureSha256) {
    problems.push("initial fixture hash does not match the summary");
  }
  if (
    resultField(result, "Manual binary SHA-256") !== summary.manualBinarySha256
  ) {
    problems.push("manual binary hash does not match the summary");
  }
  if (resultField(result, "Windows version") !== summary.windowsVersion) {
    problems.push("Windows version does not match the summary");
  }
  if (resultField(result, "WebView2 version") !== summary.webView2Version) {
    problems.push("WebView2 version does not match the summary");
  }
  if (
    resultField(result, "Commit/worktree") !==
    `${summary.commit} (${summary.worktreeState})`
  ) {
    problems.push("commit/worktree identity does not match the summary");
  }
  if (!resultField(result, "IME name/version")) {
    problems.push("IME name/version is not recorded");
  }
  if (!resultField(result, "Display scaling")) {
    problems.push("display scaling is not recorded");
  }
  for (const label of [
    "Display resolution",
    "Contrast theme",
    "Physical keyboard navigation",
    "Native minimum window size",
  ]) {
    if (!resultField(result, label)) {
      problems.push(`${label.toLowerCase()} is not recorded`);
    }
  }
  const highestScaling = resultField(result, "Highest tested scaling");
  const highestPercent = Number.parseInt(
    highestScaling.match(/^(\d+)%/u)?.[1] ?? "",
    10,
  );
  if (!Number.isFinite(highestPercent) || highestPercent < 150) {
    problems.push("highest tested scaling must be at least 150%");
  }

  const checkedResults = new Set(
    result
      .split(/\r?\n/u)
      .map((line) => line.match(/^- \[[xX]\] (.+)$/u)?.[1])
      .filter((label) => label !== undefined),
  );
  for (const label of REQUIRED_RESULTS) {
    if (!checkedResults.has(label)) {
      problems.push(`result is not checked: ${label}`);
    }
  }

  const filesRoot = path.join(resolvedRunDirectory, "files");
  const realRunDirectory = realpathSync(resolvedRunDirectory);
  const realFilesRoot = existsSync(filesRoot) ? realpathSync(filesRoot) : null;
  if (realFilesRoot === null || !isInside(realRunDirectory, realFilesRoot)) {
    problems.push("the files directory is missing or resolves outside the run");
  }
  const artifacts = Array.isArray(summary.artifacts) ? summary.artifacts : [];
  if (artifacts.length === 0)
    problems.push("artifact summary contains no files");
  const extensions = [];
  const artifactPaths = new Set();
  for (const artifact of artifacts) {
    const artifactPath = String(artifact?.path ?? "");
    const absolute = path.resolve(resolvedRunDirectory, artifactPath);
    if (!isInside(filesRoot, absolute)) {
      problems.push(
        `artifact path escapes the files directory: ${artifactPath}`,
      );
      continue;
    }
    const key = path.normalize(artifactPath).toLowerCase();
    if (artifactPaths.has(key)) {
      problems.push(`artifact path is duplicated: ${artifactPath}`);
      continue;
    }
    artifactPaths.add(key);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      problems.push(`artifact is missing: ${artifactPath}`);
      continue;
    }
    if (
      realFilesRoot === null ||
      !isInside(realFilesRoot, realpathSync(absolute))
    ) {
      problems.push(
        `artifact resolves outside the files directory: ${artifactPath}`,
      );
      continue;
    }
    const bytes = statSync(absolute).size;
    if (bytes !== artifact.bytes) {
      problems.push(`artifact byte size changed: ${artifactPath}`);
    }
    if (sha256(absolute) !== artifact.sha256) {
      problems.push(`artifact hash changed: ${artifactPath}`);
    }
    extensions.push(path.extname(absolute).toLowerCase());
  }

  const seededInput = resultField(result, "Seeded input");
  const seededInputKey = path.normalize(seededInput).toLowerCase();
  if (!seededInput || !artifactPaths.has(seededInputKey)) {
    problems.push(
      "the recorded seeded input is missing from the artifact summary",
    );
  }

  if (extensions.filter((extension) => extension === ".md").length < 2) {
    problems.push("a Save As Markdown artifact is missing");
  }
  if (!extensions.includes(".html")) {
    problems.push("an HTML export artifact is missing");
  }
  if (!extensions.includes(".pdf")) {
    problems.push("a PDF print artifact is missing");
  }

  if (problems.length > 0) {
    throw new Error(
      `Manual acceptance evidence is incomplete:\n- ${problems.join("\n- ")}`,
    );
  }

  return {
    runDirectory: resolvedRunDirectory,
    artifactCount: artifacts.length,
    commit: summary.commit,
    worktreeState: summary.worktreeState,
    manualBinarySha256: summary.manualBinarySha256,
  };
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const requested = process.argv.slice(2).find((argument) => argument !== "--");
  const runDirectory = requested
    ? path.resolve(requested)
    : findLatestCompletedRun(path.resolve("test-results", "native-manual"));
  if (runDirectory === null) {
    throw new Error("No completed manual acceptance run was found.");
  }
  const verified = verifyManualAcceptanceRun(runDirectory);
  console.log(`Manual acceptance evidence verified: ${verified.runDirectory}`);
  console.log(`Artifacts: ${verified.artifactCount}`);
  console.log(
    `Commit/worktree: ${verified.commit} (${verified.worktreeState})`,
  );
  console.log(`Manual binary SHA-256: ${verified.manualBinarySha256}`);
}
