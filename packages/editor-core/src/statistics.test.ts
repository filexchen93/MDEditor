import { EditorSelection } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { createSourceEditorState } from "./source-editor.js";
import {
  calculateEditorStatistics,
  calculateTextStatistics,
} from "./statistics.js";

describe("document statistics", () => {
  it("counts Chinese characters, Latin words, Unicode code points and lines", () => {
    expect(calculateTextStatistics("中文 hello world 🙂\n第二行")).toEqual({
      words: 7,
      characters: 19,
      nonWhitespaceCharacters: 16,
      lines: 2,
      readingTimeMinutes: 1,
    });
    expect(calculateTextStatistics("")).toEqual({
      words: 0,
      characters: 0,
      nonWhitespaceCharacters: 0,
      lines: 1,
      readingTimeMinutes: 0,
    });
  });

  it("derives merged multi-selection statistics without changing state", async () => {
    const text = "中文 alpha\nsecond line\n尾部";
    const initial = createSourceEditorState({ text });
    const state = initial.update({
      selection: EditorSelection.create([
        EditorSelection.range(0, 2),
        EditorSelection.range(text.indexOf("second"), text.indexOf("line") + 4),
      ]),
    }).state;
    const statistics = await calculateEditorStatistics(state);

    expect(statistics?.document).toMatchObject({ words: 7, lines: 3 });
    expect(statistics?.selection).toEqual({
      words: 4,
      characters: 13,
      nonWhitespaceCharacters: 12,
      lines: 2,
      readingTimeMinutes: 1,
    });
    expect(state.sliceDoc()).toBe(text);
  });

  it("cancels stale work without publishing partial results", async () => {
    const state = createSourceEditorState({
      text: Array.from({ length: 2_000 }, () => "一行文字").join("\n"),
    });
    let current = true;
    const calculation = calculateEditorStatistics(state, () => current);
    current = false;
    expect(await calculation).toBeNull();
  });
});
