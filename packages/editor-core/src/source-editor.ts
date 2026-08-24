import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";

import {
  createEditorModeExtension,
  type EditorMode,
} from "./progressive-rendering.js";

export type EditorLineSeparator = "\n" | "\r\n";

export interface SourceEditorOptions {
  readonly parent: HTMLElement;
  readonly text: string;
  readonly lineSeparator?: EditorLineSeparator;
  readonly readOnly?: boolean;
  readonly fontSize?: number;
  readonly lineWrapping?: boolean;
  readonly mode?: EditorMode;
  readonly onTextChange?: (text: string) => void;
}

export interface SourceEditorStateOptions {
  readonly text: string;
  readonly lineSeparator?: EditorLineSeparator;
  readonly readOnly?: boolean;
  readonly fontSize?: number;
  readonly lineWrapping?: boolean;
  readonly mode?: EditorMode;
  readonly onTextChange?: (text: string) => void;
}

export interface SourceEditor {
  readonly getText: () => string;
  readonly focus: () => void;
  readonly replaceText: (text: string) => void;
  readonly applyTextChange: (change: SourceEditorChange) => void;
  readonly getMode: () => EditorMode;
  readonly setMode: (mode: EditorMode) => void;
  readonly destroy: () => void;
}

export interface SourceEditorChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

const codeLanguages = [
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "jsx"],
    support: javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts", "tsx"],
    support: javascript({ jsx: true, typescript: true }),
  }),
  LanguageDescription.of({
    name: "JSON",
    alias: ["jsonc"],
    support: javascript(),
  }),
  LanguageDescription.of({ name: "HTML", support: html() }),
  LanguageDescription.of({ name: "CSS", support: css() }),
] as const;

const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, class: "cm-code-keyword" },
  { tag: [tags.string, tags.special(tags.string)], class: "cm-code-string" },
  { tag: [tags.number, tags.bool, tags.null], class: "cm-code-literal" },
  { tag: [tags.lineComment, tags.blockComment], class: "cm-code-comment" },
  { tag: tags.definition(tags.variableName), class: "cm-code-definition" },
  { tag: tags.function(tags.variableName), class: "cm-code-function" },
]);

function createEditorTheme(fontSize: number) {
  return EditorView.theme({
    "&": {
      height: "100%",
      color: "#292722",
      backgroundColor: "transparent",
      fontSize: `${fontSize}px`,
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      lineHeight: "1.75",
    },
    ".cm-content": {
      width: "min(820px, 100%)",
      minHeight: "100%",
      margin: "0 auto",
      padding: "52px 48px 140px",
      caretColor: "#9b5c39",
    },
    ".cm-gutters": {
      color: "#aaa398",
      backgroundColor: "transparent",
      border: "none",
    },
    ".cm-activeLine, .cm-activeLineGutter": {
      backgroundColor: "#8d65480a",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "#d9bca780 !important",
    },
    ".cm-code-keyword": { color: "#8d3f55", fontWeight: "650" },
    ".cm-code-string": { color: "#537342" },
    ".cm-code-literal": { color: "#87551f" },
    ".cm-code-comment": { color: "#8b857c", fontStyle: "italic" },
    ".cm-code-definition, .cm-code-function": { color: "#3e6680" },
    "&.cm-focused": {
      outline: "none",
    },
  });
}

function createState(
  options: SourceEditorStateOptions,
  renderingExtension: Extension,
): EditorState {
  const readOnly = options.readOnly ?? false;

  return EditorState.create({
    doc: options.text,
    extensions: [
      basicSetup,
      markdown({ codeLanguages }),
      syntaxHighlighting(codeHighlightStyle),
      createEditorTheme(options.fontSize ?? 16),
      ...(options.lineWrapping ? [EditorView.lineWrapping] : []),
      EditorState.lineSeparator.of(options.lineSeparator ?? "\n"),
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      renderingExtension,
      EditorView.contentAttributes.of({
        "aria-label": "Markdown 源码编辑器",
        ...(readOnly ? { tabindex: "0" } : {}),
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) options.onTextChange?.(update.state.sliceDoc());
      }),
    ],
  });
}

export function createSourceEditorState(
  options: SourceEditorStateOptions,
): EditorState {
  return createState(
    options,
    createEditorModeExtension(options.mode ?? "source"),
  );
}

export function createSourceEditor(options: SourceEditorOptions): SourceEditor {
  const rendering = new Compartment();
  let mode = options.mode ?? "source";
  const view = new EditorView({
    parent: options.parent,
    state: createState(options, rendering.of(createEditorModeExtension(mode))),
  });

  return {
    getText: () => view.state.sliceDoc(),
    focus: () => view.focus(),
    replaceText: (text) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    },
    applyTextChange: (change) => {
      view.dispatch({ changes: change });
    },
    getMode: () => mode,
    setMode: (nextMode) => {
      if (nextMode === mode) return;
      mode = nextMode;
      view.dispatch({
        effects: rendering.reconfigure(createEditorModeExtension(nextMode)),
      });
    },
    destroy: () => view.destroy(),
  };
}
