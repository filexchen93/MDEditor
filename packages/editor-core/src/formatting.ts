import {
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export type MarkdownFormatCommand =
  | "bold"
  | "italic"
  | "strikethrough"
  | "inlineCode"
  | "link"
  | "image"
  | "heading1"
  | "heading2"
  | "heading3"
  | "blockquote"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "codeBlock"
  | "mathBlock"
  | "horizontalRule"
  | "toc"
  | "pageBreak"
  | "table";

const starterTable = "| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |";
const starterTableFirstCell = starterTable.lastIndexOf("\n") + 3;

interface InlineFormat {
  readonly open: string;
  readonly close: string;
  readonly placeholder: string;
}

const inlineFormats: Readonly<
  Partial<Record<MarkdownFormatCommand, InlineFormat>>
> = {
  bold: { open: "**", close: "**", placeholder: "粗体文本" },
  italic: { open: "*", close: "*", placeholder: "斜体文本" },
  strikethrough: { open: "~~", close: "~~", placeholder: "删除文本" },
};

function preserveDirection(
  range: SelectionRange,
  from: number,
  to: number,
): SelectionRange {
  return range.anchor <= range.head
    ? EditorSelection.range(from, to)
    : EditorSelection.range(to, from);
}

function surroundRange(
  state: EditorState,
  range: SelectionRange,
  format: InlineFormat,
) {
  const { from, to } = range;
  const selected = state.doc.sliceString(from, to);
  const { open, close, placeholder } = format;

  if (
    selected.length >= open.length + close.length &&
    selected.startsWith(open) &&
    selected.endsWith(close)
  ) {
    const content = selected.slice(open.length, selected.length - close.length);
    return {
      changes: { from, to, insert: content },
      range: preserveDirection(range, from, from + content.length),
    };
  }

  if (
    from >= open.length &&
    state.doc.sliceString(from - open.length, from) === open &&
    state.doc.sliceString(to, to + close.length) === close
  ) {
    return {
      changes: [
        { from: from - open.length, to: from },
        { from: to, to: to + close.length },
      ],
      range: preserveDirection(range, from - open.length, to - open.length),
    };
  }

  const content = selected || placeholder;
  const insert = `${open}${content}${close}`;
  return {
    changes: { from, to, insert },
    range: preserveDirection(
      range,
      from + open.length,
      from + open.length + content.length,
    ),
  };
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/gu)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

function formatInlineCode(state: EditorState, range: SelectionRange) {
  const selected = state.doc.sliceString(range.from, range.to);
  const existing = /^(`+)( ?)([^\n]*?)( ?)\1$/u.exec(selected);
  if (existing !== null) {
    const content = existing[3] ?? "";
    return {
      changes: { from: range.from, to: range.to, insert: content },
      range: preserveDirection(range, range.from, range.from + content.length),
    };
  }

  const before = state.doc.sliceString(
    Math.max(0, range.from - 32),
    range.from,
  );
  const after = state.doc.sliceString(
    range.to,
    Math.min(state.doc.length, range.to + 32),
  );
  const opening = /(`+)( ?)$/u.exec(before)?.[0];
  const closing = /^( ?)(`+)/u.exec(after)?.[0];
  if (
    opening !== undefined &&
    closing !== undefined &&
    opening.trim().length === closing.trim().length
  ) {
    return surroundRange(state, range, {
      open: opening,
      close: closing,
      placeholder: selected || "代码",
    });
  }

  const content = selected || "代码";
  const fence = "`".repeat(longestBacktickRun(content) + 1);
  const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return surroundRange(state, range, {
    open: `${fence}${padding}`,
    close: `${padding}${fence}`,
    placeholder: content,
  });
}

function formatLink(state: EditorState, range: SelectionRange) {
  const selected = state.doc.sliceString(range.from, range.to);
  const line = state.doc.lineAt(range.from);
  if (range.to <= line.to) {
    for (const match of line.text.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/gu)) {
      const matchFrom = line.from + (match.index ?? 0);
      const matchTo = matchFrom + match[0].length;
      if (range.from < matchFrom || range.to > matchTo) continue;
      const label = match[1] ?? "";
      return {
        changes: { from: matchFrom, to: matchTo, insert: label },
        range: preserveDirection(range, matchFrom, matchFrom + label.length),
      };
    }
  }

  const label = selected || "链接文本";
  const destination = "https://";
  const insert = `[${label}](${destination})`;
  const selectionFrom = selected
    ? range.from + label.length + 3
    : range.from + 1;
  const selectionTo = selected
    ? selectionFrom + destination.length
    : selectionFrom + label.length;
  return {
    changes: { from: range.from, to: range.to, insert },
    range: preserveDirection(range, selectionFrom, selectionTo),
  };
}

function formatImage(state: EditorState, range: SelectionRange) {
  const selected = state.doc.sliceString(range.from, range.to);
  const line = state.doc.lineAt(range.from);
  if (range.to <= line.to) {
    for (const match of line.text.matchAll(/!\[([^\]\n]*)\]\(([^)\n]+)\)/gu)) {
      const matchFrom = line.from + (match.index ?? 0);
      const matchTo = matchFrom + match[0].length;
      if (range.from < matchFrom || range.to > matchTo) continue;
      const alt = match[1] ?? "";
      return {
        changes: { from: matchFrom, to: matchTo, insert: alt },
        range: preserveDirection(range, matchFrom, matchFrom + alt.length),
      };
    }
  }

  const alt = selected || "图片描述";
  const destination = "图片路径";
  const insert = `![${alt}](${destination})`;
  const selectionFrom = selected ? range.from + alt.length + 4 : range.from + 2;
  const selectionTo = selected
    ? selectionFrom + destination.length
    : selectionFrom + alt.length;
  return {
    changes: { from: range.from, to: range.to, insert },
    range: preserveDirection(range, selectionFrom, selectionTo),
  };
}

