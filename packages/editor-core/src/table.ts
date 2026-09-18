import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  type EditorState,
  type TransactionSpec,
} from "@codemirror/state";

export type TableAlignment = "default" | "left" | "center" | "right";

export type TableEditCommand =
  | "addRowBefore"
  | "addRowAfter"
  | "deleteRow"
  | "moveRowUp"
  | "moveRowDown"
  | "addColumnBefore"
  | "addColumnAfter"
  | "deleteColumn"
  | "moveColumnLeft"
  | "moveColumnRight"
  | "alignDefault"
  | "alignLeft"
  | "alignCenter"
  | "alignRight";

export interface GfmTableModel {
  readonly header: readonly string[];
  readonly alignments: readonly TableAlignment[];
  readonly rows: readonly (readonly string[])[];
}

interface ParsedCell {
  readonly text: string;
  readonly from: number;
  readonly to: number;
}

interface TableContext {
  readonly from: number;
  readonly to: number;
  readonly model: GfmTableModel;
  readonly row: number;
  readonly column: number;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function delimiterPositions(text: string): number[] {
  const positions: number[] = [];
  let codeMarkerLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "`" && !isEscaped(text, index)) {
      let length = 1;
      while (text[index + length] === "`") length += 1;
      codeMarkerLength = codeMarkerLength === length ? 0 : length;
      index += length - 1;
      continue;
    }
    if (
      text[index] === "|" &&
      codeMarkerLength === 0 &&
      !isEscaped(text, index)
    ) {
      positions.push(index);
    }
  }
  return positions;
}

function parseRow(text: string): ParsedCell[] {
  const delimiters = delimiterPositions(text);
  if (delimiters.length === 0) return [];
  const firstNonSpace = text.search(/\S/u);
  const lastNonSpace = text.search(/\S(?=\s*$)/u);
  const hasLeadingPipe = firstNonSpace >= 0 && delimiters[0] === firstNonSpace;
  const hasTrailingPipe =
    lastNonSpace >= 0 && delimiters.at(-1) === lastNonSpace;
  const boundaries = [
    ...(hasLeadingPipe ? [] : [-1]),
    ...delimiters,
    ...(hasTrailingPipe ? [] : [text.length]),
  ];
  const cells: ParsedCell[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const rawFrom = (boundaries[index] ?? -1) + 1;
    const rawTo = boundaries[index + 1] ?? text.length;
    let from = rawFrom;
    let to = rawTo;
    while (from < to && /[ \t]/u.test(text[from] ?? "")) from += 1;
    while (to > from && /[ \t]/u.test(text[to - 1] ?? "")) to -= 1;
    cells.push({ text: text.slice(from, to), from, to });
  }
  return cells;
}

function alignmentFromDelimiter(value: string): TableAlignment | null {
  const normalized = value.trim();
  if (!/^:?-{3,}:?$/u.test(normalized)) return null;
  if (normalized.startsWith(":") && normalized.endsWith(":")) return "center";
  if (normalized.startsWith(":")) return "left";
  if (normalized.endsWith(":")) return "right";
  return "default";
}

function normalizeRow(
  cells: readonly ParsedCell[],
  columnCount: number,
): string[] {
  return Array.from(
    { length: columnCount },
    (_, index) => cells[index]?.text ?? "",
  );
}

export function parseGfmTable(source: string): GfmTableModel | null {
  const lines = source.split(/\r?\n/u);
  if (lines.length < 2) return null;
  const header = parseRow(lines[0] ?? "");
  const delimiter = parseRow(lines[1] ?? "");
  if (header.length === 0 || delimiter.length !== header.length) return null;
  const alignments = delimiter.map(({ text }) => alignmentFromDelimiter(text));
  if (alignments.some((alignment) => alignment === null)) return null;
  return {
    header: header.map(({ text }) => text),
    alignments: alignments as TableAlignment[],
    rows: lines
      .slice(2)
      .map((line) => normalizeRow(parseRow(line), header.length)),
  };
}

function delimiterForAlignment(alignment: TableAlignment): string {
  switch (alignment) {
    case "left":
      return ":---";
    case "center":
      return ":---:";
    case "right":
      return "---:";
    default:
      return "---";
  }
}

