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
import {
  findNext,
  findPrevious,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  search as searchExtension,
  setSearchQuery,
} from "@codemirror/search";
import {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { tags } from "@lezer/highlight";
import {
  Decoration,
  keymap,
  ViewPlugin,
  type DecorationSet,
  type EditorView as EditorViewType,
  type ViewUpdate,
} from "@codemirror/view";
import { basicSetup, EditorView } from "codemirror";
import {
  createMarkdownHeadingSlug,
  type MarkdownProfile,
} from "@mdeditor/markdown";

import {
  createEditorModeExtension,
  type ComplexBlockRenderers,
  type EditorMode,
  type ImageSourceResolver,
} from "./progressive-rendering.js";
import { runMarkdownFormat, type MarkdownFormatCommand } from "./formatting.js";
import {
  calculateEditorStatistics,
  type DocumentStatistics,
} from "./statistics.js";
import { runTableEdit, type TableEditCommand } from "./table.js";
import {
  createSpellcheckExtension,
  spellcheckDisabledExtension,
  type SpellcheckLanguage,
} from "./spellcheck.js";

export type EditorLineSeparator = "\n" | "\r\n";

export interface SourceEditorOptions {
  readonly parent: HTMLElement;
  readonly text: string;
  readonly lineSeparator?: EditorLineSeparator;
  readonly readOnly?: boolean;
  readonly fontSize?: number;
  readonly lineWrapping?: boolean;
  readonly focusMode?: boolean;
  readonly typewriterMode?: boolean;
  readonly markdownAutoPair?: boolean;
  readonly spellcheckEnabled?: boolean;
  readonly spellcheckLanguage?: SpellcheckLanguage;
  readonly mode?: EditorMode;
  readonly complexRenderers?: ComplexBlockRenderers;
  readonly markdownProfile?: MarkdownProfile;
  readonly onTextChange?: (text: string) => void;
  readonly onLinkActivate?: (target: string) => void;
  readonly resolveImageSource?: ImageSourceResolver;
  readonly onImageFiles?: (files: readonly File[]) => void;
  readonly onSearchRequest?: () => void;
}

export interface SourceEditorStateOptions {
  readonly text: string;
  readonly lineSeparator?: EditorLineSeparator;
  readonly readOnly?: boolean;
  readonly fontSize?: number;
  readonly lineWrapping?: boolean;
  readonly focusMode?: boolean;
  readonly typewriterMode?: boolean;
  readonly markdownAutoPair?: boolean;
  readonly spellcheckEnabled?: boolean;
  readonly spellcheckLanguage?: SpellcheckLanguage;
  readonly mode?: EditorMode;
  readonly markdownProfile?: MarkdownProfile;
  readonly onTextChange?: (text: string) => void;
  readonly onLinkActivate?: (target: string) => void;
  readonly resolveImageSource?: ImageSourceResolver;
  readonly onImageFiles?: (files: readonly File[]) => void;
  readonly onSearchRequest?: () => void;
}

export interface SourceEditorSearchOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regularExpression: boolean;
}

export type SourceEditorSearchAction =
  "update" | "next" | "previous" | "replace" | "replaceAll";

export interface SourceEditor {
  readonly getText: () => string;
  readonly focus: () => void;
  readonly replaceText: (text: string) => void;
  readonly applyTextChange: (change: SourceEditorChange) => void;
  readonly format: (command: MarkdownFormatCommand) => void;
  readonly insertTask: () => void;
  readonly insertTable: () => void;
  readonly editTable: (command: TableEditCommand) => boolean;
  readonly openSearch: () => boolean;
  readonly runSearch: (
    query: string,
    replacement: string,
    options: SourceEditorSearchOptions,
    action: SourceEditorSearchAction,
  ) => boolean;
  readonly revealPosition: (position: number) => void;
  readonly revealHeading: (fragment: string) => boolean;
  readonly insertImageReference: (
    markdownPath: string,
    suggestedAlt: string,
  ) => boolean;
  readonly setOutlineListener: (listener: OutlineListener | null) => void;
  readonly setStatisticsListener: (listener: StatisticsListener | null) => void;
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
  readonly focusMode?: boolean;
  readonly typewriterMode?: boolean;
  readonly markdownAutoPair?: boolean;
  readonly spellcheckEnabled?: boolean;
  readonly spellcheckLanguage?: SpellcheckLanguage;
}