function selectedLineBounds(state: EditorState, range: SelectionRange) {
  const fromLine = state.doc.lineAt(range.from);
  const inclusiveTo =
    range.to > range.from && range.to === state.doc.lineAt(range.to).from
      ? range.to - 1
      : range.to;
  const toLine = state.doc.lineAt(inclusiveTo);
  return { from: fromLine.from, to: toLine.to };
}

function splitIndent(line: string): { indent: string; content: string } {
  const indent = /^ {0,3}/u.exec(line)?.[0] ?? "";
  return { indent, content: line.slice(indent.length) };
}

function splitListIndent(line: string): { indent: string; content: string } {
  const indent = /^[\t ]*/u.exec(line)?.[0] ?? "";
  return { indent, content: line.slice(indent.length) };
}

function stripHeading(content: string): string {
  return content.replace(/^#{1,6}(?:[\t ]+|$)/u, "");
}

function stripQuote(content: string): string {
  return content.replace(/^>[\t ]?/u, "");
}

function stripListMarker(content: string): string {
  return content.replace(/^(?:[-+*]|\d+[.)])[\t ]+/u, "");
}

function stripTaskListMarker(content: string): string {
  return content.replace(/^(?:[-+*]|\d+[.)])[\t ]+\[[ xX]\][\t ]+/u, "");
}

