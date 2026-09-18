import { undo, undoDepth } from "@codemirror/commands";
import { describe, expect, it } from "vitest";

import { createSourceEditorState } from "./source-editor.js";
import {
  createTableEditTransaction,
  parseGfmTable,
  serializeGfmTable,
  type TableEditCommand,
} from "./table.js";

function edit(
  text: string,
  command: TableEditCommand,
  needle: string,
  lineSeparator: "\n" | "\r\n" = "\n",
) {
  let state = createSourceEditorState({
    text,
    lineSeparator,
    mode: "source",
  });
  const normalizedText = state.doc.toString();
  state = state.update({
    selection: {
      anchor: normalizedText.indexOf(needle) + Math.max(0, needle.length - 1),
    },
  }).state;
  const transaction = createTableEditTransaction(state, command);
  if (transaction === null) throw new Error(`command ${command} was rejected`);
  return state.update(transaction).state;
}

describe("GFM table model", () => {
  it("parses escaped pipes, code spans, Unicode and alignment", () => {
    const source = [
      "| 名称\\|别名 | `a|b` | 🙂 |",
      "| :--- | :---: | ---: |",
      "| 一 | 二 | 三 |",
    ].join("\n");
    const table = parseGfmTable(source);

    expect(table).toEqual({
      header: ["名称\\|别名", "`a|b`", "🙂"],
      alignments: ["left", "center", "right"],
      rows: [["一", "二", "三"]],
    });
    expect(serializeGfmTable(table!)).toBe(source);
  });

  it("normalizes short body rows without losing source cell content", () => {
    expect(parseGfmTable("A | B | C\n--- | --- | ---\n值 |")?.rows).toEqual([
      ["值", "", ""],
    ]);
    expect(parseGfmTable("| A |\n| nope |")).toBeNull();
  });
});

describe("table structure transactions", () => {
  const source = [
    "| A | B |",
    "| --- | :---: |",
    "| a1 | b1 |",
    "| a2 | b2 |",
  ].join("\n");

  it("adds, deletes and moves rows as one source replacement", () => {
    const inserted = edit(source, "addRowBefore", "a2");
    expect(inserted.doc.toString()).toBe(
      [
        "| A | B |",
        "| --- | :---: |",
        "| a1 | b1 |",
        "|  |  |",
        "| a2 | b2 |",
      ].join("\n"),
    );
    expect(undoDepth(inserted)).toBe(1);

    let undone = inserted;
    expect(
      undo({
        state: undone,
        dispatch: (transaction) => {
          undone = transaction.state;
        },
      }),
    ).toBe(true);
    expect(undone.doc.toString()).toBe(source);

    expect(edit(source, "deleteRow", "a1").doc.toString()).not.toContain("a1");
    expect(edit(source, "moveRowUp", "a2").doc.toString()).toContain(
      "| a2 | b2 |\n| a1 | b1 |",
    );
    expect(edit(source, "moveRowDown", "a1").doc.toString()).toContain(
      "| a2 | b2 |\n| a1 | b1 |",
    );
  });

  it("adds, deletes, moves and aligns columns while preserving CRLF", () => {
    const crlf = source.replaceAll("\n", "\r\n");
    const inserted = edit(crlf, "addColumnBefore", "b1", "\r\n");
    expect(inserted.doc.toString()).toBe(
      [
        "| A |  | B |",
        "| --- | --- | :---: |",
        "| a1 |  | b1 |",
        "| a2 |  | b2 |",
      ].join("\n"),
    );
    expect(inserted.lineBreak).toBe("\r\n");

    expect(edit(source, "deleteColumn", "b1").doc.toString()).toBe(
      "| A |\n| --- |\n| a1 |\n| a2 |",
    );
    expect(edit(source, "moveColumnLeft", "b1").doc.toString()).toBe(
      "| B | A |\n| :---: | --- |\n| b1 | a1 |\n| b2 | a2 |",
    );
    expect(edit(source, "alignRight", "a1").doc.toString()).toContain(
      "| ---: | :---: |",
    );
    expect(edit(source, "alignDefault", "b1").doc.toString()).toContain(
      "| --- | --- |",
    );
  });

  it("rejects destructive boundary operations", () => {
    let state = createSourceEditorState({
      text: "| A |\n| --- |\n| only |",
      mode: "source",
    });
    state = state.update({ selection: { anchor: state.doc.length - 2 } }).state;

    expect(createTableEditTransaction(state, "deleteColumn")).toBeNull();
    expect(createTableEditTransaction(state, "moveColumnLeft")).toBeNull();
    expect(createTableEditTransaction(state, "moveRowUp")).toBeNull();
    expect(createTableEditTransaction(state, "moveRowDown")).toBeNull();
  });
});
