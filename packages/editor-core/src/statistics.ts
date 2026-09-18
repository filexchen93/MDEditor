import type { EditorState, SelectionRange } from "@codemirror/state";

export interface TextStatistics {
  readonly words: number;
  /** Unicode code points excluding line separators. */
  readonly characters: number;
  readonly nonWhitespaceCharacters: number;
  readonly lines: number;
  readonly readingTimeMinutes: number;
}

export interface DocumentStatistics {
  readonly document: TextStatistics;
  readonly selection: TextStatistics | null;
}

interface MutableStatistics {
  words: number;
  characters: number;
  nonWhitespaceCharacters: number;
  lines: number;
}

function emptyStatistics(lines = 0): MutableStatistics {
  return { words: 0, characters: 0, nonWhitespaceCharacters: 0, lines };
}

function countFragment(target: MutableStatistics, text: string): void {
  const normalized = text.normalize("NFC");
  target.words +=
    normalized.match(/\p{Script=Han}|[\p{Letter}\p{Number}\p{Mark}]+/gu)
      ?.length ?? 0;
  for (const character of normalized) {
    if (character === "\r" || character === "\n") continue;
    target.characters += 1;
    if (!/\s/u.test(character)) target.nonWhitespaceCharacters += 1;
  }
}

function finishStatistics(value: MutableStatistics): TextStatistics {
  return {
    ...value,
    readingTimeMinutes:
      value.words === 0 ? 0 : Math.max(1, Math.ceil(value.words / 300)),
  };
}

export function calculateTextStatistics(text: string): TextStatistics {
  const result = emptyStatistics(text.split(/\r\n|\r|\n/u).length);
  countFragment(result, text);
  return finishStatistics(result);
}

function mergedSelectionRanges(
  ranges: readonly SelectionRange[],
): Array<{ from: number; to: number }> {
  const selected = ranges
    .filter((range) => !range.empty)
    .map((range) => ({ from: range.from, to: range.to }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of selected) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

async function yieldIfNeeded(
  startedAt: number,
  isCurrent: () => boolean,
): Promise<number | null> {
  if (performance.now() - startedAt < 8) return startedAt;
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  return isCurrent() ? performance.now() : null;
}

async function countDocument(
  state: EditorState,
  isCurrent: () => boolean,
): Promise<TextStatistics | null> {
  const result = emptyStatistics(state.doc.lines);
  let startedAt = performance.now();
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    countFragment(result, state.doc.line(lineNumber).text);
    const nextStartedAt = await yieldIfNeeded(startedAt, isCurrent);
    if (nextStartedAt === null) return null;
    startedAt = nextStartedAt;
  }
  return finishStatistics(result);
}

async function countSelections(
  state: EditorState,
  isCurrent: () => boolean,
): Promise<TextStatistics | null | undefined> {
  const ranges = mergedSelectionRanges(state.selection.ranges);
  if (ranges.length === 0) return undefined;
  const result = emptyStatistics();
  let startedAt = performance.now();
  for (const range of ranges) {
    let line = state.doc.lineAt(range.from);
    const finalLine = state.doc.lineAt(
      Math.max(range.from, range.to - 1),
    ).number;
    while (line.number <= finalLine) {
      const from = Math.max(range.from, line.from);
      const to = Math.min(range.to, line.to);
      countFragment(result, state.sliceDoc(from, to));
      result.lines += 1;
      const nextStartedAt = await yieldIfNeeded(startedAt, isCurrent);
      if (nextStartedAt === null) return null;
      startedAt = nextStartedAt;
      if (line.number === state.doc.lines) break;
      line = state.doc.line(line.number + 1);
    }
  }
  return finishStatistics(result);
}

/** Computes disposable statistics in short slices and supports cancellation. */
export async function calculateEditorStatistics(
  state: EditorState,
  isCurrent: () => boolean = () => true,
): Promise<DocumentStatistics | null> {
  const document = await countDocument(state, isCurrent);
  if (document === null) return null;
  const selection = await countSelections(state, isCurrent);
  if (selection === null || !isCurrent()) return null;
  return { document, selection: selection ?? null };
}