function transformLines(
  state: EditorState,
  range: SelectionRange,
  command: MarkdownFormatCommand,
) {
  const bounds = selectedLineBounds(state, range);
  const source = state.doc.sliceString(bounds.from, bounds.to);
  const lines = source.split("\n");
  const nonBlank = lines.filter((line) => line.trim().length > 0);
  let transformed: readonly string[];

  if (command.startsWith("heading")) {
    const level = Number(command.at(-1));
    const marker = "#".repeat(level);
    const allActive =
      nonBlank.length > 0 &&
      nonBlank.every((line) => {
        const { content } = splitIndent(line);
        return content.startsWith(`${marker} `);
      });
    transformed = lines.map((line) => {
      if (line.trim().length === 0) return line;
      const { indent, content } = splitIndent(line);
      const plain = stripHeading(content);
      return allActive ? `${indent}${plain}` : `${indent}${marker} ${plain}`;
    });
  } else if (command === "blockquote") {
    const allActive =
      nonBlank.length > 0 &&
      nonBlank.every((line) => splitIndent(line).content.startsWith(">"));
    transformed = lines.map((line) => {
      if (line.trim().length === 0) return line;
      const { indent, content } = splitIndent(line);
      return allActive
        ? `${indent}${stripQuote(content)}`
        : `${indent}> ${stripQuote(content)}`;
    });
  } else if (command === "taskList") {
    if (nonBlank.length === 0) {
      const insert = "- [ ] ";
      return {
        changes: { from: bounds.from, to: bounds.to, insert },
        range: EditorSelection.cursor(bounds.from + insert.length),
      };
    }
    const activePattern = /^(?:[-+*]|\d+[.)])[\t ]+\[[ xX]\][\t ]+/u;
    const allActive = nonBlank.every((line) =>
      activePattern.test(splitListIndent(line).content),
    );
    transformed = lines.map((line) => {
      if (line.trim().length === 0) return line;
      const { indent, content } = splitListIndent(line);
      if (allActive) return `${indent}${stripTaskListMarker(content)}`;
      if (activePattern.test(content)) return line;
      return `${indent}- [ ] ${stripListMarker(content)}`;
    });
  } else {
    const ordered = command === "orderedList";
    const activePattern = ordered ? /^\d+[.)][\t ]+/u : /^[-+*][\t ]+/u;
    const allActive =
      nonBlank.length > 0 &&
      nonBlank.every((line) =>
        activePattern.test(splitListIndent(line).content),
      );
    const orderedItemsByIndent = new Map<string, number>();
    transformed = lines.map((line) => {
      if (line.trim().length === 0) return line;
      const { indent, content } = splitListIndent(line);
      const plain = stripListMarker(content);
      const item = (orderedItemsByIndent.get(indent) ?? 0) + 1;
      orderedItemsByIndent.set(indent, item);
      return allActive
        ? `${indent}${plain}`
        : `${indent}${ordered ? `${item}.` : "-"} ${plain}`;
    });
  }

  const insert = transformed.join(state.lineBreak);
  const insertedDocumentLength = transformed.join("\n").length;
  return {
    changes: { from: bounds.from, to: bounds.to, insert },
    range: preserveDirection(
      range,
      bounds.from,
      bounds.from + insertedDocumentLength,
    ),
  };
}

