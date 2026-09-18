import { describe, expect, it } from "vitest";

import type { WorkspaceEntry } from "@mdeditor/document-session";

import {
  deriveVirtualRange,
  filterWorkspaceEntries,
} from "./workspace-files-model.js";

const entries: readonly WorkspaceEntry[] = [
  { relativePath: "docs", name: "docs", kind: "directory", bytes: null },
  {
    relativePath: "docs/中文 指南.md",
    name: "中文 指南.md",
    kind: "file",
    bytes: 12,
  },
  {
    relativePath: "images/cover.png",
    name: "cover.png",
    kind: "file",
    bytes: 20,
  },
];

describe("workspace file list", () => {
  it("filters normalized relative paths without changing the source order", () => {
    expect(filterWorkspaceEntries(entries, " 中文 ")).toEqual([entries[1]]);
    expect(filterWorkspaceEntries(entries, "IMAGES/")).toEqual([entries[2]]);
    expect(filterWorkspaceEntries(entries, "  ")).toBe(entries);
  });

  it("derives bounded overscanned ranges for a large virtual list", () => {
    expect(deriveVirtualRange(20_000, 15_000, 600)).toEqual({
      start: 492,
      end: 528,
    });
    expect(deriveVirtualRange(4, -20, 0)).toEqual({ start: 0, end: 4 });
    expect(deriveVirtualRange(0, 100, 300)).toEqual({ start: 0, end: 0 });
  });
});
