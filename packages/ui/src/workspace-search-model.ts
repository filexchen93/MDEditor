import type { WorkspaceEntry } from "@mdeditor/document-session";

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd"];

function isMarkdownPath(path: string): boolean {
  const normalized = path.toLocaleLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) =>
    normalized.endsWith(extension),
  );
}

function fuzzyScore(candidate: string, query: string): number | null {
  const haystack = candidate.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  let score = 0;
  let position = -1;
  let previous = -2;
  for (const character of needle) {
    position = haystack.indexOf(character, position + 1);
    if (position < 0) return null;
    score += position === previous + 1 ? 8 : 2;
    if (position === 0 || "/-_ .".includes(haystack[position - 1] ?? "")) {
      score += 5;
    }
    previous = position;
  }
  if (haystack.includes(needle)) score += 30;
  return score - haystack.length / 100;
}

export function rankWorkspaceFiles(
  entries: readonly WorkspaceEntry[],
  query: string,
  limit = 100,
): readonly WorkspaceEntry[] {
  const normalized = query.trim();
  const scored = entries
    .filter(
      (entry) => entry.kind === "file" && isMarkdownPath(entry.relativePath),
    )
    .map((entry) => ({
      entry,
      score: normalized === "" ? 0 : fuzzyScore(entry.relativePath, normalized),
    }))
    .filter(
      (candidate): candidate is { entry: WorkspaceEntry; score: number } =>
        candidate.score !== null,
    );
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.entry.relativePath.localeCompare(right.entry.relativePath),
  );
  return scored.slice(0, Math.max(0, limit)).map(({ entry }) => entry);
}

export function documentPositionFromLineColumn(
  text: string,
  line: number,
  column: number,
): number {
  const lines = text.split("\n");
  const targetLine = Math.max(1, Math.min(line, lines.length));
  let position = 0;
  for (let index = 0; index < targetLine - 1; index += 1) {
    position += (lines[index]?.length ?? 0) + 1;
  }
  return (
    position +
    Math.max(0, Math.min(column - 1, lines[targetLine - 1]?.length ?? 0))
  );
}