function formatCodeBlock(state: EditorState, range: SelectionRange) {
  const bounds = selectedLineBounds(state, range);
  const selected = state.doc.sliceString(bounds.from, bounds.to);
  const firstLine = state.doc.lineAt(bounds.from);
  const lastLine = state.doc.lineAt(bounds.to);
  if (firstLine.number > 1 && lastLine.number < state.doc.lines) {
    const openingLine = state.doc.line(firstLine.number - 1);
    const closingLine = state.doc.line(lastLine.number + 1);
    const opening = /^(`{3,}|~{3,})[^\n]*$/u.exec(openingLine.text);
    if (opening !== null && closingLine.text === opening[1]) {
      return {
        changes: {
          from: openingLine.from,
          to: closingLine.to,
          insert: selected.replaceAll("\n", state.lineBreak),
        },
        range: preserveDirection(
          range,
          openingLine.from,
          openingLine.from + selected.length,
        ),
      };
    }
  }
  const existing = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1$/u.exec(selected);
  if (existing !== null) {
    const content = existing[2] ?? "";
    return {
      changes: {
        from: bounds.from,
        to: bounds.to,
        insert: content.replaceAll("\n", state.lineBreak),
      },
      range: preserveDirection(
        range,
        bounds.from,
        bounds.from + content.length,
      ),
    };
  }

  const content = selected || "代码";
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  const serializedContent = content.replaceAll("\n", state.lineBreak);
  const insert = `${fence}${state.lineBreak}${serializedContent}${state.lineBreak}${fence}`;
  return {
    changes: { from: bounds.from, to: bounds.to, insert },
    range: preserveDirection(
      range,
      bounds.from + fence.length + 1,
      bounds.from + fence.length + 1 + content.length,
    ),
  };
}

function formatMathBlock(state: EditorState, range: SelectionRange) {
  const bounds = selectedLineBounds(state, range);
  const selected = state.doc.sliceString(bounds.from, bounds.to);
  const firstLine = state.doc.lineAt(bounds.from);
  const lastLine = state.doc.lineAt(bounds.to);
  if (firstLine.number > 1 && lastLine.number < state.doc.lines) {
    const openingLine = state.doc.line(firstLine.number - 1);
    const closingLine = state.doc.line(lastLine.number + 1);
    const opening = /^(`{3,}|~{3,})(?:katex|math|latex)[\t ]*$/iu.exec(
      openingLine.text,
    );
    if (opening !== null && closingLine.text === opening[1]) {
      return {
        changes: {
          from: openingLine.from,
          to: closingLine.to,
          insert: selected.replaceAll("\n", state.lineBreak),
        },
        range: preserveDirection(
          range,
          openingLine.from,
          openingLine.from + selected.length,
        ),
      };
    }
  }

  const existing =
    /^(`{3,}|~{3,})(?:katex|math|latex)[^\n]*\n([\s\S]*?)\n\1$/iu.exec(
      selected,
    );
  if (existing !== null) {
    const content = existing[2] ?? "";
    return {
      changes: {
        from: bounds.from,
        to: bounds.to,
        insert: content.replaceAll("\n", state.lineBreak),
      },
      range: preserveDirection(
        range,
        bounds.from,
        bounds.from + content.length,
      ),
    };
  }

  const content = selected || "E = mc^2";
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  const serializedContent = content.replaceAll("\n", state.lineBreak);
  const insert = `${fence}katex${state.lineBreak}${serializedContent}${state.lineBreak}${fence}`;
  return {
    changes: { from: bounds.from, to: bounds.to, insert },
    range: preserveDirection(
      range,
      bounds.from + fence.length + "katex".length + 1,
      bounds.from + fence.length + "katex".length + 1 + content.length,
    ),
  };
}

function insertStandaloneBlock(
  state: EditorState,
  range: SelectionRange,
  block: string,
  selectionOffset: number,
  selectionLength = 0,
) {
  const position = range.to;
  let newlinesBefore = 0;
  for (let cursor = position - 1; cursor >= 0 && newlinesBefore < 2; cursor--) {
    if (state.doc.sliceString(cursor, cursor + 1) !== "\n") break;
    newlinesBefore++;
  }
  let newlinesAfter = 0;
  for (
    let cursor = position;
    cursor < state.doc.length && newlinesAfter < 2;
    cursor++
  ) {
    if (state.doc.sliceString(cursor, cursor + 1) !== "\n") break;
    newlinesAfter++;
  }
  const prefixCount = position === 0 ? 0 : Math.max(0, 2 - newlinesBefore);
  const suffixCount =
    position === state.doc.length ? 0 : Math.max(0, 2 - newlinesAfter);
  const prefix = state.lineBreak.repeat(prefixCount);
  const suffix = state.lineBreak.repeat(suffixCount);
  const serializedBlock = block.replaceAll("\n", state.lineBreak);
  const insert = `${prefix}${serializedBlock}${suffix}`;
  const selectionFrom = position + prefixCount + selectionOffset;
  return {
    changes: { from: position, insert },
    range: EditorSelection.range(
      selectionFrom,
      selectionFrom + selectionLength,
    ),
  };
}

/** Builds one undoable transaction over every selection range. */
export function createMarkdownFormattingTransaction(
  state: EditorState,
  command: MarkdownFormatCommand,
): TransactionSpec {
  const format = inlineFormats[command];
  const transaction = state.changeByRange((range) => {
    if (format !== undefined) return surroundRange(state, range, format);
    if (command === "inlineCode") return formatInlineCode(state, range);
    if (command === "link") return formatLink(state, range);
    if (command === "image") return formatImage(state, range);
    if (command === "codeBlock") return formatCodeBlock(state, range);
    if (command === "mathBlock") return formatMathBlock(state, range);
    if (command === "horizontalRule") {
      return insertStandaloneBlock(state, range, "---", 3);
    }
    if (command === "toc") {
      return insertStandaloneBlock(state, range, "[toc]", 5);
    }
    if (command === "pageBreak") {
      return insertStandaloneBlock(
        state,
        range,
        '<div class="page-break"></div>',
        30,
      );
    }
    if (command === "table") {
      return insertStandaloneBlock(
        state,
        range,
        starterTable,
        starterTableFirstCell,
      );
    }
    return transformLines(state, range, command);
  });

  return {
    ...transaction,
    scrollIntoView: true,
    userEvent: `input.format.${command}`,
  };
}

export function runMarkdownFormat(command: MarkdownFormatCommand) {
  return (view: EditorView): boolean => {
    if (view.state.readOnly) return false;
    view.dispatch(createMarkdownFormattingTransaction(view.state, command));
    view.focus();
    return true;
  };
}
