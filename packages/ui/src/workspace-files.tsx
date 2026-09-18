import { useMemo, useState, type FormEvent, type UIEvent } from "react";

import type {
  OpenedWorkspace,
  WorkspaceEntry,
  WorkspaceImageInspection,
  WorkspaceImageIssue,
  WorkspaceSearchMatch,
  WorkspaceSearchOptions,
} from "@mdeditor/document-session";
import {
  WorkspaceDiscovery,
  type WorkspaceSearchPhase,
} from "./workspace-discovery.js";
import {
  deriveVirtualRange,
  filterWorkspaceEntries,
  WORKSPACE_ROW_HEIGHT,
} from "./workspace-files-model.js";

const DEFAULT_VIEWPORT_HEIGHT = 480;
const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd"];
const IMAGE_EXTENSIONS = [".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"];

function isMarkdownEntry(entry: WorkspaceEntry): boolean {
  const lower = entry.name.toLocaleLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function isImageEntry(entry: WorkspaceEntry): boolean {
  if (entry.kind !== "file") return false;
  const lower = entry.name.toLocaleLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function entryDepth(entry: WorkspaceEntry): number {
  return entry.relativePath.split("/").length;
}

export interface WorkspaceFilesProps {
  readonly workspace: OpenedWorkspace;
  readonly busy: boolean;
  readonly onOpen: (entry: WorkspaceEntry) => void;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
  readonly onCreateFile: (relativePath: string) => Promise<boolean>;
  readonly onCreateDirectory: (relativePath: string) => Promise<boolean>;
  readonly onImportImage: () => Promise<boolean>;
  readonly onInspectImages: () => Promise<WorkspaceImageInspection | null>;
  readonly onConsolidateImages: (
    destinationRelativePath: string,
  ) => Promise<boolean>;
  readonly onOpenImageIssue: (issue: WorkspaceImageIssue) => void;
  readonly onMove: (
    entry: WorkspaceEntry,
    destinationRelativePath: string,
  ) => Promise<boolean>;
  readonly onCopy: (
    entry: WorkspaceEntry,
    destinationRelativePath: string,
  ) => Promise<boolean>;
  readonly onCopyImageWithReferences: (
    entry: WorkspaceEntry,
    destinationRelativePath: string,
  ) => Promise<boolean>;
  readonly onDelete: (entry: WorkspaceEntry) => Promise<boolean>;
  readonly searchAvailable: boolean;
  readonly searchPhase: WorkspaceSearchPhase;
  readonly searchMatches: readonly WorkspaceSearchMatch[];
  readonly searchTruncated: boolean;
  readonly onOpenSearchMatch: (match: WorkspaceSearchMatch) => void;
  readonly onStartSearch: (
    query: string,
    options: WorkspaceSearchOptions,
  ) => void;
  readonly onCancelSearch: () => void;
}

export function WorkspaceFiles({
  workspace,
  busy,
  onOpen,
  onRefresh,
  onClose,
  onCreateFile,
  onCreateDirectory,
  onImportImage,
  onInspectImages,
  onConsolidateImages,
  onOpenImageIssue,
  onMove,
  onCopy,
  onCopyImageWithReferences,
  onDelete,
  searchAvailable,
  searchPhase,
  searchMatches,
  searchTruncated,
  onOpenSearchMatch,
  onStartSearch,
  onCancelSearch,
}: WorkspaceFilesProps) {
  const [filter, setFilter] = useState("");
  const [createKind, setCreateKind] = useState<"file" | "directory" | null>(
    null,
  );
  const [createPath, setCreatePath] = useState("");
  const [managedEntry, setManagedEntry] = useState<WorkspaceEntry | null>(null);
  const [destinationPath, setDestinationPath] = useState("");
  const [imageInspection, setImageInspection] =
    useState<WorkspaceImageInspection | null>(null);
  const [inspectingImages, setInspectingImages] = useState(false);
  const [consolidatingImages, setConsolidatingImages] = useState(false);
  const [consolidationPath, setConsolidationPath] = useState("assets");
  const [viewport, setViewport] = useState({
    scrollTop: 0,
    height: DEFAULT_VIEWPORT_HEIGHT,
  });
  const entries = useMemo(
    () => filterWorkspaceEntries(workspace.entries, filter),
    [filter, workspace.entries],
  );
  const range = deriveVirtualRange(
    entries.length,
    viewport.scrollTop,
    viewport.height,
  );
  const visible = entries.slice(range.start, range.end);
  const activeManagedEntry =
    managedEntry === null
      ? null
      : (workspace.entries.find(
          (entry) =>
            entry.kind === managedEntry.kind &&
            entry.relativePath === managedEntry.relativePath,
        ) ?? null);

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    setViewport({
      scrollTop: event.currentTarget.scrollTop,
      height: event.currentTarget.clientHeight || DEFAULT_VIEWPORT_HEIGHT,
    });
  }

  async function submitCreation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const relativePath = createPath.trim();
    if (createKind === null || relativePath === "" || busy) return;
    const created =
      createKind === "file"
        ? await onCreateFile(relativePath)
        : await onCreateDirectory(relativePath);
    if (created) {
      setCreateKind(null);
      setCreatePath("");
    }
  }

  async function submitMove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const destination = destinationPath.trim();
    if (activeManagedEntry === null || destination === "" || busy) return;
    if (await onMove(activeManagedEntry, destination)) {
      setManagedEntry(null);
      setDestinationPath("");
    }
  }

  async function copyManagedEntry() {
    const destination = destinationPath.trim();
    if (activeManagedEntry === null || destination === "" || busy) return;
    if (await onCopy(activeManagedEntry, destination)) {
      setManagedEntry(null);
      setDestinationPath("");
    }
  }

  async function copyManagedImageWithReferences() {
    const destination = destinationPath.trim();
    if (
      activeManagedEntry === null ||
      !isImageEntry(activeManagedEntry) ||
      destination === "" ||
      busy
    ) {
      return;
    }
    if (await onCopyImageWithReferences(activeManagedEntry, destination)) {
      setManagedEntry(null);
      setDestinationPath("");
    }
  }

  async function deleteManagedEntry() {
    if (activeManagedEntry === null || busy) return;
    if (await onDelete(activeManagedEntry)) {
      setManagedEntry(null);
      setDestinationPath("");
    }
  }

  async function submitImageConsolidation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const destination = consolidationPath.trim();
    if (destination === "" || busy) return;
    if (await onConsolidateImages(destination)) {
      setConsolidatingImages(false);
    }
  }

  return (
    <aside className="workspace-files" aria-label="工作区文件">
      <div className="workspace-files-heading">
        <div>
          <strong>{workspace.name}</strong>
          <span title={workspace.root}>{entries.length} 个条目</span>
        </div>
        <div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setCreateKind("file");
              setCreatePath("");
            }}
          >
            新建文档
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setCreateKind("directory");
              setCreatePath("");
            }}
          >
            新建文件夹
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onImportImage()}
          >
            导入图片
          </button>
          <button
            type="button"
            disabled={busy || inspectingImages}
            onClick={() => {
              setInspectingImages(true);
              void onInspectImages()
                .then((inspection) => {
                  if (inspection !== null) setImageInspection(inspection);
                })
                .finally(() => setInspectingImages(false));
            }}
          >
            {inspectingImages ? "正在检查…" : "检查图片"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setConsolidatingImages(true);
              setConsolidationPath("assets");
            }}
          >
            归拢图片
          </button>
          <button type="button" disabled={busy} onClick={onRefresh}>
            刷新
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
      <WorkspaceDiscovery
        workspace={workspace}
        disabled={busy}
        searchAvailable={searchAvailable}
        searchPhase={searchPhase}
        searchMatches={searchMatches}
        searchTruncated={searchTruncated}
        onOpen={onOpen}
        onOpenMatch={onOpenSearchMatch}
        onStartSearch={onStartSearch}
        onCancelSearch={onCancelSearch}
      />
      {createKind === null ? null : (
        <form
          className="workspace-file-create"
          onSubmit={(event) => void submitCreation(event)}
        >
          <label>
            <span>
              {createKind === "file"
                ? "新建 Markdown 相对路径"
                : "新建文件夹相对路径"}
            </span>
            <input
              autoFocus
              required
              value={createPath}
              placeholder={
                createKind === "file" ? "文档/新笔记.md" : "文档/新目录"
              }
              onChange={(event) => setCreatePath(event.currentTarget.value)}
            />
          </label>
          <div>
            <button type="submit" disabled={busy || createPath.trim() === ""}>
              创建
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setCreateKind(null);
                setCreatePath("");
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}
      {!consolidatingImages ? null : (
        <form
          className="workspace-file-create"
          onSubmit={(event) => void submitImageConsolidation(event)}
        >
          <label>
            <span>图片归拢目录</span>
            <input
              autoFocus
              required
              value={consolidationPath}
              placeholder="assets"
              onChange={(event) =>
                setConsolidationPath(event.currentTarget.value)
              }
            />
          </label>
          <div>
            <button
              type="submit"
              disabled={busy || consolidationPath.trim() === ""}
            >
              预览并归拢
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConsolidatingImages(false)}
            >
              取消
            </button>
          </div>
        </form>
      )}
      {activeManagedEntry === null ? null : (
        <form
          className="workspace-file-manage"
          onSubmit={(event) => void submitMove(event)}
        >
          <strong title={activeManagedEntry.relativePath}>
            操作：{activeManagedEntry.relativePath}
          </strong>
          <label>
            <span>目标相对路径</span>
            <input
              autoFocus
              required
              value={destinationPath}
              placeholder={activeManagedEntry.relativePath}
              onChange={(event) =>
                setDestinationPath(event.currentTarget.value)
              }
            />
          </label>
          <div>
            <button
              type="submit"
              disabled={busy || destinationPath.trim() === ""}
            >
              移动 / 重命名
            </button>
            <button
              type="button"
              disabled={busy || destinationPath.trim() === ""}
              onClick={() => void copyManagedEntry()}
            >
              复制
            </button>
            {isImageEntry(activeManagedEntry) ? (
              <button
                type="button"
                disabled={busy || destinationPath.trim() === ""}
                onClick={() => void copyManagedImageWithReferences()}
              >
                复制并切换引用
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => void deleteManagedEntry()}
            >
              移到回收站
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setManagedEntry(null);
                setDestinationPath("");
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}
      {imageInspection === null ? null : (
        <section
          className="workspace-image-issues"
          aria-label="图片引用检查结果"
        >
          <div>
            <strong>
              {imageInspection.issues.length === 0
                ? "未发现失效图片引用"
                : `${imageInspection.issues.length} 个图片引用问题`}
            </strong>
            {imageInspection.truncated ? <span>结果已达到上限</span> : null}
            <button
              type="button"
              onClick={() => setImageInspection(null)}
              aria-label="关闭图片引用检查结果"
            >
              ×
            </button>
          </div>
          {imageInspection.issues.length === 0 ? null : (
            <ul>
              {imageInspection.issues.map((issue) => (
                <li
                  key={`${issue.documentRelativePath}:${issue.line}:${issue.column}:${issue.target}`}
                >
                  <button
                    type="button"
                    disabled={busy}
                    title={issue.reason}
                    onClick={() => onOpenImageIssue(issue)}
                  >
                    <span>
                      {issue.documentRelativePath}:{issue.line}:{issue.column}
                    </span>
                    <code>{issue.target}</code>
                    <small>{issue.reason}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <label className="workspace-file-filter">
        <span>筛选工作区文件</span>
        <input
          type="search"
          value={filter}
          placeholder="筛选路径…"
          onChange={(event) => {
            setFilter(event.currentTarget.value);
            setViewport((current) => ({ ...current, scrollTop: 0 }));
          }}
        />
      </label>
      {entries.length === 0 ? (
        <p className="workspace-files-empty">没有匹配的文件</p>
      ) : (
        <div
          key={filter}
          className="workspace-file-viewport"
          role="tree"
          aria-label={`${workspace.name} 文件树`}
          onScroll={handleScroll}
        >
          <div
            className="workspace-file-spacer"
            style={{ height: `${entries.length * WORKSPACE_ROW_HEIGHT}px` }}
          >
            {visible.map((entry, visibleIndex) => {
              const index = range.start + visibleIndex;
              const depth = entryDepth(entry);
              const markdown = entry.kind === "file" && isMarkdownEntry(entry);
              return (
                <div
                  className="workspace-file-row"
                  key={`${entry.kind}:${entry.relativePath}`}
                  role="treeitem"
                  aria-level={depth}
                  aria-posinset={index + 1}
                  aria-setsize={entries.length}
                  style={{
                    top: `${index * WORKSPACE_ROW_HEIGHT}px`,
                    paddingLeft: `${8 + (depth - 1) * 14}px`,
                  }}
                >
                  <span aria-hidden="true">
                    {entry.kind === "directory" ? "▸" : markdown ? "#" : "·"}
                  </span>
                  {entry.kind === "directory" ? (
                    <span
                      className="workspace-file-label"
                      title={entry.relativePath}
                    >
                      {entry.name}
                    </span>
                  ) : (
                    <button
                      className="workspace-file-open"
                      type="button"
                      disabled={busy || !markdown}
                      title={
                        markdown
                          ? entry.relativePath
                          : `${entry.relativePath}（当前只能打开 Markdown）`
                      }
                      onClick={() => onOpen(entry)}
                    >
                      {entry.name}
                    </button>
                  )}
                  <button
                    className="workspace-file-manage-button"
                    type="button"
                    disabled={busy}
                    aria-label={`管理 ${entry.name}`}
                    title={`移动、重命名或复制 ${entry.relativePath}`}
                    onClick={() => {
                      setManagedEntry(entry);
                      setDestinationPath(entry.relativePath);
                    }}
                  >
                    …
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}