export interface OutlineItem {
  readonly level: number;
  readonly text: string;
  readonly from: number;
}

export type OutlineListener = (items: readonly OutlineItem[]) => void;
export type StatisticsListener = (statistics: DocumentStatistics) => void;

export function linkTargetAtPosition(
  state: EditorState,
  position: number,
): string | null {
  let node = syntaxTree(state).resolveInner(
    Math.max(0, Math.min(position, state.doc.length)),
    -1,
  );
  while (
    node.parent !== null &&
    node.name !== "Link" &&
    node.name !== "Autolink"
  ) {
    node = node.parent;
  }
  if (node.name !== "Link" && node.name !== "Autolink") return null;
  let target: string;
  if (node.name === "Autolink") {
    target = state.sliceDoc(node.from, node.to).replace(/^<|>$/gu, "");
    if (!target.includes(":") && target.includes("@"))
      target = `mailto:${target}`;
  } else {
    const url = node.getChild("URL");
    if (url === null) return null;
    target = state.sliceDoc(url.from, url.to).replace(/^<|>$/gu, "");
  }
  const normalized = target.trim();
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  return normalized !== "" && !hasControlCharacter ? normalized : null;
}

function activateLinkAtPosition(
  state: EditorState,
  position: number,
  onLinkActivate: ((target: string) => void) | undefined,
): boolean {
  if (onLinkActivate === undefined) return false;
  const target = linkTargetAtPosition(state, position);
  if (target === null) return false;
  onLinkActivate(target);
  return true;
}

const supportedImageMimeTypes = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function supportedImageFiles(files: FileList | null): readonly File[] {
  return files === null
    ? []
    : Array.from(files).filter((file) =>
        supportedImageMimeTypes.has(file.type.toLocaleLowerCase()),
      );
}

function hasSupportedImageTransfer(data: DataTransfer | null): boolean {
  return (
    data !== null &&
    (supportedImageFiles(data.files).length > 0 ||
      Array.from(data.items).some(
        (item) =>
          item.kind === "file" &&
          supportedImageMimeTypes.has(item.type.toLocaleLowerCase()),
      ))
  );
}

export function headingPositionForFragment(
  state: EditorState,
  fragment: string,
): number | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(fragment.replace(/^#/, ""));
  } catch {
    return null;
  }
  const normalized = decoded.normalize("NFKC").toLocaleLowerCase();
  const withoutExportPrefix = normalized.replace(/^md-heading-/, "");
  const duplicates = new Map<string, number>();
  for (const item of collectDocumentOutline(state)) {
    const base = createMarkdownHeadingSlug(item.text);
    const duplicate = duplicates.get(base) ?? 0;
    duplicates.set(base, duplicate + 1);
    const slug = `${base}${duplicate === 0 ? "" : `-${duplicate + 1}`}`;
    if (
      withoutExportPrefix === slug ||
      normalized === item.text.normalize("NFKC").toLocaleLowerCase()
    ) {
      return item.from;
    }
  }
  return null;
}

export function createMarkdownImageInsertionTransaction(
  state: EditorState,
  markdownPath: string,
  suggestedAlt: string,
): Transaction | null {
  if (
    state.readOnly ||
    markdownPath === "" ||
    Array.from(markdownPath).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x20 || codePoint === 0x7f;
    })
  ) {
    return null;
  }
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to).trim();
  const alt = (selected || suggestedAlt || "图片")
    .replace(/\\/gu, "\\\\")
    .replace(/\]/gu, "\\]");
  const markdown = `![${alt}](${markdownPath})`;
  return state.update({
    changes: { from: range.from, to: range.to, insert: markdown },
    selection: { anchor: range.from + markdown.length },
    userEvent: "input.image-import",
  });
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

const coreMarkdownExtensions = {
  // markdownLanguage supplies GFM. Keep optional superscript, subscript and
  // emoji syntax outside the project's declared core dialect.
  remove: ["Superscript", "Subscript", "Emoji"],
} as const;