function serializeRow(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

export function serializeGfmTable(
  table: GfmTableModel,
  lineBreak = "\n",
): string {
  return [
    serializeRow(table.header),
    serializeRow(table.alignments.map(delimiterForAlignment)),
    ...table.rows.map(serializeRow),
  ].join(lineBreak);
}

function findTableContext(state: EditorState): TableContext | null {
  const position = state.selection.main.head;
  let node = syntaxTree(state).resolveInner(
    position,
    position === state.doc.length ? -1 : 1,
  );
  while (node.name !== "Table") {
    if (node.parent === null) return null;
    node = node.parent;
  }
  const source = state.sliceDoc(node.from, node.to);
  const model = parseGfmTable(source);
  if (model === null) return null;
  const tableStartLine = state.doc.lineAt(node.from).number;
  const currentLine = state.doc.lineAt(position);
  const relativeLine = currentLine.number - tableStartLine;
  const row =
    relativeLine === 0 ? -1 : relativeLine === 1 ? -2 : relativeLine - 2;
  const cells = parseRow(currentLine.text);
  const relativePosition = position - currentLine.from;
  const column = Math.max(
    0,
    cells.findIndex(
      ({ from, to }) => relativePosition >= from && relativePosition <= to,
    ),
  );
  return { from: node.from, to: node.to, model, row, column };
}

function mutableModel(model: GfmTableModel) {
  return {
    header: [...model.header],
    alignments: [...model.alignments],
    rows: model.rows.map((row) => [...row]),
  };
}

function moveItem<T>(items: T[], from: number, to: number): void {
  const [item] = items.splice(from, 1);
  if (item !== undefined) items.splice(to, 0, item);
}

function cellAnchor(serialized: string, row: number, column: number): number {
  const lines = serialized.split(/\r?\n/u);
  const lineIndex = row < 0 ? 0 : Math.min(row + 2, lines.length - 1);
  const before = lines
    .slice(0, lineIndex)
    .reduce((length, line) => length + line.length + 1, 0);
  const cells = parseRow(lines[lineIndex] ?? "");
  const cell = cells[Math.min(column, Math.max(0, cells.length - 1))];
  return before + (cell?.from ?? 0);
}

/** Creates one canonical, undoable table structure edit at the main selection. */
export function createTableEditTransaction(
  state: EditorState,
  command: TableEditCommand,
): TransactionSpec | null {
  if (state.readOnly || !state.selection.main.empty) return null;
  const context = findTableContext(state);
  if (context === null) return null;
  const table = mutableModel(context.model);
  let row = context.row;
  let column = Math.min(context.column, table.header.length - 1);
  const emptyRow = () => table.header.map(() => "");

  switch (command) {
    case "addRowBefore": {
      const insertion = row < 0 ? 0 : row;
      table.rows.splice(insertion, 0, emptyRow());
      row = insertion;
      break;
    }
    case "addRowAfter": {
      const insertion = row < 0 ? 0 : Math.min(row + 1, table.rows.length);
      table.rows.splice(insertion, 0, emptyRow());
      row = insertion;
      break;
    }
    case "deleteRow":
      if (row < 0 || row >= table.rows.length) return null;
      table.rows.splice(row, 1);
      row = table.rows.length === 0 ? -1 : Math.min(row, table.rows.length - 1);
      break;
    case "moveRowUp":
      if (row <= 0 || row >= table.rows.length) return null;
      moveItem(table.rows, row, row - 1);
      row -= 1;
      break;
    case "moveRowDown":
      if (row < 0 || row >= table.rows.length - 1) return null;
      moveItem(table.rows, row, row + 1);
      row += 1;
      break;
    case "addColumnBefore":
    case "addColumnAfter": {
      const insertion =
        command === "addColumnBefore"
          ? column
          : Math.min(column + 1, table.header.length);
      table.header.splice(insertion, 0, "");
      table.alignments.splice(insertion, 0, "default");
      for (const bodyRow of table.rows) bodyRow.splice(insertion, 0, "");
      column = insertion;
      break;
    }
    case "deleteColumn":
      if (table.header.length <= 1) return null;
      table.header.splice(column, 1);
      table.alignments.splice(column, 1);
      for (const bodyRow of table.rows) bodyRow.splice(column, 1);
      column = Math.min(column, table.header.length - 1);
      break;
    case "moveColumnLeft":
      if (column <= 0) return null;
      moveItem(table.header, column, column - 1);
      moveItem(table.alignments, column, column - 1);
      for (const bodyRow of table.rows) moveItem(bodyRow, column, column - 1);
      column -= 1;
      break;
    case "moveColumnRight":
      if (column >= table.header.length - 1) return null;
      moveItem(table.header, column, column + 1);
      moveItem(table.alignments, column, column + 1);
      for (const bodyRow of table.rows) moveItem(bodyRow, column, column + 1);
      column += 1;
      break;
    case "alignDefault":
    case "alignLeft":
    case "alignCenter":
    case "alignRight":
      table.alignments[column] = command
        .slice("align".length)
        .toLocaleLowerCase() as TableAlignment;
      break;
  }

  const serialized = serializeGfmTable(table, state.lineBreak);
  const anchor = context.from + cellAnchor(serialized, row, column);
  return {
    changes: { from: context.from, to: context.to, insert: serialized },
    selection: EditorSelection.cursor(anchor),
    scrollIntoView: true,
    userEvent: `input.table.${command}`,
  };
}

export function runTableEdit(command: TableEditCommand) {
  return (view: {
    readonly state: EditorState;
    dispatch(spec: TransactionSpec): void;
    focus(): void;
  }): boolean => {
    const transaction = createTableEditTransaction(view.state, command);
    if (transaction === null) return false;
    view.dispatch(transaction);
    view.focus();
    return true;
  };
}
