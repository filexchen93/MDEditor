import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { collectSpellcheckWords, findMisspelledWords } from "./spellcheck.js";

function markdownState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
}

describe("spellcheck", () => {
  it("collects prose and link labels while ignoring syntax-only regions", () => {
    const doc = [
      "A wrng sentence with MDEditor and NASA.",
      "[wrng](https://example.com/wrng-path)",
      "`const wrng = true`",
      "~~~js",
      "const wrng = true;",
      "~~~",
      "<span>wrng</span>",
      "contact@example.com src/wrng-file.ts",
    ].join("\n");
    const state = markdownState(doc);

    expect(
      collectSpellcheckWords(state, [{ from: 0, to: state.doc.length }])
        .filter(({ word }) => word === "wrng")
        .map(({ from }) => state.doc.lineAt(from).number),
    ).toEqual([1, 2]);
  });

  it("returns only words rejected by the active dictionary", () => {
    const state = markdownState("Correct wrng words");
    const rejected = findMisspelledWords(
      state,
      [{ from: 0, to: state.doc.length }],
      { correct: (word) => word.toLocaleLowerCase() !== "wrng" },
    );

    expect(rejected).toEqual([{ from: 8, to: 12, word: "wrng" }]);
  });

  it("honours visible ranges and caps the amount of work", () => {
    const state = markdownState("one two three four five");

    expect(collectSpellcheckWords(state, [{ from: 4, to: 18 }], 2)).toEqual([
      { from: 4, to: 7, word: "two" },
      { from: 8, to: 13, word: "three" },
    ]);
  });
});
