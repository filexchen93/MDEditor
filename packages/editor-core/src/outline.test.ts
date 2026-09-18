import { describe, expect, it } from "vitest";

import { deriveOutlineView } from "./outline.js";
import type { OutlineItem } from "./source-editor.js";

const outline: readonly OutlineItem[] = [
  { level: 1, text: "Overview", from: 0 },
  { level: 2, text: "Details", from: 10 },
  { level: 3, text: "Nested result", from: 20 },
  { level: 2, text: "Appendix", from: 30 },
  { level: 1, text: "Result summary", from: 40 },
];

describe("outline view", () => {
  it("annotates parents and hides descendants of collapsed headings", () => {
    expect(deriveOutlineView(outline, "", new Set([0]))).toEqual([
      { ...outline[0], hasChildren: true },
      { ...outline[4], hasChildren: false },
    ]);
    expect(deriveOutlineView(outline, "", new Set([10]))).toEqual([
      { ...outline[0], hasChildren: true },
      { ...outline[1], hasChildren: true },
      { ...outline[3], hasChildren: false },
      { ...outline[4], hasChildren: false },
    ]);
  });

  it("filters case-insensitively and reveals matches in collapsed branches", () => {
    expect(deriveOutlineView(outline, " RESULT ", new Set([0]))).toEqual([
      { ...outline[2], hasChildren: false },
      { ...outline[4], hasChildren: false },
    ]);
  });
});
