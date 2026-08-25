import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  ensureSyntaxTree,
  HighlightStyle,
  LanguageDescription,
  syntaxTree,
  syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { basicSetup, EditorView } from "codemirror";

import {
  createEditorModeExtension,
  type ComplexBlockRenderers,
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
  readonly complexRenderers?: ComplexBlockRenderers;
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
  readonly insertTask: () => void;
  readonly insertTable: () => void;
  readonly revealPosition: (position: number) => void;
  readonly setOutlineListener: (listener: OutlineListener | null) => void;
  readonly setPreferences: (preferences: EditorPreferences) => void;
  readonly getMode: () => EditorMode;
  readonly setMode: (mode: EditorMode) => void;
  readonly destroy: () => void;
}

export interface SourceEditorChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface EditorPreferences {
  readonly fontSize: number;
  readonly lineWrapping: boolean;
}

export interface OutlineItem {
  readonly level: number;
  readonly text: string;
  readonly from: number;
}

export type OutlineListener = (items: readonly OutlineItem[]) => void;

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

const starterTable = "| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |";
const starterTableFirstCell = starterTable.lastIndexOf("\n") + 3;
const coreMarkdownExtensions = {
  // markdownLanguage supplies GFM. Keep optional superscript, subscript and
  // emoji syntax outside the project's declared core dialect.
  remove: ["Superscript", "Subscript", "Emoji"],
} as const;

const headingLevels = new Map<string, number>([
  ["ATXHeading1", 1],
  ["ATXHeading2", 2],
  ["ATXHeading3", 3],
  ["ATXHeading4", 4],
  ["ATXHeading5", 5],
  ["ATXHeading6", 6],
  ["SetextHeading1", 1],
  ["SetextHeading2", 2],
]);

/** Derives disposable outline metadata from a Markdown syntax tree. */
export function collectDocumentOutline(
  state: EditorState,
  tree: ReturnType<typeof syntaxTree> = syntaxTree(state),
): readonly OutlineItem[] {
  const items: OutlineItem[] = [];
  tree.iterate({
    enter(node) {
      const item = outlineItemForNode(state, node.name, node.from, node.to);
      if (item !== null) items.push(item);
    },
  });
  return items;
}

function outlineItemForNode(
  state: EditorState,
  name: string,
  from: number,
  to: number,
): OutlineItem | null {
  const level = headingLevels.get(name);
  if (level === undefined) return null;

  const raw = state.sliceDoc(from, to);
  if (name.startsWith("ATXHeading")) {
    const prefix = /^ {0,3}#{1,6}(?:[\t ]+|$)/u.exec(raw)?.[0] ?? "";
    const text = raw
      .slice(prefix.length)
      .replace(/[\t ]+#+[\t ]*$/u, "")
      .trim();
    return {
      level,
      text: text || "无标题",
      from: from + prefix.length,
    };
  }

  const firstLine = raw.split(/\r?\n/u, 1)[0] ?? "";
  const leadingSpace = /^[\t ]*/u.exec(firstLine)?.[0].length ?? 0;
  return {
    level,
    text: firstLine.trim() || "无标题",
    from: from + leadingSpace,
  };
}

async function collectDocumentOutlineIncrementally(
  state: EditorState,
  tree: ReturnType<typeof syntaxTree>,
  isCurrent: () => boolean,
): Promise<readonly OutlineItem[] | null> {
  const items: OutlineItem[] = [];
  const cursor = tree.cursor();
  let sliceStartedAt = performance.now();

  while (true) {
    const item = outlineItemForNode(state, cursor.name, cursor.from, cursor.to);
    if (item !== null) items.push(item);

    if (performance.now() - sliceStartedAt >= 12) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (!isCurrent()) return null;
      sliceStartedAt = performance.now();
    }

    if (cursor.firstChild()) continue;
    while (!cursor.nextSibling()) {
      if (!cursor.parent()) return items;
    }
  }
}

