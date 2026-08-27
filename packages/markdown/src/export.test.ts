import { describe, expect, it } from "vitest";

import { createHtmlExportName } from "./export.js";

describe("HTML export naming", () => {
  it("replaces supported Markdown extensions without damaging Unicode names", () => {
    expect(createHtmlExportName("产品说明.MARKDOWN")).toBe("产品说明.html");
    expect(createHtmlExportName("组合字符 é.md")).toBe("组合字符 é.html");
  });

  it("keeps other dotted names and supplies an untitled fallback", () => {
    expect(createHtmlExportName("release.v1")).toBe("release.v1.html");
    expect(createHtmlExportName("   ")).toBe("未命名.html");
  });
});
