import { describe, expect, it } from "vitest";

import { coreDialect, isCoreExtension } from "./index.js";

describe("coreDialect", () => {
  it("uses CommonMark with the documented GFM feature set", () => {
    expect(coreDialect.base).toBe("commonmark");
    expect(coreDialect.extensions).toEqual([
      "gfm-autolink",
      "gfm-strikethrough",
      "gfm-table",
      "gfm-task-list",
    ]);
    expect(isCoreExtension("gfm-table")).toBe(true);
    expect(isCoreExtension("footnotes")).toBe(false);
  });
});
