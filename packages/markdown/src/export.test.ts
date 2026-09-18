import { describe, expect, it } from "vitest";

import {
  createDocxExportName,
  createHtmlExportName,
  createImageExportName,
  createSafeHtmlDocument,
} from "./export.js";

describe("HTML export naming", () => {
  it("replaces supported Markdown extensions without damaging Unicode names", () => {
    expect(createHtmlExportName("产品说明.MARKDOWN")).toBe("产品说明.html");
    expect(createHtmlExportName("组合字符 é.md")).toBe("组合字符 é.html");
  });

  it("keeps other dotted names and supplies an untitled fallback", () => {
    expect(createHtmlExportName("release.v1")).toBe("release.v1.html");
    expect(createHtmlExportName("   ")).toBe("未命名.html");
  });

  it("distinguishes an unstyled derivative without changing the source name", () => {
    expect(createHtmlExportName("产品说明.md", "unstyled")).toBe(
      "产品说明.unstyled.html",
    );
  });

  it("creates a PNG derivative name without damaging dotted names", () => {
    expect(createImageExportName("产品说明.MARKDOWN")).toBe("产品说明.png");
    expect(createImageExportName("release.v1")).toBe("release.v1.png");
    expect(createImageExportName("   ")).toBe("未命名.png");
  });

  it("creates a DOCX derivative name without damaging Unicode or dotted names", () => {
    expect(createDocxExportName("产品说明.MARKDOWN")).toBe("产品说明.docx");
    expect(createDocxExportName("release.v1")).toBe("release.v1.docx");
    expect(createDocxExportName("   ")).toBe("未命名.docx");
  });
});

describe("safe HTML document shell", () => {
  const body = '<h1 id="safe">安全正文</h1>';

  it("wraps the shared safe body with the styled export presentation", () => {
    const html = createSafeHtmlDocument({
      body,
      printLayout: {
        pageSize: "Letter",
        orientation: "landscape",
        margin: "narrow",
        pageBreakBetweenTopLevelHeadings: true,
        headerTemplate: "",
        footerTemplate: "",
      },
      theme: "dark",
      title: '标题 <script>alert("x")</script>',
    });

    expect(html).toContain("<style>");
    expect(html).toContain("@media print");
    expect(html).toContain("@page { size: Letter landscape; margin: 10mm; }");
    expect(html).toContain(
      "body > h1 ~ h1, body > .md-footnotes { break-before: page; page-break-before: always; }",
    );
    expect(html).toContain(
      ".page-break { display: block; break-after: page; page-break-after: always; }",
    );
    expect(html).toContain('<body data-theme="dark">');
    expect(html).toContain("style-src 'unsafe-inline'");
    expect(html).toContain(body);
    expect(html).toContain(
      "<title>标题 &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</title>",
    );
  });

  it("emits the same safe body without presentation CSS when unstyled", () => {
    const html = createSafeHtmlDocument({
      body,
      style: "unstyled",
      theme: "paper",
      title: "无样式",
    });

    expect(html).not.toContain("<style>");
    expect(html).not.toContain("data-theme");
    expect(html).toContain("style-src 'none'");
    expect(html).toContain(body);
  });

  it("scopes installed and trusted CSS to styled document output only", () => {
    const options = {
      body,
      documentThemeCss: "h1 { color: #864; }",
      theme: "paper" as const,
      title: "Scoped theme",
      trustedDocumentCss: ".md-alert { display: grid; }",
    };
    const styled = createSafeHtmlDocument(options);
    const unstyled = createSafeHtmlDocument({
      ...options,
      style: "unstyled",
    });

    expect(styled).toContain('body[data-md-document-style="true"] h1');
    expect(styled).toContain('body[data-md-document-style="true"] .md-alert');
    expect(styled).toContain(
      '<body data-theme="paper" data-md-document-style="true">',
    );
    expect(unstyled).not.toContain("data-md-document-style");
    expect(unstyled).not.toContain("color: #864");
    expect(unstyled).not.toContain("display:grid");
  });

  it("does not add automatic page breaks unless the print control is enabled", () => {
    const html = createSafeHtmlDocument({
      body,
      theme: "paper",
      title: "No automatic page breaks",
    });

    expect(html).not.toContain("body > h1 ~ h1");
    expect(html).toContain(".page-break { display: none; }");
  });

  it("emits safe print margin boxes with document and page variables", () => {
    const html = createSafeHtmlDocument({
      body,
      printLayout: {
        pageSize: "A4",
        orientation: "portrait",
        margin: "normal",
        pageBreakBetweenTopLevelHeadings: false,
        headerTemplate: "${title}",
        footerTemplate: "第 ${pageNo} / ${pageCount} 页",
      },
      theme: "paper",
      title: '标题 </style><script>alert("x")</script>',
    });

    expect(html).toContain("@top-center");
    expect(html).toContain("@bottom-center");
    expect(html).toContain(
      'content: "标题 \\3c /style\\3e \\3c script\\3e alert(\\"x\\")\\3c /script\\3e ";',
    );
    expect(html).toContain(
      'content: "第 " counter(page) " / " counter(pages) " 页";',
    );
    expect(html.match(/<style>/gu)).toHaveLength(1);
    expect(html).not.toContain('<script>alert("x")</script>');
  });
});
