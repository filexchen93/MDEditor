import {
  history,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { createMarkdownProfile } from "@mdeditor/markdown";
import { describe, expect, it } from "vitest";

import {
  createEditorPreferencesExtension,
  createSourceEditorState,
} from "./source-editor.js";
import {
  collectProgressiveDecorations,
  createEditorModeExtension,
  isProgressiveSyntaxActive,
  sanitizeImageSource,
} from "./progressive-rendering.js";

describe("progressive Markdown rendering", () => {
  it("derives reversible previews only for supported inline and block HTML", () => {
    const text = [
      "按 <kbd>Ctrl</kbd> 与 <sub>2</sub>，再换行<br>。",
      "",
      "<details><summary>说明</summary>安全内容</details>",
      "",
      "<script>alert(1)</script>",
      "",
      '<div onclick="alert(1)">危险属性</div>',
      "",
      '<div class="page-break"></div>',
    ].join("\n");
    const state = createSourceEditorState({ text, mode: "hybrid" });
    const previews = collectProgressiveDecorations(state).filter(
      ({ kind }) => kind === "html-preview",
    );

    expect(previews.map(({ html }) => html?.source)).toEqual([
      "<kbd>Ctrl</kbd>",
      "<sub>2</sub>",
      "<br>",
      "<details><summary>说明</summary>安全内容</details>",
    ]);
    expect(state.sliceDoc()).toBe(text);
  });

  it("derives every M2 decoration family without changing source text", () => {
    const text = [
      "# Heading *emphasis* **strong**",
      "",
      "> quoted [link](https://example.com)",
      "",
      "- list item",
      "- [ ] open task",
      "",
      "| Column | Value |",
      "| --- | --- |",
      "| A | ~~removed~~ |",
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
        "task",
        "table-line",
        "table-preview",
        "strikethrough",
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
      markdown: "![safe](https://example.com/a.png)",
    });
    expect(images[1]?.image).toEqual({
      alt: "unsafe",
      source: null,
      markdown: "![unsafe](javascript:alert(1))",
    });
    expect(sanitizeImageSource("file:///secret.png")).toBeNull();
    expect(sanitizeImageSource("<javascript:alert(1)>")).toBeNull();
    expect(
      sanitizeImageSource("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="),
    ).toBeNull();
    expect(sanitizeImageSource("data:image/png;base64,iVBORw0KGgo=")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(sanitizeImageSource("HTTPS://example.com/cover.png")).toBe(
      "HTTPS://example.com/cover.png",
    );
  });

  it("recognizes Windows absolute image references for the scoped native resolver", () => {
    const path = String.raw`C:\Users\batchat\Downloads\截图.png`;
    const state = createSourceEditorState({
      text: `![图片描述](${path})`,
      mode: "hybrid",
    });
    const image = collectProgressiveDecorations(state).find(
      ({ kind }) => kind === "image",
    );
    expect(image?.image?.source).toBe(path);
    const spacedPath = String.raw`C:\中文 路径\截图.png`;
    const bracketed = createSourceEditorState({
      text: `![图片描述](<${spacedPath}>)`,
      mode: "hybrid",
    });
    const bracketedImage = collectProgressiveDecorations(bracketed).find(
      ({ kind }) => kind === "image",
    );
    expect(bracketedImage?.image?.source).toBe(spacedPath);
  });

  it("derives isolated KaTeX and Mermaid blocks without changing source", () => {
    const text = [
      "```math",
      "x^2 + y^2 = z^2",
      "```",
      "",
      "```mermaid",
      "flowchart LR",
      "A --> B",
      "```",
    ].join("\n");
    const state = createSourceEditorState({ text, mode: "hybrid" });
    const blocks = collectProgressiveDecorations(state).filter(
      ({ kind }) => kind === "complex-block",
    );

    expect(blocks.map(({ complex }) => complex)).toEqual([
      {
        kind: "katex",
        source: "x^2 + y^2 = z^2",
        markdown: "```math\nx^2 + y^2 = z^2\n```",
      },
      {
        kind: "mermaid",
        source: "flowchart LR\nA --> B",
        markdown: "```mermaid\nflowchart LR\nA --> B\n```",
      },
    ]);
    expect(state.sliceDoc()).toBe(text);
  });

  it("uses the shared profile for M4 extension previews", () => {
    const text = [
      "---",
      "title: 示例",
      "---",
      "[toc]",
      "> [!TIP]",
      "> 使用共享语法。",
      "正文 $x^2$[^说明]",
      "[^说明]: 脚注内容",
      "$$E = mc^2$$",
    ].join("\n");
    const state = createSourceEditorState({ text, mode: "hybrid" });
    const specs = collectProgressiveDecorations(state);

    expect(
      specs
        .filter(({ kind }) => kind === "extension-preview")
        .map(({ extension }) => extension?.kind),
    ).toEqual([
      "front-matter",
      "toc",
      "alert",
      "footnote-reference",
      "footnote-definition",
    ]);
    expect(
      specs
        .filter(({ kind }) => kind.startsWith("complex-"))
        .map(({ complex }) => complex?.source),
    ).toEqual(expect.arrayContaining(["x^2", "E = mc^2"]));

    const portable = createMarkdownProfile({
      alerts: false,
      inlineMath: false,
    });
    const portableSpecs = collectProgressiveDecorations(
      state,
      0,
      state.doc.length,
      portable,
    );
    expect(
      portableSpecs.some(({ extension }) => extension?.kind === "alert"),
    ).toBe(false);
    expect(portableSpecs.some(({ kind }) => kind === "complex-inline")).toBe(
      false,
    );
    expect(state.sliceDoc()).toBe(text);
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

  it("derives a reversible horizontal-rule preview without changing source", () => {
    const text = "before\n\n---\n\nafter";
    const initial = createSourceEditorState({ text, mode: "hybrid" });
    const state = initial.update({ selection: { anchor: text.length } }).state;
    const rule = collectProgressiveDecorations(state).find(
      ({ kind }) => kind === "horizontal-rule",
    );

    expect(rule).toMatchObject({
      kind: "horizontal-rule",
      from: text.indexOf("---"),
      to: text.indexOf("---") + 3,
      horizontalRule: { source: "---" },
    });
    expect(state.sliceDoc()).toBe(text);
  });

  it("derives source-safe syntax owners for active-structure live preview", () => {
    const text =
      "# title *强调* [链接](https://example.com)\n\n- item\n\nplain";
    const initial = createSourceEditorState({ text, mode: "hybrid" });
    const inactive = initial.update({
      selection: { anchor: initial.doc.length },
    }).state;
    const syntax = collectProgressiveDecorations(inactive).filter(
      (spec) => spec.kind === "syntax" && spec.syntax !== undefined,
    );

    expect(syntax.map((spec) => spec.syntax?.source)).toEqual(
      expect.arrayContaining([
        "#",
        "*",
        "[",
        "]",
        "(",
        "https://example.com",
        ")",
        "-",
      ]),
    );
    expect(
      syntax.find((spec) => spec.syntax?.source === "-")?.syntax?.previewText,
    ).toBe("•");
    expect(
      syntax.every((spec) => !isProgressiveSyntaxActive(inactive, spec)),
    ).toBe(true);

    const emphasisPosition = text.indexOf("强调") + 1;
    const active = inactive.update({
      selection: { anchor: emphasisPosition },
    }).state;
    const emphasisMarks = syntax.filter(
      (spec) =>
        spec.syntax?.source === "*" &&
        spec.syntax.ownerFrom <= emphasisPosition &&
        spec.syntax.ownerTo >= emphasisPosition,
    );
    expect(emphasisMarks).toHaveLength(2);
    expect(
      emphasisMarks.every((spec) => isProgressiveSyntaxActive(active, spec)),
    ).toBe(true);
    expect(active.sliceDoc()).toBe(text);
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

  it("reconfigures editor preferences without touching text or history", () => {
    const preferences = new Compartment();
    let state = EditorState.create({
      doc: "draft",
      extensions: [
        history(),
        preferences.of(
          createEditorPreferencesExtension({
            fontSize: 16,
            lineWrapping: false,
          }),
        ),
      ],
    });
    state = state.update({
      changes: { from: 5, insert: " text" },
      selection: { anchor: 10 },
    }).state;
    const selection = state.selection;

    state = state.update({
      effects: preferences.reconfigure(
        createEditorPreferencesExtension({
          fontSize: 22,
          lineWrapping: true,
        }),
      ),
    }).state;

    expect(state.sliceDoc()).toBe("draft text");
    expect(state.selection.eq(selection)).toBe(true);
    expect(undoDepth(state)).toBe(1);
  });
});