const searchPhrases = {
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全部",
  "match case": "区分大小写",
  regexp: "正则表达式",
  "by word": "全字匹配",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭查找",
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

class StatisticsTracker {
  private listener: StatisticsListener | null = null;
  private timer: number | null = null;
  private generation = 0;

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate) {
    if (this.listener !== null && (update.docChanged || update.selectionSet)) {
      this.schedule(update.docChanged ? 180 : 60);
    }
  }

  setListener(listener: StatisticsListener | null) {
    this.listener = listener;
    this.generation += 1;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (listener !== null) this.schedule(0);
  }

  destroy() {
    this.generation += 1;
    if (this.timer !== null) window.clearTimeout(this.timer);
  }

  private schedule(delay: number) {
    this.generation += 1;
    const generation = this.generation;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.refresh(generation);
    }, delay);
  }

  private async refresh(generation: number) {
    const state = this.view.state;
    const isCurrent = () =>
      generation === this.generation &&
      this.listener !== null &&
      state === this.view.state;
    const statistics = await calculateEditorStatistics(state, isCurrent);
    if (statistics !== null && isCurrent()) this.listener?.(statistics);
  }
}

const statisticsTrackerPlugin = ViewPlugin.fromClass(StatisticsTracker);

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

export interface FocusBlockRange {
  readonly from: number;
  readonly to: number;
}

const focusBlockNames = new Set([
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
  "Paragraph",
  "Blockquote",
  "FencedCode",
  "CodeBlock",
  "Table",
  "ListItem",
]);

/** Derives the source block that remains emphasized in focus mode. */
export function getFocusBlockRange(
  state: EditorState,
  position: number,
): FocusBlockRange {
  const safePosition = Math.max(0, Math.min(position, state.doc.length));
  let node = syntaxTree(state).resolveInner(safePosition, -1);
  while (node.parent !== null) {
    if (focusBlockNames.has(node.name)) {
      return { from: node.from, to: node.to };
    }
    node = node.parent;
  }

  const line = state.doc.lineAt(safePosition);
  return { from: line.from, to: line.to };
}

const focusDimDecoration = Decoration.line({ class: "cm-focus-dimmed" });

function buildFocusDecorations(view: EditorViewType): DecorationSet {
  const activeBlocks = view.state.selection.ranges.map((range) => {
    const start = getFocusBlockRange(view.state, range.from);
    const end = getFocusBlockRange(
      view.state,
      range.empty ? range.to : Math.max(range.from, range.to - 1),
    );
    return {
      from: Math.min(start.from, end.from),
      to: Math.max(start.to, end.to),
    };
  });
  const decorations = [];
  let lastLineFrom = -1;

  for (const visible of view.visibleRanges) {
    let line = view.state.doc.lineAt(visible.from);
    const finalLine = view.state.doc.lineAt(visible.to).number;
    while (line.number <= finalLine) {
      const active = activeBlocks.some(
        (block) => line.to >= block.from && line.from <= block.to,
      );
      if (!active && line.from !== lastLineFrom) {
        decorations.push(focusDimDecoration.range(line.from));
      }
      lastLineFrom = line.from;
      if (line.number === view.state.doc.lines) break;
      line = view.state.doc.line(line.number + 1);
    }
  }

  return Decoration.set(decorations, true);
}

class FocusModeRenderer {
  decorations: DecorationSet;

  constructor(view: EditorViewType) {
    this.decorations = buildFocusDecorations(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = buildFocusDecorations(update.view);
    }
  }
}

const focusModeExtension = [
  ViewPlugin.fromClass(FocusModeRenderer, {
    decorations: (renderer) => renderer.decorations,
  }),
  EditorView.baseTheme({
    "&.cm-focused .cm-line.cm-focus-dimmed": {
      opacity: "0.82",
      transition: "opacity 120ms ease",
    },
    "@media (prefers-reduced-motion: reduce)": {
      ".cm-line.cm-focus-dimmed": { transition: "none" },
    },
    "@media (prefers-contrast: more), (forced-colors: active)": {
      "&.cm-focused .cm-line.cm-focus-dimmed": { opacity: "1" },
    },
  }),
];

class TypewriterScroller {
  private frame: number | null = null;

  constructor(private readonly view: EditorViewType) {
    this.schedule();
  }

  update(update: ViewUpdate) {
    if ((update.docChanged || update.selectionSet) && !update.view.composing) {
      this.schedule();
    }
  }

