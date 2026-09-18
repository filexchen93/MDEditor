import { describe, expect, it } from "vitest";

import { compileDocumentCss } from "./document-css.js";

describe("document CSS", () => {
  it("scopes theme selectors to the selected document surface", () => {
    const source = `
/* @mdeditor-theme Warm Notes */
:root { --md-accent: #a64; color: #432; }
h1, :is(h2, h3) { color: var(--md-accent); border-bottom: 1px solid #dcb; }
@media print { body blockquote { color: #555; } }
`;

    const editor = compileDocumentCss(source, "editor", "theme");
    const exported = compileDocumentCss(source, "export", "theme");

    expect(editor).toContain(
      '.editor-host[data-md-document-style="true"]{--md-accent: #a64;color:#432}',
    );
    expect(editor).toContain(
      '.editor-host[data-md-document-style="true"] h1,.editor-host[data-md-document-style="true"] :is(h2,h3)',
    );
    expect(exported).toContain(
      'body[data-md-document-style="true"] blockquote',
    );
    expect(exported).not.toContain("@mdeditor-theme");
  });

  it("allows advanced trusted layout properties while retaining hard boundaries", () => {
    expect(
      compileDocumentCss(
        ".callout { display: grid; grid-template-columns: 1fr 2fr; }",
        "editor",
        "trusted",
      ),
    ).toContain("display:grid");

    expect(() =>
      compileDocumentCss(".callout { display: grid; }", "editor", "theme"),
    ).toThrow("不允许使用 CSS 属性 display");
  });

  it.each([
    ['@import "https://example.com/theme.css";', "不允许使用 @import"],
    ["p { background: url(https://example.com/pixel); }", "包含外部"],
    ["p { position: fixed; }", "不能使用 fixed"],
    ["body { color: red; } </style>", "HTML 起始字符"],
    ["& .outside { color: red; }", "嵌套或组件越界"],
  ])("rejects unsafe CSS: %s", (source, message) => {
    expect(() => compileDocumentCss(source, "export", "trusted")).toThrow(
      message,
    );
  });
});
