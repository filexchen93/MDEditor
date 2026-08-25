import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";

import {
  collectDocumentOutline,
  createSourceEditorState,
  getTableCellTarget,
} from "./source-editor.js";

describe("source editor state", () => {
  it("round-trips CRLF through CodeMirror when configured", () => {
    const text = "first\r\nsecond\r\n";
    const state = createSourceEditorState({ text, lineSeparator: "\r\n" });

    expect(state.doc.toString()).toBe("first\nsecond\n");
    expect(state.sliceDoc()).toBe(text);
    expect(state.lineBreak).toBe("\r\n");
  });

  it("exposes a read-only state for unsupported documents", () => {
    const state = createSourceEditorState({ text: "visible", readOnly: true });

    expect(state.readOnly).toBe(true);
    expect(state.doc.toString()).toBe("visible");
  });

  it("mounts a language parser for named fenced code", () => {
    const text = "```js\nconst answer = 42\n```";
    const state = createSourceEditorState({ text });
    const variablePosition = text.indexOf("answer") + 1;

    const tree = ensureSyntaxTree(state, state.doc.length, 1000);

    expect(tree?.resolveInner(variablePosition, 1).name).toBe(
      "VariableDefinition",
    );
  });

  it("parses the declared GFM dialect without enabling optional syntax", () => {
    const text = [
      "- [ ] task",
      "",
      "| A | B |",
      "| --- | --- |",
      "| one | two |",
      "",
      "~~done~~ www.example.com ^not-superscript^",
    ].join("\n");
    const state = createSourceEditorState({ text });
    const tree = ensureSyntaxTree(state, state.doc.length, 1000);
    const names: string[] = [];
    tree?.iterate({
      enter: ({ name }) => {
        names.push(name);
      },
    });

    expect(names).toEqual(
      expect.arrayContaining([
        "Task",
        "TaskMarker",
        "Table",
        "TableCell",
        "Strikethrough",
        "URL",
      ]),
    );
    expect(names).not.toContain("Superscript");
  });

  it("navigates every table cell and appends a row after the last cell", () => {
    const text = ["| A\\|A | B |", "| --- | --- |", "| one |  |"].join("\n");
    const state = createSourceEditorState({ text });
    const bodyLine = state.doc.line(3);

    const emptyCell = getTableCellTarget(state, text.indexOf("one") + 1, 1);
    expect(emptyCell).toEqual({ anchor: bodyLine.to - 2 });

    const appended = getTableCellTarget(state, bodyLine.to - 2, 1);
    expect(appended).toEqual({
      anchor: text.length + 3,
      append: { from: text.length, insert: "\n|  |  |" },
    });

    const previous = getTableCellTarget(state, bodyLine.to - 2, -1);
    expect(previous).toEqual({ anchor: bodyLine.from + 2 });
  });

  it("keeps CodeMirror offsets correct when table cells contain emoji", () => {
    const text = ["| 🙂 | B |", "| --- | --- |", "| C | D |"].join("\n");
    const state = createSourceEditorState({ text });
    const target = getTableCellTarget(state, text.indexOf("🙂") + 1, 1);

    expect(target).toEqual({ anchor: text.indexOf("B") });
  });

  it("derives heading levels and edit positions without reading fenced code", () => {
    const text = [
      "# Top **bold** #",
      "",
      "Setext title",
      "============",
      "",
      "```md",
      "# hidden",
      "```",
      "",
      "###",
      "",
      "  ## Nested",
    ].join("\n");
    const state = createSourceEditorState({ text });
    const tree = ensureSyntaxTree(state, state.doc.length, 1000);

    expect(tree).not.toBeNull();
    expect(collectDocumentOutline(state, tree ?? undefined)).toEqual([
      { level: 1, text: "Top **bold**", from: text.indexOf("Top") },
      {
        level: 1,
        text: "Setext title",
        from: text.indexOf("Setext title"),
      },
      { level: 3, text: "无标题", from: text.indexOf("###") + 3 },
      { level: 2, text: "Nested", from: text.indexOf("Nested") },
    ]);
  });
});
