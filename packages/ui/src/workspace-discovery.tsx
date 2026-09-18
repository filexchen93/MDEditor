import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";

import type {
  OpenedWorkspace,
  WorkspaceEntry,
  WorkspaceSearchMatch,
  WorkspaceSearchOptions,
} from "@mdeditor/document-session";

import { rankWorkspaceFiles } from "./workspace-search-model.js";

export type WorkspaceSearchPhase =
  "idle" | "searching" | "complete" | "cancelled" | "error";

export interface WorkspaceDiscoveryProps {
  readonly workspace: OpenedWorkspace;
  readonly disabled: boolean;
  readonly searchAvailable: boolean;
  readonly searchPhase: WorkspaceSearchPhase;
  readonly searchMatches: readonly WorkspaceSearchMatch[];
  readonly searchTruncated: boolean;
  readonly onOpen: (entry: WorkspaceEntry) => void;
  readonly onOpenMatch: (match: WorkspaceSearchMatch) => void;
  readonly onStartSearch: (
    query: string,
    options: WorkspaceSearchOptions,
  ) => void;
  readonly onCancelSearch: () => void;
}

export function WorkspaceDiscovery({
  workspace,
  disabled,
  searchAvailable,
  searchPhase,
  searchMatches,
  searchTruncated,
  onOpen,
  onOpenMatch,
  onStartSearch,
  onCancelSearch,
}: WorkspaceDiscoveryProps) {
  const [mode, setMode] = useState<"quick" | "search" | null>(null);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickIndex, setQuickIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [options, setOptions] = useState<WorkspaceSearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regularExpression: false,
  });
  const quickMatches = useMemo(
    () => rankWorkspaceFiles(workspace.entries, quickQuery),
    [quickQuery, workspace.entries],
  );

  function handleQuickKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setMode(null);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setQuickIndex((current) => {
        if (quickMatches.length === 0) return 0;
        return (
          (current + direction + quickMatches.length) % quickMatches.length
        );
      });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected = quickMatches[quickIndex];
      if (selected !== undefined) {
        onOpen(selected);
        setMode(null);
      }
    }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (query === "" || disabled || !searchAvailable) return;
    onStartSearch(query, options);
  }

  return (
    <div className="workspace-discovery">
      <div className="workspace-discovery-actions">
        <button
          type="button"
          disabled={disabled}
          aria-pressed={mode === "quick"}
          onClick={() => {
            setMode(mode === "quick" ? null : "quick");
            setQuickQuery("");
            setQuickIndex(0);
          }}
        >
          快速打开
        </button>
        <button
          type="button"
          disabled={disabled || !searchAvailable}
          aria-pressed={mode === "search"}
          onClick={() => setMode(mode === "search" ? null : "search")}
        >
          全局搜索
        </button>
      </div>
      {mode === "quick" ? (
        <section className="workspace-discovery-panel" aria-label="快速打开">
          <label>
            <span>模糊查找 Markdown 文件</span>
            <input
              autoFocus
              type="search"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              value={quickQuery}
              aria-controls="workspace-quick-open-results"
              aria-activedescendant={
                quickMatches[quickIndex] === undefined
                  ? undefined
                  : `workspace-quick-${quickIndex}`
              }
              onChange={(event) => {
                setQuickQuery(event.currentTarget.value);
                setQuickIndex(0);
              }}
              onKeyDown={handleQuickKeyDown}
            />
          </label>
          <ul
            id="workspace-quick-open-results"
            role="listbox"
            aria-label="匹配的 Markdown 文件"
          >
            {quickMatches.map((entry, index) => (
              <li key={entry.relativePath} role="presentation">
                <button
                  id={`workspace-quick-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === quickIndex}
                  title={entry.relativePath}
                  onMouseEnter={() => setQuickIndex(index)}
                  onClick={() => {
                    onOpen(entry);
                    setMode(null);
                  }}
                >
                  {entry.relativePath}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {mode === "search" ? (
        <section className="workspace-discovery-panel" aria-label="全局搜索">
          <form onSubmit={submitSearch}>
            <label>
              <span>搜索工作区内容</span>
              <input
                autoFocus
                required
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
              />
            </label>
            <div className="workspace-search-options">
              <label>
                <input
                  type="checkbox"
                  checked={options.caseSensitive}
                  onChange={(event) =>
                    setOptions({
                      ...options,
                      caseSensitive: event.currentTarget.checked,
                    })
                  }
                />
                区分大小写
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={options.wholeWord}
                  onChange={(event) =>
                    setOptions({
                      ...options,
                      wholeWord: event.currentTarget.checked,
                    })
                  }
                />
                全字匹配
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={options.regularExpression}
                  onChange={(event) =>
                    setOptions({
                      ...options,
                      regularExpression: event.currentTarget.checked,
                    })
                  }
                />
                正则表达式
              </label>
            </div>
            <div>
              <button
                type="submit"
                disabled={disabled || searchQuery.trim() === ""}
              >
                搜索
              </button>
              <button
                type="button"
                disabled={searchPhase !== "searching"}
                onClick={onCancelSearch}
              >
                取消搜索
              </button>
            </div>
          </form>
          <p role="status" className="workspace-search-status">
            {searchPhase === "searching"
              ? `正在搜索，已找到 ${searchMatches.length} 处…`
              : searchPhase === "cancelled"
                ? `搜索已取消，保留 ${searchMatches.length} 处结果。`
                : searchPhase === "error"
                  ? "搜索失败，请查看应用提示。"
                  : searchPhase === "complete"
                    ? `找到 ${searchMatches.length} 处${searchTruncated ? "（已达到结果上限）" : ""}。`
                    : "输入内容后搜索授权工作区中的 Markdown 文件。"}
          </p>
          <ol className="workspace-search-results">
            {searchMatches.map((match, index) => (
              <li
                key={`${match.relativePath}:${match.line}:${match.column}:${index}`}
              >
                <button type="button" onClick={() => onOpenMatch(match)}>
                  <strong>
                    {match.relativePath}:{match.line}:{match.column}
                  </strong>
                  <span>{match.preview}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
