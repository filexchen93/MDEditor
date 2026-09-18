import { EditorSelection } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  createMarkdownAutoPairTransaction,
  createSourceEditorState,
  getFocusBlockRange,
} from "./source-editor.js";

function stateWithSelection(text: string, anchor: number, head = anchor) {
  const state = createSourceEditorState({ text });
  return state.update({ selection: EditorSelection.range(anchor, head) }).state;
}

describe("Markdown input assistance", () => {
  it("pairs markers, expands an empty pair, and skips closing markers", () => {
    let state = stateWithSelection("", 0);
    let transaction = createMarkdownAutoPairTransaction(state, "*");
    expect(transaction).not.toBeNull();
    state = transaction!.state;
    expect(state.sliceDoc()).toBe("**");
    expect(state.selection.main.head).toBe(1);

    transaction = createMarkdownAutoPairTransaction(state, "*");
    state = transaction!.state;
    expect(state.sliceDoc()).toBe("****");
    expect(state.selection.main.head).toBe(2);

    state = stateWithSelection("**bold**", 6);
    state = createMarkdownAutoPairTransaction(state, "*")!.state;
    expect(state.sliceDoc()).toBe("**bold**");
    expect(state.selection.main.head).toBe(7);
    state = createMarkdownAutoPairTransaction(state, "*")!.state;
    expect(state.selection.main.head).toBe(8);
  });

  it("surrounds selections and keeps the selected content selected", () => {
    let state = stateWithSelection("alpha beta", 0, 5);
    state = createMarkdownAutoPairTransaction(state, "`")!.state;

    expect(state.sliceDoc()).toBe("`alpha` beta");
    expect(
      state.sliceDoc(state.selection.main.from, state.selection.main.to),
    ).toBe("alpha");

    state = stateWithSelection("strike", 0, 6);
    state = createMarkdownAutoPairTransaction(state, "~")!.state;
    expect(state.sliceDoc()).toBe("~~strike~~");
  });

  it("inserts literal markers inside fenced code", () => {
    let state = stateWithSelection("```txt\ncode\n```", 8);
    state = createMarkdownAutoPairTransaction(state, "*")!.state;

    expect(state.sliceDoc()).toBe("```txt\nc*ode\n```");
  });

  it("derives the active focus block without changing source", () => {
    const text = "# Heading\n\nfirst line\nsecond line\n\n## Tail";
    const state = stateWithSelection(text, text.indexOf("second"));
    const range = getFocusBlockRange(state, state.selection.main.head);

    expect(state.sliceDoc(range.from, range.to)).toBe(
      "first line\nsecond line",
    );
    expect(state.sliceDoc()).toBe(text);
  });
});
