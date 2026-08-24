import {
  history,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { createSourceEditorState } from "./source-editor.js";
import {
  collectProgressiveDecorations,
  createEditorModeExtension,
  sanitizeImageSource,
} from "./progressive-rendering.js";

describe("progressive Markdown rendering", () => {
  it("derives every M2 decoration family without changing source text", () => {
    const text = [
      "# Heading *emphasis* **strong**",
      "",
      "> quoted [link](https://example.com)",
      "",
      "- list item",
      "",
      "![diagram](https://example.com/diagram.png)",
      "",
      "`inline code`",
    ].join("\n");
    const state = createSourceEditorState({ text, mode: "hybrid" });
    const before = state.sliceDoc();
    const kinds = new Set(
      collectProgressiveDecorations(state).map(({ kind }) => kind),
    );

    expect([...kinds]).toEqual(
      expect.arrayContaining([
        "heading-1",
        "emphasis",
        "strong",
        "link",
        "quote-line",
        "list-line",
        "image",
        "code",
        "syntax",
      ]),
    );
    expect(state.sliceDoc()).toBe(before);
  });

  it("keeps image metadata derived and rejects active content protocols", () => {
    const state = createSourceEditorState({
      text: "![safe](https://example.com/a.png) ![unsafe](javascript:alert(1))",
      mode: "hybrid",
    });
    const images = collectProgressiveDecorations(state).filter(
      ({ kind }) => kind === "image",
    );

    expect(images).toHaveLength(2);
    expect(images[0]?.image).toEqual({
      alt: "safe",
      source: "https://example.com/a.png",
    });
    expect(images[1]?.image).toEqual({ alt: "unsafe", source: null });
    expect(sanitizeImageSource("file:///secret.png")).toBeNull();
    expect(
      sanitizeImageSource("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="),
    ).toBeNull();
    expect(sanitizeImageSource("data:image/png;base64,iVBORw0KGgo=")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });

  it("only visits the requested viewport range", () => {
    const state = createSourceEditorState({
      text: "# first\n\nplain\n\n## second",
      mode: "hybrid",
    });
    const secondHeading = state.sliceDoc().indexOf("## second");
    const specs = collectProgressiveDecorations(
      state,
      secondHeading,
      state.doc.length,
    );

    expect(specs.some(({ kind }) => kind === "heading-1")).toBe(false);
    expect(specs.some(({ kind }) => kind === "heading-2")).toBe(true);
  });

  it("reconfigures rendering without touching selection or undo history", () => {
    const rendering = new Compartment();
    let state = EditorState.create({
      doc: "alpha",
      selection: { anchor: 5 },
      extensions: [
        history(),
        rendering.of(createEditorModeExtension("source")),
      ],
    });
    state = state.update({
      changes: { from: 5, insert: " 中文" },
      selection: { anchor: 8 },
    }).state;
    const selectionBeforeToggle = state.selection;

    state = state.update({
      effects: rendering.reconfigure(createEditorModeExtension("hybrid")),
    }).state;

    expect(state.sliceDoc()).toBe("alpha 中文");
    expect(state.selection.eq(selectionBeforeToggle)).toBe(true);
    expect(undoDepth(state)).toBe(1);

    expect(
      undo({
        state,
        dispatch: (transaction) => {
          state = transaction.state;
        },
      }),
    ).toBe(true);
    expect(state.sliceDoc()).toBe("alpha");
    expect(redoDepth(state)).toBe(1);

    expect(
      redo({
        state,
        dispatch: (transaction) => {
          state = transaction.state;
        },
      }),
    ).toBe(true);
    expect(state.sliceDoc()).toBe("alpha 中文");
  });
});
