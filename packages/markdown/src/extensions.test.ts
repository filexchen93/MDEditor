import { Marked } from "marked";
import { describe, expect, it } from "vitest";

import {
  collectMarkdownExtensionRanges,
  createMarkdownMarkedExtension,
} from "./extensions.js";
import { createMarkdownProfile } from "./profile.js";

function render(source: string): string {
  const parser = new Marked({ async: false, gfm: true });
  parser.use(createMarkdownMarkedExtension(source));
  const result = parser.parse(source);
  if (typeof result !== "string") throw new Error("expected sync HTML");
  return result;
}

describe("Markdown extension derivation", () => {
  it("finds M4 constructs at byte-faithful CRLF offsets", () => {
    const source = [
      "---",
      "title: 示例",
      "---",
      "# 标题",
      "[toc]",
      "> [!WARNING]",
      "> 请谨慎操作。",
      "正文 $x^2$[^来源]",
      "[^来源]: 参考资料",
      "$$",
      "a + b",
      "$$",
    ].join("\r\n");
    const ranges = collectMarkdownExtensionRanges(source);

    expect(ranges.map(({ kind }) => kind)).toEqual([
      "front-matter",
      "toc",
      "alert",
      "inline-math",
      "footnote-reference",
      "footnote-definition",
      "block-math",
    ]);
    for (const range of ranges) {
      expect(source.slice(range.from, range.to)).toBe(range.source);
    }
    expect(ranges.find(({ kind }) => kind === "alert")).toMatchObject({
      alertKind: "warning",
      content: "请谨慎操作。",
    });
    expect(ranges.find(({ kind }) => kind === "block-math")?.content).toBe(
      "a + b",
    );
  });

  it("does not derive disabled features or syntax inside code", () => {
    const source = "`$inline$`\n\n```text\n[toc]\n$inside$\n```\n\n$outside$";
    const disabled = createMarkdownProfile({ inlineMath: false });

    expect(
      collectMarkdownExtensionRanges(source)
        .filter(({ kind }) => kind === "inline-math")
        .map(({ content }) => content),
    ).toEqual(["outside"]);
    expect(
      collectMarkdownExtensionRanges(source, disabled).some(
        ({ kind }) => kind === "inline-math",
      ),
    ).toBe(false);
  });
});

describe("Marked profile extension", () => {
  it("renders front matter, TOC, alerts, math and Mermaid deterministically", () => {
    const source = [
      "---",
      "title: Demo",
      "---",
      "[toc]",
      "# Intro",
      "> [!NOTE]",
      "> **Safe** body",
      "Inline $x < y$.",
      "$$",
      "a < b",
      "$$",
      "```mermaid",
      "flowchart LR",
      "A --> B",
      "```",
    ].join("\n");
    const html = render(source);

    expect(html).toContain('class="md-front-matter"');
    expect(html).toContain('class="md-toc"');
    expect(html).toContain('href="#md-heading-intro"');
    expect(html).toContain('<h1 id="md-heading-intro">Intro</h1>');
    expect(html).toContain('class="md-alert md-alert-note"');
    expect(html).toContain("<strong>Safe</strong>");
    expect(html).toContain('class="md-math md-math-inline"');
    expect(html).toContain("x &lt; y");
    expect(html).toContain('class="md-math md-math-block"');
    expect(html).toContain('class="md-diagram md-diagram-mermaid"');
  });

  it("collects referenced footnotes with stable Unicode-safe backlinks", () => {
    const html = render(
      "正文[^来源]，再次引用[^来源]。\n\n[^来源]: **参考**资料。",
    );

    expect(html).toContain('class="md-footnote-ref"');
    expect(html).toContain('href="#md-footnote-u6765-u6e90"');
    expect(html).toContain('id="md-footnote-u6765-u6e90"');
    expect(html).toContain("<strong>参考</strong>资料。");
    expect(html.match(/md-footnote-backref/gu)).toHaveLength(2);
  });
});
