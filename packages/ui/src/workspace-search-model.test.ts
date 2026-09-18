import { describe, expect, it } from "vitest";

import type { WorkspaceEntry } from "@mdeditor/document-session";

import {
  documentPositionFromLineColumn,
  rankWorkspaceFiles,
} from "./workspace-search-model.js";

const entries: readonly WorkspaceEntry[] = [
  {
    relativePath: "images/guide.png",
    name: "guide.png",
    kind: "file",
    bytes: 4,
  },
  {
    relativePath: "docs/中文指南.md",
    name: "中文指南.md",
    kind: "file",
    bytes: 12,
  },
  {
    relativePath: "docs/getting-started.md",
    name: "getting-started.md",
    kind: "file",
    bytes: 20,
  },
  { relativePath: "guide.md", name: "guide.md", kind: "file", bytes: 8 },
];

describe("workspace search model", () => {
  it("ranks fuzzy Markdown matches and excludes non-Markdown files", () => {
    expect(
      rankWorkspaceFiles(entries, "guide").map((entry) => entry.relativePath),
    ).toEqual(["guide.md"]);
    expect(
      rankWorkspaceFiles(entries, "dgs").map((entry) => entry.relativePath),
    ).toEqual(["docs/getting-started.md"]);
    expect(rankWorkspaceFiles(entries, "中文")[0]?.relativePath).toBe(
      "docs/中文指南.md",
    );
  });

  it("converts one-based line and UTF-16 columns to editor positions", () => {
    expect(documentPositionFromLineColumn("甲😀\nsecond", 2, 3)).toBe(6);
    expect(documentPositionFromLineColumn("one", 99, 99)).toBe(3);
  });
});
