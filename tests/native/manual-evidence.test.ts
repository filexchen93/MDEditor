import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  findLatestCompletedRun as untypedFindLatestCompletedRun,
  verifyManualAcceptanceRun as untypedVerifier,
} from "../../scripts/native-manual-evidence.mjs";

interface VerifiedEvidence {
  runDirectory: string;
  artifactCount: number;
  commit: string;
  worktreeState: string;
  manualBinarySha256: string;
}

const verifyManualAcceptanceRun = untypedVerifier as unknown as (
  runDirectory: string,
) => VerifiedEvidence;
const findLatestCompletedRun = untypedFindLatestCompletedRun as unknown as (
  resultsRoot: string,
) => string | null;

const temporaryDirectories: string[] = [];

function hash(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function createRun() {
  const runDirectory = mkdtempSync(
    path.join(os.tmpdir(), "mdeditor-manual-evidence-"),
  );
  temporaryDirectories.push(runDirectory);
  const files = [
    ["files/中文 路径/字节保真.md", "seed"],
    ["files/输出 文件/saved.md", "saved"],
    ["files/输出 文件/export.html", "<h1>export</h1>"],
    ["files/输出 文件/print.pdf", "%PDF-test"],
  ] as const;
  const artifacts = files.map(([relative, contents]) => {
    const absolute = path.join(runDirectory, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
    return {
      path: relative,
      bytes: Buffer.byteLength(contents),
      sha256: hash(absolute),
    };
  });
  const summary = {
    runDirectory,
    appExitCode: 0,
    windowsVersion: "Windows test",
    webView2Version: "1.2.3",
    detectedDisplayScaling: "125% (120 DPI)",
    configuredKeyboardLayouts: ["Chinese test (00000804)"],
    commit: "abcdef",
    worktreeState: "dirty",
    manualBinarySha256: "binary-hash",
    initialFixtureSha256: "fixture-hash",
    artifacts,
  };
  writeFileSync(
    path.join(runDirectory, "artifact-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  writeFileSync(
    path.join(runDirectory, "MANUAL_RESULT.md"),
    [
      "# Result",
      "",
      `- Run directory: \`${path.basename(runDirectory)}\``,
      "- Seeded input: `files/中文 路径/字节保真.md`",
      "- Initial SHA-256: `fixture-hash`",
      "- Manual binary SHA-256: `binary-hash`",
      "- Windows version: Windows test",
      "- WebView2 version: 1.2.3",
      "- Configured keyboard layouts: Chinese test (00000804)",
      "- IME name/version: Microsoft Pinyin test",
      "- Display scaling: 125%",
      "- Display resolution: 1920x1080",
      "- Contrast theme: Dusk",
      "- Highest tested scaling: 200%",
      "- Physical keyboard navigation: yes",
      "- Native minimum window size: 360x520 CSS px",
      "- Commit/worktree: `abcdef` (dirty)",
      "",
      "- [x] System IME and writing flow passed",
      "- [x] Native open/save-as/export dialogs passed",
      "- [x] Print/PDF dialog and output passed",
      "- [x] Cancellation preserved editor and file-system state",
      "- [x] External-change overwrite protection passed",
      "- [x] Keyboard flow reached editor, tabs, toolbar, settings and export",
      "- [x] Windows contrast theme kept text and focus distinguishable",
      "- [x] High scaling and minimum-width window kept controls reachable",
      "- [x] Display-only operations preserved document bytes and dirty state",
    ].join("\n"),
  );
  return { runDirectory, summary };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("native manual acceptance evidence", () => {
  it("selects a completed run and ignores preparation-only evidence", () => {
    const resultsRoot = mkdtempSync(
      path.join(os.tmpdir(), "mdeditor-manual-results-"),
    );
    temporaryDirectories.push(resultsRoot);
    const prepared = path.join(resultsRoot, "run-prepared");
    const completed = path.join(resultsRoot, "run-completed");
    mkdirSync(prepared);
    mkdirSync(completed);
    writeFileSync(
      path.join(prepared, "artifact-summary.json"),
      JSON.stringify({ appExitCode: null }),
    );
    writeFileSync(
      path.join(completed, "artifact-summary.json"),
      JSON.stringify({ appExitCode: 0 }),
    );

    expect(findLatestCompletedRun(resultsRoot)).toBe(completed);
  });

  it("accepts complete, hash-matched evidence", () => {
    const { runDirectory } = createRun();

    expect(verifyManualAcceptanceRun(runDirectory)).toMatchObject({
      runDirectory,
      artifactCount: 4,
      commit: "abcdef",
    });
  });

  it("accepts an explicit run path after the package-manager separator", () => {
    const { runDirectory } = createRun();
    const script = path.resolve("scripts/native-manual-evidence.mjs");
    const result = spawnSync(process.execPath, [script, "--", runDirectory], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `Manual acceptance evidence verified: ${runDirectory}`,
    );
  });

  it("rejects incomplete decisions and missing environment metadata", () => {
    const { runDirectory } = createRun();
    const resultPath = path.join(runDirectory, "MANUAL_RESULT.md");
    writeFileSync(
      resultPath,
      readFileSync(resultPath, "utf8")
        .replace(
          "- IME name/version: Microsoft Pinyin test",
          "- IME name/version:",
        )
        .replace(
          "- [x] Print/PDF dialog and output passed",
          "- [ ] Print/PDF dialog and output passed",
        ),
    );

    expect(() => verifyManualAcceptanceRun(runDirectory)).toThrowError(
      /IME name\/version is not recorded[\s\S]*Print\/PDF dialog and output passed/u,
    );
  });

  it("rejects unverified high scaling and missing contrast evidence", () => {
    const { runDirectory } = createRun();
    const resultPath = path.join(runDirectory, "MANUAL_RESULT.md");
    writeFileSync(
      resultPath,
      readFileSync(resultPath, "utf8")
        .replace("- Contrast theme: Dusk", "- Contrast theme:")
        .replace(
          "- Highest tested scaling: 200%",
          "- Highest tested scaling: 125%",
        )
        .replace(
          "- [x] Windows contrast theme kept text and focus distinguishable",
          "- [ ] Windows contrast theme kept text and focus distinguishable",
        ),
    );

    expect(() => verifyManualAcceptanceRun(runDirectory)).toThrowError(
      /contrast theme is not recorded[\s\S]*highest tested scaling must be at least 150%[\s\S]*Windows contrast theme/u,
    );
  });

  it("rejects changed artifacts and paths outside the isolated files directory", () => {
    const { runDirectory, summary } = createRun();
    writeFileSync(
      path.join(runDirectory, "files", "输出 文件", "saved.md"),
      "changed",
    );
    summary.artifacts.push({
      path: "../outside.pdf",
      bytes: 1,
      sha256: "invalid",
    });
    writeFileSync(
      path.join(runDirectory, "artifact-summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );

    expect(() => verifyManualAcceptanceRun(runDirectory)).toThrowError(
      /artifact byte size changed[\s\S]*artifact path escapes/u,
    );
  });

  it("rejects an artifact reached through a link outside the run", () => {
    const { runDirectory, summary } = createRun();
    const externalDirectory = mkdtempSync(
      path.join(os.tmpdir(), "mdeditor-external-evidence-"),
    );
    temporaryDirectories.push(externalDirectory);
    const externalFile = path.join(externalDirectory, "export.html");
    writeFileSync(externalFile, "outside");
    symlinkSync(
      externalDirectory,
      path.join(runDirectory, "files", "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    summary.artifacts.push({
      path: "files/linked/export.html",
      bytes: 7,
      sha256: hash(externalFile),
    });
    writeFileSync(
      path.join(runDirectory, "artifact-summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );

    expect(() => verifyManualAcceptanceRun(runDirectory)).toThrowError(
      /artifact resolves outside the files directory/u,
    );
  });
});
