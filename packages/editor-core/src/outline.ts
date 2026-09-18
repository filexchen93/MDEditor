import type { OutlineItem } from "./source-editor.js";

export interface OutlineViewItem extends OutlineItem {
  readonly hasChildren: boolean;
}

function includesQuery(item: OutlineItem, normalizedQuery: string): boolean {
  return item.text.toLocaleLowerCase().includes(normalizedQuery);
}

/**
 * Adds hierarchy metadata and applies disposable outline UI state.
 * Filtering deliberately reveals matches inside collapsed branches.
 */
export function deriveOutlineView(
  items: readonly OutlineItem[],
  query = "",
  collapsedItems: ReadonlySet<number> = new Set<number>(),
): readonly OutlineViewItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const result: OutlineViewItem[] = [];
  let hiddenBelowLevel: number | null = null;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const hasChildren = (items[index + 1]?.level ?? 0) > item.level;

    if (normalizedQuery !== "") {
      if (includesQuery(item, normalizedQuery)) {
        result.push({ ...item, hasChildren });
      }
      continue;
    }

    if (hiddenBelowLevel !== null) {
      if (item.level > hiddenBelowLevel) continue;
      hiddenBelowLevel = null;
    }

    result.push({ ...item, hasChildren });
    if (hasChildren && collapsedItems.has(item.from)) {
      hiddenBelowLevel = item.level;
    }
  }

  return result;
}
