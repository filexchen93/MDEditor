import { EditorSelection } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { createMarkdownFormattingTransaction } from "./formatting.js";
import { createSourceEditorState } from "./source-editor.js";

function format(
  text: string,
  command: Parameters<typeof createMarkdownFormattingTransaction>[1],
  anchor: number,
  head = anchor,
) {
  const initial = createSourceEditorState({ text });
  const selected = initial.update({
    selection: EditorSelection.single(anchor, head),
  }).state;
  return selected.update(createMarkdownFormattingTransaction(selected, command))
    .state;
}

describe("Markdown formatting transactions", () => {
  it("wraps and unwraps inline selections while retaining the content selection", () => {
    const bold = format("make this bold", "bold", 5, 9);
    expect(bold.doc.toString()).toBe("make **this** bold");
    expect(
      bold.sliceDoc(bold.selection.main.from, bold.selection.main.to),
    ).toBe("this");

    const unwrapped = bold.update(
      createMarkdownFormattingTransaction(bold, "bold"),
    ).state;
    expect(unwrapped.doc.toString()).toBe("make this bold");
    expect(
      unwrapped.sliceDoc(
        unwrapped.selection.main.from,
        unwrapped.selection.main.to,
      ),
    ).toBe("this");
  });

  it("inserts editable placeholders for empty inline selections", () => {
    const italic = format("start ", "italic", 6);
    expect(italic.doc.toString()).toBe("start *斜体文本*");
    expect(
      italic.sliceDoc(italic.selection.main.from, italic.selection.main.to),
    ).toBe("斜体文本");

    const link = format("start ", "link", 6);
    expect(link.doc.toString()).toBe("start [链接文本](https://)");
    expect(
      link.sliceDoc(link.selection.main.from, link.selection.main.to),
    ).toBe("链接文本");
  });

  it("uses a safe inline-code fence when content contains backticks", () => {
    const state = format("a `tick` x here", "inlineCode", 2, 10);
    expect(state.doc.toString()).toBe("a `` `tick` x `` here");
    expect(
      state.sliceDoc(state.selection.main.from, state.selection.main.to),
    ).toBe("`tick` x");
    expect(
      state
        .update(createMarkdownFormattingTransaction(state, "inlineCode"))
        .state.doc.toString(),
    ).toBe("a `tick` x here");
  });

  it("removes an existing link when its label or destination is active", () => {
    const linked = format("MDEditor", "link", 0, 8);
    expect(linked.doc.toString()).toBe("[MDEditor](https://)");
    expect(
      linked
        .update(createMarkdownFormattingTransaction(linked, "link"))
        .state.doc.toString(),
    ).toBe("MDEditor");
  });

  it("inserts and removes images while selecting the next editable field", () => {
    const image = format("架构图", "image", 0, 3);
    expect(image.doc.toString()).toBe("![架构图](图片路径)");
    expect(
      image.sliceDoc(image.selection.main.from, image.selection.main.to),
    ).toBe("图片路径");
    expect(
      image
        .update(createMarkdownFormattingTransaction(image, "image"))
        .state.doc.toString(),
    ).toBe("架构图");

    const placeholder = format("", "image", 0);
    expect(placeholder.doc.toString()).toBe("![图片描述](图片路径)");
    expect(
      placeholder.sliceDoc(
        placeholder.selection.main.from,
        placeholder.selection.main.to,
      ),
    ).toBe("图片描述");
  });

  it("formats multiple Unicode selections in one transaction", () => {
    const initial = createSourceEditorState({ text: "中文 and emoji 🙂" });
    const selected = initial.update({
      selection: EditorSelection.create([
        EditorSelection.range(0, 2),
        EditorSelection.range(13, 15),
      ]),
    }).state;
    const state = selected.update(
      createMarkdownFormattingTransaction(selected, "bold"),
    ).state;

    expect(state.doc.toString()).toBe("**中文** and emoji **🙂**");
    expect(state.selection.ranges).toHaveLength(2);
  });

  it("replaces heading levels and toggles the active heading", () => {
    const heading = format("old\nnext", "heading2", 0, 8);
    expect(heading.doc.toString()).toBe("## old\n## next");

    const changed = heading.update(
      createMarkdownFormattingTransaction(heading, "heading1"),
    ).state;
    expect(changed.doc.toString()).toBe("# old\n# next");

    const plain = changed.update(
      createMarkdownFormattingTransaction(changed, "heading1"),
    ).state;
    expect(plain.doc.toString()).toBe("old\nnext");
  });

  it("formats quotes and either list style as reversible block edits", () => {
    const quoted = format("one\ntwo", "blockquote", 0, 7);
    expect(quoted.doc.toString()).toBe("> one\n> two");
    expect(
      quoted
        .update(createMarkdownFormattingTransaction(quoted, "blockquote"))
        .state.doc.toString(),
    ).toBe("one\ntwo");

    const bullets = format("one\ntwo", "bulletList", 0, 7);
    expect(bullets.doc.toString()).toBe("- one\n- two");
    const numbered = bullets.update(
      createMarkdownFormattingTransaction(bullets, "orderedList"),
    ).state;
    expect(numbered.doc.toString()).toBe("1. one\n2. two");
  });

  it("converts mixed lines to task items and toggles them back to plain text", () => {
    const tasks = format("one\n- [x] done", "taskList", 0, 14);
    expect(tasks.doc.toString()).toBe("- [ ] one\n- [x] done");
    const plain = tasks.update(
      createMarkdownFormattingTransaction(tasks, "taskList"),
    ).state;
    expect(plain.doc.toString()).toBe("one\ndone");

    const empty = format("", "taskList", 0);
    expect(empty.doc.toString()).toBe("- [ ] ");
    expect(empty.selection.main.head).toBe(6);
  });

  it("preserves deep nested-list indentation and recognizes ordered task items", () => {
    const nestedSource = "parent\n    nested\n\tdeep tab";
    const nested = format(nestedSource, "bulletList", 0, nestedSource.length);
    expect(nested.doc.toString()).toBe("- parent\n    - nested\n\t- deep tab");
    expect(
      nested
        .update(createMarkdownFormattingTransaction(nested, "orderedList"))
        .state.doc.toString(),
    ).toBe("1. parent\n    1. nested\n\t1. deep tab");

    const orderedTaskSource = "1. [x] first\n    2. [ ] nested";
    const orderedTasks = format(
      orderedTaskSource,
      "taskList",
      0,
      orderedTaskSource.length,
    );
    expect(orderedTasks.doc.toString()).toBe("first\n    nested");
  });

  it("wraps and unwraps fenced code blocks", () => {
    const fenced = format("const n = 1;", "codeBlock", 0, 12);
    expect(fenced.doc.toString()).toBe("```\nconst n = 1;\n```");
    expect(
      fenced.sliceDoc(fenced.selection.main.from, fenced.selection.main.to),
    ).toBe("const n = 1;");

    const unwrapped = fenced.update(
      createMarkdownFormattingTransaction(fenced, "codeBlock"),
    ).state;
    expect(unwrapped.doc.toString()).toBe("const n = 1;");
  });

  it("wraps and unwraps an isolated KaTeX block", () => {
    const math = format("x^2 + y^2", "mathBlock", 0, 9);
    expect(math.doc.toString()).toBe("```katex\nx^2 + y^2\n```");
    expect(
      math.sliceDoc(math.selection.main.from, math.selection.main.to),
    ).toBe("x^2 + y^2");
    expect(
      math
        .update(createMarkdownFormattingTransaction(math, "mathBlock"))
        .state.doc.toString(),
    ).toBe("x^2 + y^2");
  });

  it("inserts tables, rules, a TOC and page breaks without deleting selected text", () => {
    const rule = format("before\nafter", "horizontalRule", 0, 6);
    expect(rule.doc.toString()).toBe("before\n\n---\n\nafter");

    const pageBreak = format("before\nafter", "pageBreak", 0, 6);
    expect(pageBreak.doc.toString()).toBe(
      'before\n\n<div class="page-break"></div>\n\nafter',
    );

    const toc = format("before\nafter", "toc", 0, 6);
    expect(toc.doc.toString()).toBe("before\n\n[toc]\n\nafter");
    expect(toc.selection.main.head).toBe("before\n\n[toc]".length);

    const table = format("保留", "table", 0, 2);
    expect(table.doc.toString()).toBe(
      "保留\n\n| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |",
    );
    expect(
      table.sliceDoc(table.selection.main.from, table.selection.main.to),
    ).toBe("");
    expect(table.selection.main.head).toBe(
      table.doc.toString().indexOf("|  |") + 2,
    );
  });

  it("serializes inserted block newlines with the document line ending", () => {
    const initial = createSourceEditorState({
      text: "one\r\ntwo",
      lineSeparator: "\r\n",
    });
    const selected = initial.update({
      selection: { anchor: 0, head: 7 },
    }).state;
    const state = selected.update(
      createMarkdownFormattingTransaction(selected, "bulletList"),
    ).state;

    expect(state.sliceDoc()).toBe("- one\r\n- two");

    const toc = state.update({ selection: { anchor: state.doc.length } }).state;
    expect(
      toc
        .update(createMarkdownFormattingTransaction(toc, "toc"))
        .state.sliceDoc(),
    ).toBe("- one\r\n- two\r\n\r\n[toc]");
  });
});
