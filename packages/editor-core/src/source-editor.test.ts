import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";

import { createSourceEditorState } from "./source-editor.js";

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
});