class OutlineTracker {
  private listener: OutlineListener | null = null;
  private timer: number | null = null;
  private generation = 0;

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate) {
    if (update.docChanged && this.listener !== null) this.schedule(180);
  }

  setListener(listener: OutlineListener | null) {
    this.listener = listener;
    this.generation++;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (listener !== null) this.schedule(0);
  }

  destroy() {
    this.setListener(null);
  }

  private schedule(delay: number) {
    const generation = ++this.generation;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.refresh(generation);
    }, delay);
  }

  private async refresh(generation: number) {
    const state = this.view.state;
    let tree = ensureSyntaxTree(state, state.doc.length, 20);
    while (
      tree === null &&
      this.listener !== null &&
      generation === this.generation
    ) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (this.view.state.doc !== state.doc) {
        this.schedule(180);
        return;
      }
      if (this.listener === null || generation !== this.generation) return;
      tree = ensureSyntaxTree(state, state.doc.length, 20);
    }

    if (tree === null) return;
    const isCurrent = () =>
      this.listener !== null &&
      generation === this.generation &&
      this.view.state.doc === state.doc;
    if (!isCurrent()) return;
    const items = await collectDocumentOutlineIncrementally(
      state,
      tree,
      isCurrent,
    );
    if (items !== null && isCurrent()) this.listener?.(items);
  }
}

const outlineTrackerPlugin = ViewPlugin.fromClass(OutlineTracker);

interface TableCellTarget {
  readonly anchor: number;
  readonly append?: {
    readonly from: number;
    readonly insert: string;
  };
}

interface TableCellRange {
  readonly from: number;
  readonly to: number;
  readonly anchor: number;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashes++;
  }
  return slashes % 2 === 1;
}

function tableCellsOnLine(
  text: string,
  lineFrom: number,
): readonly TableCellRange[] {
  const delimiters: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "|" && !isEscaped(text, index)) delimiters.push(index);
  }
  if (delimiters.length === 0) return [];

  const boundaries = [
    ...(delimiters[0] === 0 ? [] : [-1]),
    ...delimiters,
    ...(delimiters.at(-1) === text.length - 1 ? [] : [text.length]),
  ];

  const cells: TableCellRange[] = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const rawFrom = (boundaries[index] ?? -1) + 1;
    const rawTo = boundaries[index + 1] ?? text.length;
    let contentFrom = rawFrom;
    let contentTo = rawTo;
    while (contentFrom < contentTo && /[\t ]/u.test(text[contentFrom] ?? "")) {
      contentFrom++;
    }
    while (
      contentTo > contentFrom &&
      /[\t ]/u.test(text[contentTo - 1] ?? "")
    ) {
      contentTo--;
    }
    cells.push({
      from: lineFrom + rawFrom,
      to: lineFrom + rawTo,
      anchor:
        lineFrom +
        (contentFrom === contentTo
          ? rawFrom + Math.min(1, rawTo - rawFrom)
          : contentFrom),
    });
  }
  return cells;
}

function isTableDelimiterLine(text: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/u.test(text);
}

/** Returns the next editable GFM table cell, including empty cells. */
export function getTableCellTarget(
  state: EditorState,
  position: number,
  direction: 1 | -1,
): TableCellTarget | null {
  // The language package keeps the visible region parsed. Avoid forcing a
  // full-document parse here—Tab must remain cheap in multi-megabyte files.
  let table = syntaxTree(state).resolveInner(position, -1);
  while (table.name !== "Table") {
    const parent = table.parent;
    if (parent === null) return null;
    table = parent;
  }

  const cells: TableCellRange[] = [];
  let line = state.doc.lineAt(table.from);
  const finalLine = state.doc.lineAt(Math.max(table.from, table.to - 1)).number;
  while (line.number <= finalLine) {
    if (!isTableDelimiterLine(line.text)) {
      cells.push(...tableCellsOnLine(line.text, line.from));
    }
    if (line.number === state.doc.lines) break;
    line = state.doc.line(line.number + 1);
  }

  const currentIndex = cells.findIndex(
    ({ from, to }) => position >= from && position <= to,
  );
  if (currentIndex < 0) return null;
  const target = cells[currentIndex + direction];
  if (target !== undefined) return { anchor: target.anchor };
  if (direction < 0) return null;

  const columnCount = tableCellsOnLine(
    state.doc.lineAt(table.from).text,
    state.doc.lineAt(table.from).from,
  ).length;
  if (columnCount === 0) return null;
  const insert = `\n| ${Array.from({ length: columnCount }, () => "").join(" | ")} |`;
  return {
    anchor: table.to + 3,
    append: { from: table.to, insert },
  };
}

function moveTableCell(direction: 1 | -1) {
  return (view: EditorView): boolean => {
    const selection = view.state.selection.main;
    if (!selection.empty) return false;
    const target = getTableCellTarget(view.state, selection.head, direction);
    if (target === null) return false;
    view.dispatch({
      ...(target.append === undefined ? {} : { changes: target.append }),
      selection: { anchor: target.anchor },
      scrollIntoView: true,
      userEvent: "select.table-cell",
    });
    return true;
  };
}