  destroy() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
  }

  private schedule() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.view.requestMeasure({
        key: this,
        read: (view) => {
          const cursor = view.coordsAtPos(view.state.selection.main.head);
          if (cursor === null) {
            const block = view.lineBlockAt(view.state.selection.main.head);
            return {
              absolute:
                block.top + block.height / 2 - view.scrollDOM.clientHeight / 2,
              offset: 0,
            };
          }
          const scroller = view.scrollDOM.getBoundingClientRect();
          return {
            absolute: null,
            offset:
              (cursor.top + cursor.bottom) / 2 -
              (scroller.top + scroller.bottom) / 2,
          };
        },
        write: (measurement, view) => {
          if (measurement.absolute !== null) {
            view.scrollDOM.scrollTop = measurement.absolute;
          } else if (Math.abs(measurement.offset) > 1) {
            view.scrollDOM.scrollTop += measurement.offset;
          }
        },
      });
    });
  }
}

const typewriterModeExtension = ViewPlugin.fromClass(TypewriterScroller);

const markdownPairMarkers = new Set(["*", "_", "~", "`"]);

function isMarkdownCodePosition(state: EditorState, position: number): boolean {
  let node = syntaxTree(state).resolveInner(position, -1);
  while (true) {
    if (/Code|Fenced/u.test(node.name)) return true;
    if (node.parent === null) return false;
    node = node.parent;
  }
}

function isPairBoundary(character: string): boolean {
  return character === "" || /[\s([{>"']/u.test(character);
}

/** Builds one undoable transaction for Markdown marker pairing or wrapping. */
export function createMarkdownAutoPairTransaction(
  state: EditorState,
  marker: string,
): Transaction | null {
  if (!markdownPairMarkers.has(marker) || state.readOnly) return null;

  const spec = state.changeByRange((range) => {
    if (isMarkdownCodePosition(state, range.head)) {
      return {
        changes: { from: range.from, to: range.to, insert: marker },
        range: EditorSelection.cursor(range.from + marker.length),
      };
    }

    if (!range.empty) {
      const pair = marker === "~" ? "~~" : marker;
      const selected = state.sliceDoc(range.from, range.to);
      const forward = range.anchor <= range.head;
      return {
        changes: {
          from: range.from,
          to: range.to,
          insert: `${pair}${selected}${pair}`,
        },
        range: forward
          ? EditorSelection.range(
              range.from + pair.length,
              range.to + pair.length,
            )
          : EditorSelection.range(
              range.to + pair.length,
              range.from + pair.length,
            ),
      };
    }

    const position = range.head;
    const previous = state.sliceDoc(Math.max(0, position - 1), position);
    const next = state.sliceDoc(position, position + 1);
    const beforePrevious = state.sliceDoc(
      Math.max(0, position - 2),
      Math.max(0, position - 1),
    );
    const afterNext = state.sliceDoc(position + 1, position + 2);
    if (
      previous === marker &&
      next === marker &&
      isPairBoundary(beforePrevious) &&
      (afterNext === "" || /[\s.,!?;:)}\]]/u.test(afterNext))
    ) {
      return {
        changes: {
          from: position - 1,
          to: position + 1,
          insert: marker.repeat(4),
        },
        range: EditorSelection.cursor(position + 1),
      };
    }
    if (next === marker) {
      return {
        range: EditorSelection.cursor(position + 1),
      };
    }

    return {
      changes: { from: position, insert: marker.repeat(2) },
      range: EditorSelection.cursor(position + 1),
    };
  });

  return state.update(spec, {
    annotations: Transaction.userEvent.of("input.markdown-pair"),
  });
}

function deleteMarkdownPair(view: EditorViewType): boolean {
  const tokens = ["**", "__", "~~", "`", "*", "_"] as const;
  let handled = true;
  const spec = view.state.changeByRange((range) => {
    if (!range.empty) {
      handled = false;
      return { range };
    }
    const token = tokens.find(
      (candidate) =>
        range.head >= candidate.length &&
        view.state.sliceDoc(range.head - candidate.length, range.head) ===
          candidate &&
        view.state.sliceDoc(range.head, range.head + candidate.length) ===
          candidate,
    );
    if (token === undefined) {
      handled = false;
      return { range };
    }
    return {
      changes: {
        from: range.head - token.length,
        to: range.head + token.length,
      },
      range: EditorSelection.cursor(range.head - token.length),
    };
  });
  if (!handled) return false;
  view.dispatch(
    view.state.update(spec, {
      annotations: Transaction.userEvent.of("delete.markdown-pair"),
    }),
  );
  return true;
}

const markdownAutoPairExtension = [
  Prec.high(
    EditorView.inputHandler.of((view, _from, _to, text) => {
      if (view.composing || text.length !== 1) return false;
      const transaction = createMarkdownAutoPairTransaction(view.state, text);
      if (transaction === null) return false;
      view.dispatch(transaction);
      return true;
    }),
  ),
  Prec.high(keymap.of([{ key: "Backspace", run: deleteMarkdownPair }])),
];

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
      fontFamily:
        '"Cascadia Code", Consolas, "Microsoft YaHei UI", "Noto Sans SC", monospace',
      lineHeight: "1.75",
    },
    ".cm-content": {
      flex: "0 1 820px",
      width: "min(820px, 100%)",
      minWidth: "0",
      minHeight: "100%",
      margin: "0 auto",
      padding: "48px clamp(20px, 5vw, 48px) 140px",
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
    ...(preferences.focusMode ? focusModeExtension : []),
    ...(preferences.typewriterMode ? [typewriterModeExtension] : []),
    ...(preferences.markdownAutoPair === false
      ? []
      : markdownAutoPairExtension),
    preferences.spellcheckEnabled
      ? createSpellcheckExtension(preferences.spellcheckLanguage ?? "en-US")
      : spellcheckDisabledExtension,
  ];
}

