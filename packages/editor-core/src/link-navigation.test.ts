import { describe, expect, it } from "vitest";

import {
  createMarkdownImageInsertionTransaction,
  createSourceEditorState,
  headingPositionForFragment,
  linkTargetAtPosition,
} from "./source-editor.js";

describe("Markdown link navigation", () => {
  it("extracts inline, local, fragment and autolink targets", () => {
    const source = [
      "[web](https://example.com/path)",
      "[local](../指南/说明%20文档.md#章节)",
      "[heading](#当前标题)",
      "<person@example.com>",
      "plain text",
    ].join("\n");
    const state = createSourceEditorState({ text: source });

    expect(linkTargetAtPosition(state, source.indexOf("web"))).toBe(
      "https://example.com/path",
    );
    expect(linkTargetAtPosition(state, source.indexOf("local"))).toBe(
      "../指南/说明%20文档.md#章节",
    );
    expect(linkTargetAtPosition(state, source.indexOf("heading"))).toBe(
      "#当前标题",
    );
    expect(linkTargetAtPosition(state, source.indexOf("person"))).toBe(
      "mailto:person@example.com",
    );
    expect(linkTargetAtPosition(state, source.indexOf("plain"))).toBeNull();
  });

  it("resolves Unicode, exported and duplicate heading fragments", () => {
    const source = "# 当前标题\n\n## Repeat\n\n## Repeat\n";
    const state = createSourceEditorState({ text: source });

    expect(
      headingPositionForFragment(state, "%E5%BD%93%E5%89%8D%E6%A0%87%E9%A2%98"),
    ).toBe(source.indexOf("当前标题"));
    expect(headingPositionForFragment(state, "md-heading-repeat-2")).toBe(
      source.lastIndexOf("Repeat"),
    );
    expect(headingPositionForFragment(state, "%not-valid")).toBeNull();
  });

  it("inserts an imported image as one undoable Markdown transaction", () => {
    const state = createSourceEditorState({ text: "封面说明" });
    const selected = state.update({ selection: { anchor: 0, head: 4 } }).state;
    const transaction = createMarkdownImageInsertionTransaction(
      selected,
      "../assets/cover%20final.png",
      "cover final",
    );

    expect(transaction).not.toBeNull();
    expect(transaction?.state.doc.toString()).toBe(
      "![封面说明](../assets/cover%20final.png)",
    );
    expect(
      createMarkdownImageInsertionTransaction(selected, "bad path.png", "x"),
    ).toBeNull();
  });
});
