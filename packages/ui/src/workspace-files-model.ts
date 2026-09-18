import type { WorkspaceEntry } from "@mdeditor/document-session";

export const WORKSPACE_ROW_HEIGHT = 30;
const OVERSCAN = 8;

export interface VirtualRange {
  readonly start: number;
  readonly end: number;
}

export function deriveVirtualRange(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
): VirtualRange {
  const safeCount = Math.max(0, itemCount);
  const firstVisible = Math.floor(
    Math.max(0, scrollTop) / WORKSPACE_ROW_HEIGHT,
  );
  const visibleCount = Math.ceil(
    Math.max(WORKSPACE_ROW_HEIGHT, viewportHeight) / WORKSPACE_ROW_HEIGHT,
  );
  return {
    start: Math.max(0, firstVisible - OVERSCAN),
    end: Math.min(safeCount, firstVisible + visibleCount + OVERSCAN),
  };
}

export function filterWorkspaceEntries(
  entries: readonly WorkspaceEntry[],
  query: string,
): readonly WorkspaceEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized === "") return entries;
  return entries.filter((entry) =>
    entry.relativePath.toLocaleLowerCase().includes(normalized),
  );
}