function createState(
  options: SourceEditorStateOptions,
  renderingExtension: Extension,
  preferencesExtension: Extension = createEditorPreferencesExtension({
    fontSize: options.fontSize ?? 16,
    lineWrapping: options.lineWrapping ?? false,
    focusMode: options.focusMode ?? false,
    typewriterMode: options.typewriterMode ?? false,
    markdownAutoPair: options.markdownAutoPair ?? true,
    spellcheckEnabled: options.spellcheckEnabled ?? false,
    spellcheckLanguage: options.spellcheckLanguage ?? "en-US",
  }),
): EditorState {
  const readOnly = options.readOnly ?? false;

  return EditorState.create({
    doc: options.text,
    extensions: [
      basicSetup,
      searchExtension(),
      markdown({
        base: markdownLanguage,
        codeLanguages,
        extensions: coreMarkdownExtensions,
      }),
      syntaxHighlighting(codeHighlightStyle),
      preferencesExtension,
      EditorState.lineSeparator.of(options.lineSeparator ?? "\n"),
      EditorState.readOnly.of(readOnly),
      EditorState.phrases.of(searchPhrases),
      EditorView.editable.of(!readOnly),
      renderingExtension,
      outlineTrackerPlugin,
      statisticsTrackerPlugin,
      keymap.of([
        { key: "Mod-b", run: runMarkdownFormat("bold") },
        { key: "Mod-i", run: runMarkdownFormat("italic") },
        { key: "Mod-k", run: runMarkdownFormat("link") },
        {
          key: "Mod-Enter",
          run: (view) =>
            activateLinkAtPosition(
              view.state,
              view.state.selection.main.head,
              options.onLinkActivate,
            ),
        },
        { key: "Tab", run: moveTableCell(1) },
        { key: "Shift-Tab", run: moveTableCell(-1) },
      ]),
      ...(options.onSearchRequest === undefined
        ? []
        : [
            Prec.high(
              keymap.of([
                {
                  key: "Mod-f",
                  run: () => {
                    options.onSearchRequest?.();
                    return true;
                  },
                },
              ]),
            ),
          ]),
      EditorView.contentAttributes.of({
        "aria-label": "Markdown 源码编辑器",
        ...(readOnly ? { tabindex: "0" } : {}),
      }),
      EditorView.domEventHandlers({
        click: (event, view) => {
          if ((!event.ctrlKey && !event.metaKey) || event.button !== 0) {
            return false;
          }
          const position = view.posAtCoords({
            x: event.clientX,
            y: event.clientY,
          });
          if (position === null) return false;
          const activated = activateLinkAtPosition(
            view.state,
            position,
            options.onLinkActivate,
          );
          if (activated) event.preventDefault();
          return activated;
        },
        paste: (event, view) => {
          if (view.state.readOnly || options.onImageFiles === undefined) {
            return false;
          }
          const files = supportedImageFiles(event.clipboardData?.files ?? null);
          if (files.length === 0) return false;
          event.preventDefault();
          options.onImageFiles(files);
          return true;
        },
        dragover: (event, view) => {
          if (view.state.readOnly || options.onImageFiles === undefined) {
            return false;
          }
          if (!hasSupportedImageTransfer(event.dataTransfer)) return false;
          event.preventDefault();
          return true;
        },
        drop: (event, view) => {
          if (view.state.readOnly || options.onImageFiles === undefined) {
            return false;
          }
          const files = supportedImageFiles(event.dataTransfer?.files ?? null);
          if (files.length === 0) return false;
          const position = view.posAtCoords({
            x: event.clientX,
            y: event.clientY,
          });
          if (position !== null) {
            view.dispatch({ selection: { anchor: position } });
          }
          event.preventDefault();
          options.onImageFiles(files);
          return true;
        },
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
    createEditorModeExtension(
      options.mode ?? "source",
      {},
      options.markdownProfile,
      options.resolveImageSource,
    ),
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
      rendering.of(
        createEditorModeExtension(
          mode,
          options.complexRenderers,
          options.markdownProfile,
          options.resolveImageSource,
        ),
      ),
      preferences.of(
        createEditorPreferencesExtension({
          fontSize: options.fontSize ?? 16,
          lineWrapping: options.lineWrapping ?? false,
          focusMode: options.focusMode ?? false,
          typewriterMode: options.typewriterMode ?? false,
          markdownAutoPair: options.markdownAutoPair ?? true,
          spellcheckEnabled: options.spellcheckEnabled ?? false,
          spellcheckLanguage: options.spellcheckLanguage ?? "en-US",
        }),
      ),
    ),
  });
  view.scrollDOM.tabIndex = 0;
  view.scrollDOM.setAttribute("role", "region");
  view.scrollDOM.setAttribute("aria-label", "文档滚动区域");

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
    format: (command) => {
      runMarkdownFormat(command)(view);
    },
    insertTask: () => {
      runMarkdownFormat("taskList")(view);
    },
    insertTable: () => {
      runMarkdownFormat("table")(view);
    },
    editTable: (command) => runTableEdit(command)(view),
    openSearch: () => openSearchPanel(view),
    runSearch: (query, replacement, options, action) => {
      const searchQuery = new SearchQuery({
        search: query,
        replace: replacement,
        caseSensitive: options.caseSensitive,
        wholeWord: options.wholeWord,
        regexp: options.regularExpression,
      });
      view.dispatch({ effects: setSearchQuery.of(searchQuery) });
      if (action === "update") return searchQuery.valid;
      if (!searchQuery.valid) return false;
      if (
        (action === "replace" || action === "replaceAll") &&
        view.state.readOnly
      )
        return false;
      if (action === "next") return findNext(view);
      if (action === "previous") return findPrevious(view);
      if (action === "replace") return replaceNext(view);
      return replaceAll(view);
    },
    revealPosition: (position) => {
      const anchor = Math.max(0, Math.min(position, view.state.doc.length));
      view.dispatch({
        selection: { anchor },
        scrollIntoView: true,
        userEvent: "select.outline",
      });
      view.focus();
    },
    revealHeading: (fragment) => {
      const position = headingPositionForFragment(view.state, fragment);
      if (position === null) return false;
      view.dispatch({
        selection: { anchor: position },
        scrollIntoView: true,
        userEvent: "select.link-heading",
      });
      view.focus();
      return true;
    },
    insertImageReference: (markdownPath, suggestedAlt) => {
      const transaction = createMarkdownImageInsertionTransaction(
        view.state,
        markdownPath,
        suggestedAlt,
      );
      if (transaction === null) return false;
      view.dispatch(transaction);
      view.focus();
      return true;
    },
    setOutlineListener: (listener) => {
      view.plugin(outlineTrackerPlugin)?.setListener(listener);
    },
    setStatisticsListener: (listener) => {
      view.plugin(statisticsTrackerPlugin)?.setListener(listener);
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
          createEditorModeExtension(
            nextMode,
            options.complexRenderers,
            options.markdownProfile,
            options.resolveImageSource,
          ),
        ),
      });
    },
    destroy: () => view.destroy(),
  };
}