function insertBlock(view: EditorView, block: string, selectionOffset: number) {
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(selection.from);
  const prefix = selection.from === line.from ? "" : "\n\n";
  const suffix = selection.to === view.state.doc.length ? "" : "\n\n";
  view.dispatch({
    changes: {
      from: selection.from,
      to: selection.to,
      insert: prefix + block + suffix,
    },
    selection: { anchor: selection.from + prefix.length + selectionOffset },
    scrollIntoView: true,
    userEvent: "input.insert-block",
  });
  view.focus();
}

function createEditorTheme(fontSize: number) {
  return EditorView.theme({
    "&": {
      height: "100%",
      color: "var(--editor-fg, #292722)",
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
      caretColor: "var(--accent-strong, #9b5c39)",
    },
    ".cm-gutters": {
      color: "var(--text-faint, #aaa398)",
      backgroundColor: "transparent",
      border: "none",
    },
    ".cm-activeLine, .cm-activeLineGutter": {
      backgroundColor: "var(--active-line, #8d65480a)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "var(--selection, #d9bca780) !important",
    },
    ".cm-code-keyword": {
      color: "var(--syntax-keyword, #8d3f55)",
      fontWeight: "650",
    },
    ".cm-code-string": { color: "var(--syntax-string, #537342)" },
    ".cm-code-literal": { color: "var(--syntax-literal, #87551f)" },
    ".cm-code-comment": {
      color: "var(--syntax-comment, #8b857c)",
      fontStyle: "italic",
    },
    ".cm-code-definition, .cm-code-function": {
      color: "var(--syntax-definition, #3e6680)",
    },
    "&.cm-focused": {
      outline: "none",
    },
  });
}

export function createEditorPreferencesExtension(
  preferences: EditorPreferences,
): Extension {
  return [
    createEditorTheme(preferences.fontSize),
    ...(preferences.lineWrapping ? [EditorView.lineWrapping] : []),
  ];
}

function createState(
  options: SourceEditorStateOptions,
  renderingExtension: Extension,
  preferencesExtension: Extension = createEditorPreferencesExtension({
    fontSize: options.fontSize ?? 16,
    lineWrapping: options.lineWrapping ?? false,
  }),
): EditorState {
  const readOnly = options.readOnly ?? false;

  return EditorState.create({
    doc: options.text,
    extensions: [
      basicSetup,
      markdown({
        base: markdownLanguage,
        codeLanguages,
        extensions: coreMarkdownExtensions,
      }),
      syntaxHighlighting(codeHighlightStyle),
      preferencesExtension,
      EditorState.lineSeparator.of(options.lineSeparator ?? "\n"),
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      renderingExtension,
      outlineTrackerPlugin,
      keymap.of([
        { key: "Tab", run: moveTableCell(1) },
        { key: "Shift-Tab", run: moveTableCell(-1) },
      ]),
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
  const preferences = new Compartment();
  let mode = options.mode ?? "source";
  const view = new EditorView({
    parent: options.parent,
    state: createState(
      options,
      rendering.of(createEditorModeExtension(mode, options.complexRenderers)),
      preferences.of(
        createEditorPreferencesExtension({
          fontSize: options.fontSize ?? 16,
          lineWrapping: options.lineWrapping ?? false,
        }),
      ),
    ),
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
    insertTask: () => {
      if (!view.state.readOnly) insertBlock(view, "- [ ] ", 6);
    },
    insertTable: () =>
      !view.state.readOnly &&
      insertBlock(view, starterTable, starterTableFirstCell),
    revealPosition: (position) => {
      const anchor = Math.max(0, Math.min(position, view.state.doc.length));
      view.dispatch({
        selection: { anchor },
        scrollIntoView: true,
        userEvent: "select.outline",
      });
      view.focus();
    },
    setOutlineListener: (listener) => {
      view.plugin(outlineTrackerPlugin)?.setListener(listener);
    },
    setPreferences: (nextPreferences) => {
      view.dispatch({
        effects: preferences.reconfigure(
          createEditorPreferencesExtension(nextPreferences),
        ),
      });
    },
    getMode: () => mode,
    setMode: (nextMode) => {
      if (nextMode === mode) return;
      mode = nextMode;
      view.dispatch({
        effects: rendering.reconfigure(
          createEditorModeExtension(nextMode, options.complexRenderers),
        ),
      });
    },
    destroy: () => view.destroy(),
  };
}
