import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type SyntheticEvent,
} from "react";

import {
  createUntitledSession,
  createWorkspaceRecoverySnapshot,
  decodeDocument,
  encodeDocument,
  isDirty,
  normalizeLineEndings,
  type DecodedDocument,
  type DocumentAdapter,
  type ExternalDocumentEvent,
  type OpenedDocumentFile,
  type OpenedWorkspace,
  type WorkspaceEntry,
  type WorkspaceImageInspection,
  type WorkspaceImageIssue,
  type WorkspaceSearchEvent,
  type WorkspaceSearchMatch,
  type WorkspaceSearchOptions,
  type PandocStatus,
} from "@mdeditor/document-session";
import {
  createSourceEditor,
  deriveOutlineView,
  type ComplexBlockRenderers,
  type DocumentStatistics,
  type EditorMode,
  type MarkdownFormatCommand,
  type OutlineItem,
  type SourceEditor,
  type TableEditCommand,
} from "@mdeditor/editor-core";
import {
  compileDocumentCss,
  createDocxExportName,
  createHtmlExportName,
  createImageExportName,
  createSafeHtmlDocument,
  renderMarkdownToSafeHtml,
  resolveSafeHtmlImageSources,
  resolveSafeHtmlMathExpressions,
  resolveSafeHtmlMermaidDiagrams,
  type ExportTheme,
  type HtmlExportStyle,
} from "@mdeditor/markdown";

import { renderSafeHtmlToPng } from "./image-export.js";
import { prepareSafeHtmlForDocx } from "./docx-export.js";
import {
  installDocumentTheme,
  installTrustedDocumentCss,
  loadDocumentStyleLibrary,
  removeDocumentTheme,
  saveDocumentStyleLibrary,
} from "./document-styles.js";

import {
  formatShortcut,
  hasShortcutConflict,
  loadAppSettings,
  MAXIMUM_PRINT_TEMPLATE_CHARACTERS,
  matchShortcut,
  saveAppSettings,
  SHORTCUT_ACTIONS,
  SUPPORTED_SHORTCUTS,
  type AppSettings,
  type AutoSaveDelaySeconds,
  type ShortcutAction,
} from "./settings.js";
import {
  createWorkspaceState,
  findWorkspaceTabByPath,
  getActiveWorkspaceTab,
  workspaceReducer,
} from "./workspace.js";
import { WorkspaceFiles } from "./workspace-files.js";
import { documentPositionFromLineColumn } from "./workspace-search-model.js";
import type { WorkspaceSearchPhase } from "./workspace-discovery.js";

const shortcutNames: Readonly<Record<ShortcutAction, string>> = {
  newDocument: "新建",
  openDocument: "打开",
  saveDocument: "保存",
  saveDocumentAs: "另存为",
  toggleMode: "切换模式",
  toggleOutline: "切换大纲",
};

const WORKSPACE_IMAGE_EXTENSIONS = [
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
] as const;
const WORKSPACE_MARKDOWN_EXTENSIONS = [
  ".md",
  ".markdown",
  ".mdown",
  ".mkd",
] as const;

function isWorkspaceImageEntry(entry: WorkspaceEntry): boolean {
  if (entry.kind !== "file") return false;
  const name = entry.name.toLocaleLowerCase();
  return WORKSPACE_IMAGE_EXTENSIONS.some((extension) =>
    name.endsWith(extension),
  );
}

function isWorkspaceMarkdownEntry(entry: WorkspaceEntry): boolean {
  if (entry.kind !== "file") return false;
  const name = entry.name.toLocaleLowerCase();
  return WORKSPACE_MARKDOWN_EXTENSIONS.some((extension) =>
    name.endsWith(extension),
  );
}

const formattingActions: readonly {
  readonly command: MarkdownFormatCommand;
  readonly label: string;
  readonly title: string;
}[] = [
  { command: "bold", label: "粗体", title: "粗体（Ctrl/⌘ B）" },
  { command: "italic", label: "斜体", title: "斜体（Ctrl/⌘ I）" },
  { command: "strikethrough", label: "删除线", title: "删除线" },
  { command: "inlineCode", label: "行内代码", title: "行内代码" },
  { command: "link", label: "链接", title: "链接（Ctrl/⌘ K）" },
  { command: "heading1", label: "H1", title: "一级标题" },
  { command: "heading2", label: "H2", title: "二级标题" },
  { command: "heading3", label: "H3", title: "三级标题" },
  { command: "blockquote", label: "引用", title: "引用块" },
  { command: "bulletList", label: "项目列表", title: "无序列表" },
  { command: "orderedList", label: "编号列表", title: "有序列表" },
  { command: "codeBlock", label: "代码块", title: "围栏代码块" },
  { command: "image", label: "图片", title: "插入图片" },
  { command: "taskList", label: "任务", title: "插入任务" },
  { command: "mathBlock", label: "数学块", title: "插入 KaTeX 数学块" },
  { command: "horizontalRule", label: "分隔线", title: "插入水平线" },
  { command: "toc", label: "目录", title: "插入目录" },
  { command: "pageBreak", label: "分页", title: "插入打印分页标记" },
  { command: "table", label: "表格", title: "插入表格" },
];

const quickFormattingCommands = new Set<MarkdownFormatCommand>([
  "bold",
  "italic",
  "link",
]);
const quickFormattingActions = formattingActions.filter((action) =>
  quickFormattingCommands.has(action.command),
);
const toolbarFormattingActions = [
  ...quickFormattingActions,
  ...(
    [
      "heading1",
      "heading2",
      "bulletList",
      "orderedList",
      "taskList",
      "blockquote",
      "codeBlock",
      "image",
      "table",
      "inlineCode",
      "strikethrough",
      "heading3",
    ] as const
  ).map((command) => {
    const action = formattingActions.find((item) => item.command === command);
    if (action === undefined)
      throw new Error(`Missing formatting action: ${command}`);
    return action;
  }),
];
const tableActions: readonly {
  readonly command: TableEditCommand;
  readonly label: string;
}[] = [
  { command: "addRowBefore", label: "上方插入行" },
  { command: "addRowAfter", label: "下方插入行" },
  { command: "deleteRow", label: "删除行" },
  { command: "moveRowUp", label: "上移行" },
  { command: "moveRowDown", label: "下移行" },
  { command: "addColumnBefore", label: "左侧插入列" },
  { command: "addColumnAfter", label: "右侧插入列" },
  { command: "deleteColumn", label: "删除列" },
  { command: "moveColumnLeft", label: "左移列" },
  { command: "moveColumnRight", label: "右移列" },
  { command: "alignDefault", label: "默认对齐" },
  { command: "alignLeft", label: "左对齐" },
  { command: "alignCenter", label: "居中对齐" },
  { command: "alignRight", label: "右对齐" },
];

const complexRenderers: ComplexBlockRenderers = {
  katex: async (context) => {
    const { renderKatex } = await import("@mdeditor/renderers/katex");
    if (!context.signal.aborted) renderKatex(context);
  },
  mermaid: async (context) => {
    const { renderMermaid } = await import("@mdeditor/renderers/mermaid");
    if (!context.signal.aborted) await renderMermaid(context);
  },
};

const imageExtensionByMime = new Map([
  ["image/avif", "avif"],
  ["image/gif", "gif"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

function importedImageFileName(file: File, index: number): string {
  const extension =
    imageExtensionByMime.get(file.type.toLocaleLowerCase()) ?? "png";
  const leaf = file.name.split(/[\\/]/u).at(-1) ?? "";
  const stem = leaf
    .replace(/\.[^.]*$/u, "")
    .replace(/[<>:"|?*]/gu, "-")
    .replace(/[. ]+$/u, "")
    .trim();
  const safeStem = Array.from(stem, (character) =>
    (character.codePointAt(0) ?? 0) <= 0x1f ? "-" : character,
  ).join("");
  return `${safeStem || `pasted-image-${index + 1}`}.${extension}`;
}

function isRelativeLocalImageSource(source: string): boolean {
  const candidate = source.trim();
  return (
    candidate !== "" &&
    !candidate.startsWith("#") &&
    !candidate.startsWith("/") &&
    !candidate.startsWith("\\") &&
    !candidate.startsWith("//") &&
    !/^[a-z][a-z0-9+.-]*:/iu.test(candidate)
  );
}

const initialText = `# 欢迎使用 MDEditor

这是正在推进 M4 写作核心与 M5 文件夹工作流的渐进式 Markdown 编辑器。Markdown 文本仍由 CodeMirror 持有，不会复制到 React Store。

- 在源码与混合模式间无损切换
- 在混合模式中隐藏非活动 Markdown 标记，进入结构时恢复源码
- 使用工具栏或快捷键完成可撤销的 Markdown 格式化
- 渐进显示标题、强调、链接、引用、列表、图片与代码
- 点击任务复选框，使用 Tab / Shift+Tab 在 GFM 表格单元格间移动
- 打开文档大纲并点击标题，快速定位到对应源码
- 按需渲染 KaTeX 数学公式与 Mermaid 图表，单个预览失败不会影响源码
- 使用标签页同时编辑多个文档，每个标签保留独立选择和撤销历史
- 切换纸张、深色或跟随系统主题，并按需配置常用快捷键
- 使用专注模式淡化非当前块，或用打字机模式让光标保持在视口中央
- 自动配对 Markdown 标记，并用单个撤销事务包围选区
- 支持撤销与重做
- 支持查找与替换
- 保留 UTF-8、BOM 与换行元数据
- 保存前检查外部文件变化

> 渲染可以失败，但源码必须始终可见、可编辑、可安全保存。`;

const initialDocument: DecodedDocument = {
  text: initialText,
  session: createUntitledSession("welcome"),
};

export interface AppShellProps {
  readonly documentAdapter?: DocumentAdapter;
  readonly confirmAction?: (message: string) => boolean | Promise<boolean>;
  readonly appVersion?: string;
}

function confirmInBrowser(message: string): boolean {
  return window.confirm(message);
}

interface WorkspaceEditor {
  readonly editor: SourceEditor;
  readonly host: HTMLDivElement;
}

function getDocumentName(path: string | null): string {
  if (path === null) return "未命名";
  return path.split(/[\\/]/).at(-1) || path;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathIsWithinWorkspaceEntry(
  path: string,
  root: string,
  relativePath: string,
): boolean {
  const normalize = (value: string) =>
    value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const normalizedRoot = normalize(root);
  const normalizedPath = normalize(path);
  const entryPath = `${normalizedRoot}/${normalize(relativePath).replace(/^\/+/, "")}`;
  const caseInsensitive = /^[a-z]:\//iu.test(normalizedRoot);
  const candidate = caseInsensitive
    ? normalizedPath.toLocaleLowerCase()
    : normalizedPath;
  const entry = caseInsensitive ? entryPath.toLocaleLowerCase() : entryPath;
  return candidate === entry || candidate.startsWith(`${entry}/`);
}

function resolveExportTheme(theme: AppSettings["theme"]): ExportTheme {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "paper";
}

function downloadHtml(html: string, suggestedName: string): void {
  const url = URL.createObjectURL(
    new Blob([html], { type: "text/html;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadPng(bytes: Uint8Array, suggestedName: string): void {
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  const url = URL.createObjectURL(
    new Blob([ownedBytes.buffer], { type: "image/png" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function printHtml(html: string): void {
  const frame = document.createElement("iframe");
  frame.className = "document-print-frame";
  frame.title = "打印文档";
  frame.setAttribute("aria-hidden", "true");
  // `window.print()` is blocked by the sandboxed-modals flag unless the
  // iframe explicitly opts in. Scripts remain disabled, and the exported
  // document also carries a restrictive CSP.
  frame.setAttribute("sandbox", "allow-modals allow-same-origin");
  frame.addEventListener(
    "load",
    () => {
      const printWindow = frame.contentWindow;
      if (printWindow === null) {
        frame.remove();
        return;
      }
      const cleanup = () => frame.remove();
      printWindow.addEventListener("afterprint", cleanup, { once: true });
      window.setTimeout(cleanup, 60_000);
      printWindow.focus();
      printWindow.print();
    },
    { once: true },
  );
  frame.srcdoc = html;
  document.body.append(frame);
}

export function AppShell({
  documentAdapter,
  confirmAction = confirmInBrowser,
  appVersion = "开发版",
}: AppShellProps) {
  const editorHost = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const splitExportRef = useRef<() => Promise<string>>(() =>
    Promise.resolve(""),
  );
  const documentThemeInput = useRef<HTMLInputElement>(null);
  const trustedDocumentCssInput = useRef<HTMLInputElement>(null);
  const editor = useRef<SourceEditor | null>(null);
  const editors = useRef(new Map<string, WorkspaceEditor>());
  const pendingTabFocusId = useRef<string | null>(null);
  const pendingReveal = useRef<{
    readonly documentId: string;
    readonly position?: number;
    readonly fragment?: string;
  } | null>(null);
  const activeWorkspaceSearch = useRef<string | null>(null);
  const linkNavigationBusy = useRef(false);
  const imageImportBusy = useRef(false);
  const activateMarkdownLinkRef = useRef(activateMarkdownLink);
  activateMarkdownLinkRef.current = activateMarkdownLink;
  const resolveWorkspaceImageRef = useRef(resolveWorkspaceImage);
  resolveWorkspaceImageRef.current = resolveWorkspaceImage;
  const importWorkspaceImageFilesRef = useRef(importWorkspaceImageFiles);
  importWorkspaceImageFilesRef.current = importWorkspaceImageFiles;
  const pendingTexts = useRef(
    new Map<string, string>([[initialDocument.session.id, initialText]]),
  );
  const recoveryCheckStarted = useRef(false);
  const startupOpenStarted = useRef(false);
  const acceptExternalDocumentRef = useRef<
    (event: ExternalDocumentEvent) => void
  >(() => {});
  const recoveryWritable = useRef(documentAdapter === undefined);
  const recoveryOperations = useRef<Promise<void>>(Promise.resolve());
  const lastRecoverySignature = useRef<string | null>(null);
  const autoSavePausedDocuments = useRef(new Set<string>());
  const autoSaveInFlight = useRef(false);
  const [workspace, dispatchWorkspace] = useReducer(
    workspaceReducer,
    initialDocument.session,
    createWorkspaceState,
  );
  const workspaceRef = useRef(workspace);
  const [recoveryStatus, setRecoveryStatus] = useState<
    "checking" | "ready" | "unavailable"
  >(() => (documentAdapter === undefined ? "ready" : "checking"));
  const recoveryReady = recoveryStatus !== "checking";
  const [recentDocuments, setRecentDocuments] = useState<readonly string[]>([]);
  const [folderWorkspace, setFolderWorkspace] =
    useState<OpenedWorkspace | null>(null);
  const folderWorkspaceRef = useRef(folderWorkspace);
  const [workspaceSearchAvailable, setWorkspaceSearchAvailable] =
    useState(false);
  const [workspaceSearchState, setWorkspaceSearchState] = useState<{
    readonly phase: WorkspaceSearchPhase;
    readonly matches: readonly WorkspaceSearchMatch[];
    readonly truncated: boolean;
  }>({ phase: "idle", matches: [], truncated: false });
  const folderWorkspaceRoot = folderWorkspace?.root ?? null;
  const [settings, setSettings] = useState(loadAppSettings);
  const [settingsSection, setSettingsSection] = useState<
    "appearance" | "writing" | "shortcuts" | "about"
  >("appearance");
  const [documentStyleLibrary, setDocumentStyleLibrary] = useState(
    loadDocumentStyleLibrary,
  );
  const [trustedCssAcknowledged, setTrustedCssAcknowledged] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>("hybrid");
  const [viewLayout, setViewLayout] = useState<"single" | "split">("single");
  const [splitPreviewHtml, setSplitPreviewHtml] = useState("");
  const [splitPreviewError, setSplitPreviewError] = useState<string | null>(
    null,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [searchOptions, setSearchOptions] = useState({
    caseSensitive: false,
    wholeWord: false,
    regularExpression: false,
  });
  const settingsRef = useRef(settings);
  const editorModeRef = useRef(editorMode);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineItems, setOutlineItems] = useState<readonly OutlineItem[]>([]);
  const [outlineFilter, setOutlineFilter] = useState("");
  const [collapsedOutlineState, setCollapsedOutlineState] = useState<{
    readonly documentId: string;
    readonly items: ReadonlySet<number>;
  }>(() => ({ documentId: initialDocument.session.id, items: new Set() }));
  const [statisticsState, setStatisticsState] = useState<{
    readonly documentId: string;
    readonly statistics: DocumentStatistics;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [toolbarFocusIndex, setToolbarFocusIndex] = useState(0);
  const [visibleToolbarActions, setVisibleToolbarActions] = useState(3);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pandocStatus, setPandocStatus] = useState<PandocStatus | null>(null);
  const activeTab = getActiveWorkspaceTab(workspace);
  const activeDocumentId = activeTab.id;
  const activeTabIndex = workspace.tabs.findIndex(
    ({ id }) => id === activeDocumentId,
  );
  const session = activeTab.session;
  const activeDocumentTheme =
    documentStyleLibrary.themes.find(
      ({ id }) => id === settings.documentThemeId,
    ) ?? null;
  const activeTrustedDocumentCss = settings.trustedDocumentCssEnabled
    ? documentStyleLibrary.trustedCss
    : null;
  const compiledDocumentStyles = useMemo(
    () =>
      [
        activeDocumentTheme === null
          ? ""
          : compileDocumentCss(activeDocumentTheme.css, "editor", "theme"),
        activeTrustedDocumentCss === null
          ? ""
          : compileDocumentCss(
              activeTrustedDocumentCss.css,
              "editor",
              "trusted",
            ),
      ]
        .filter((css) => css !== "")
        .join("\n"),
    [activeDocumentTheme, activeTrustedDocumentCss],
  );
  const toolbarTabStopIndex =
    !recoveryReady || session.readOnly
      ? 0
      : Math.min(toolbarFocusIndex, visibleToolbarActions);
  const visibleFormattingActions = toolbarFormattingActions.slice(
    0,
    visibleToolbarActions,
  );
  const visibleFormattingCommands = new Set(
    visibleFormattingActions.map((action) => action.command),
  );
  const moreFormattingActions = formattingActions.filter(
    (action) => !visibleFormattingCommands.has(action.command),
  );

  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (toolbar === null) return;
    const outlineButton = toolbar.querySelector<HTMLButtonElement>(
      'button[data-toolbar-index="0"]',
    );
    const moreSummary = toolbar.querySelector<HTMLElement>(
      ".format-menu > summary",
    );
    if (outlineButton === null || moreSummary === null) return;
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) return;
    let active = true;

    const measure = () => {
      if (!active) return;
      const toolbarStyle = getComputedStyle(toolbar);
      const buttonStyle = getComputedStyle(outlineButton);
      context.font = buttonStyle.font;
      const gap = Number.parseFloat(toolbarStyle.columnGap) || 0;
      const buttonExtra =
        Number.parseFloat(buttonStyle.paddingLeft) +
        Number.parseFloat(buttonStyle.paddingRight) +
        Number.parseFloat(buttonStyle.borderLeftWidth) +
        Number.parseFloat(buttonStyle.borderRightWidth) +
        4;
      let available =
        toolbar.clientWidth -
        Number.parseFloat(toolbarStyle.paddingLeft) -
        Number.parseFloat(toolbarStyle.paddingRight) -
        outlineButton.getBoundingClientRect().width -
        moreSummary.getBoundingClientRect().width -
        gap * 2;
      let count = 0;
      for (const action of toolbarFormattingActions) {
        const width =
          Math.ceil(context.measureText(action.label).width) +
          buttonExtra +
          gap;
        if (available < width) break;
        available -= width;
        count += 1;
      }
      setVisibleToolbarActions(count);
    };

    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    measure();
    void document.fonts.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const closeMenusOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      document
        .querySelectorAll<HTMLDetailsElement>(
          ".titlebar-actions > details[open], .editor-toolbar > details.format-menu[open]",
        )
        .forEach((menu) => {
          if (!menu.contains(event.target as Node)) menu.open = false;
        });
    };
    document.addEventListener("pointerdown", closeMenusOutside, true);
    return () =>
      document.removeEventListener("pointerdown", closeMenusOutside, true);
  }, []);
  const dirtyTabSignature = workspace.tabs
    .filter(({ session: tabSession }) => isDirty(tabSession))
    .map(({ id, session: tabSession }) => `${id}:${tabSession.currentRevision}`)
    .join("|");

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    folderWorkspaceRef.current = folderWorkspace;
  }, [folderWorkspace]);

  useEffect(() => {
    const pendingId = pendingTabFocusId.current;
    if (pendingId === null) return;
    const index = workspace.tabs.findIndex(({ id }) => id === pendingId);
    if (index < 0) return;
    pendingTabFocusId.current = null;
    window.requestAnimationFrame(() => {
      document.getElementById(`workspace-tab-${index}`)?.focus();
    });
  }, [workspace.tabs]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    editorModeRef.current = editorMode;
  }, [editorMode]);

  useEffect(() => {
    if (documentAdapter === undefined || folderWorkspaceRoot === null) return;

    let disposed = false;
    let refreshing = false;
    let refreshAgain = false;
    let debounceTimer: number | null = null;
    let unsubscribe: (() => void) | null = null;
    const root = folderWorkspaceRoot;
    const adapter = documentAdapter;

    async function refreshFromDisk() {
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      do {
        refreshAgain = false;
        try {
          const refreshed = await adapter.refreshWorkspace(root);
          if (!disposed) {
            setFolderWorkspace((current) =>
              current?.root === root ? refreshed : current,
            );
          }
        } catch (error) {
          if (!disposed) {
            setNotice(`自动刷新工作区失败：${getErrorMessage(error)}`);
          }
        }
      } while (refreshAgain && !disposed);
      refreshing = false;
    }

    void adapter
      .subscribeWorkspaceChanges((event) => {
        if (disposed || event.root !== root) return;
        if (debounceTimer !== null) window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
          debounceTimer = null;
          void refreshFromDisk();
        }, 180);
      })
      .then((stop) => {
        if (disposed) {
          void stop();
        } else {
          unsubscribe = stop;
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setNotice(`监听工作区失败：${getErrorMessage(error)}`);
        }
      });

    return () => {
      disposed = true;
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      if (unsubscribe !== null) void unsubscribe();
    };
  }, [documentAdapter, folderWorkspaceRoot]);

  useEffect(() => {
    if (documentAdapter === undefined) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    const adapter = documentAdapter;

    void adapter
      .subscribeWorkspaceSearch((event: WorkspaceSearchEvent) => {
        if (disposed || event.requestId !== activeWorkspaceSearch.current) {
          return;
        }
        if (event.kind === "batch") {
          setWorkspaceSearchState((current) => ({
            ...current,
            matches: [...current.matches, ...event.matches],
          }));
          return;
        }
        activeWorkspaceSearch.current = null;
        if (event.kind === "complete") {
          setWorkspaceSearchState((current) => ({
            ...current,
            phase: "complete",
            truncated: event.truncated,
          }));
        } else if (event.kind === "cancelled") {
          setWorkspaceSearchState((current) => ({
            ...current,
            phase: "cancelled",
          }));
        } else {
          setWorkspaceSearchState((current) => ({
            ...current,
            phase: "error",
          }));
          setNotice(`全局搜索失败：${event.message}`);
        }
      })
      .then((dispose) => {
        if (disposed) {
          dispose();
        } else {
          unsubscribe = dispose;
          setWorkspaceSearchAvailable(true);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setNotice(`无法监听全局搜索结果：${getErrorMessage(error)}`);
        }
      });

    return () => {
      disposed = true;
      setWorkspaceSearchAvailable(false);
      const requestId = activeWorkspaceSearch.current;
      if (requestId !== null) {
        activeWorkspaceSearch.current = null;
        void adapter.cancelWorkspaceSearch(requestId);
      }
      unsubscribe?.();
    };
  }, [documentAdapter]);

  useEffect(() => {
    const parent = editorHost.current;
    if (!parent || !recoveryReady) return;

    const tab = workspaceRef.current.tabs.find(
      ({ id }) => id === activeDocumentId,
    );
    if (tab === undefined) return;

    for (const workspaceEditor of editors.current.values()) {
      workspaceEditor.host.hidden = true;
    }

    let workspaceEditor = editors.current.get(activeDocumentId);
    if (workspaceEditor === undefined) {
      const documentHost = document.createElement("div");
      documentHost.className = "editor-document-host";
      parent.append(documentHost);
      const pendingText = pendingTexts.current.get(activeDocumentId) ?? "";
      const sourceEditor = createSourceEditor({
        parent: documentHost,
        text: tab.session.readOnly
          ? pendingText
          : normalizeLineEndings(pendingText, "\n"),
        lineSeparator: tab.session.readOnly ? tab.session.lineEnding : "\n",
        readOnly: tab.session.readOnly,
        mode: editorModeRef.current,
        fontSize: settingsRef.current.fontSize,
        lineWrapping: settingsRef.current.lineWrapping,
        focusMode: settingsRef.current.focusMode,
        typewriterMode: settingsRef.current.typewriterMode,
        markdownAutoPair: settingsRef.current.markdownAutoPair,
        spellcheckEnabled: settingsRef.current.spellcheckEnabled,
        spellcheckLanguage: settingsRef.current.spellcheckLanguage,
        complexRenderers,
        onTextChange: (text) => {
          dispatchWorkspace({
            type: "edit",
            id: activeDocumentId,
            text,
          });
        },
        onLinkActivate: (target) => {
          void activateMarkdownLinkRef.current(activeDocumentId, target);
        },
        resolveImageSource: (target) =>
          resolveWorkspaceImageRef.current(activeDocumentId, target),
        onImageFiles: (files) => {
          void importWorkspaceImageFilesRef.current(activeDocumentId, files);
        },
        onSearchRequest: () => setSearchOpen(true),
      });
      workspaceEditor = { editor: sourceEditor, host: documentHost };
      editors.current.set(activeDocumentId, workspaceEditor);
      pendingTexts.current.delete(activeDocumentId);
    } else {
      workspaceEditor.editor.setMode(editorModeRef.current);
      workspaceEditor.editor.setPreferences({
        fontSize: settingsRef.current.fontSize,
        lineWrapping: settingsRef.current.lineWrapping,
        focusMode: settingsRef.current.focusMode,
        typewriterMode: settingsRef.current.typewriterMode,
        markdownAutoPair: settingsRef.current.markdownAutoPair,
        spellcheckEnabled: settingsRef.current.spellcheckEnabled,
        spellcheckLanguage: settingsRef.current.spellcheckLanguage,
      });
    }
    workspaceEditor.host.hidden = false;
    editor.current = workspaceEditor.editor;
    const reveal = pendingReveal.current;
    if (
      reveal?.documentId === activeDocumentId &&
      reveal.position !== undefined
    ) {
      pendingReveal.current = null;
      workspaceEditor.editor.revealPosition(reveal.position);
    } else if (
      reveal?.documentId === activeDocumentId &&
      reveal.fragment !== undefined
    ) {
      pendingReveal.current = null;
      if (!workspaceEditor.editor.revealHeading(reveal.fragment)) {
        setNotice(`目标文档中不存在标题“#${reveal.fragment}”。`);
      }
    } else {
      workspaceEditor.editor.focus();
    }
  }, [activeDocumentId, recoveryReady]);

  useEffect(() => {
    editor.current?.setMode(editorMode);
  }, [activeDocumentId, editorMode, recoveryReady]);

  useEffect(() => {
    if (!searchOpen) return;
    window.requestAnimationFrame(() => searchInput.current?.focus());
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    editor.current?.runSearch(
      searchQuery,
      replacement,
      searchOptions,
      "update",
    );
  }, [activeDocumentId, replacement, searchOpen, searchOptions, searchQuery]);

  useEffect(() => {
    editor.current?.setPreferences({
      fontSize: settings.fontSize,
      lineWrapping: settings.lineWrapping,
      focusMode: settings.focusMode,
      typewriterMode: settings.typewriterMode,
      markdownAutoPair: settings.markdownAutoPair,
      spellcheckEnabled: settings.spellcheckEnabled,
      spellcheckLanguage: settings.spellcheckLanguage,
    });
  }, [
    activeDocumentId,
    recoveryReady,
    settings.fontSize,
    settings.focusMode,
    settings.lineWrapping,
    settings.markdownAutoPair,
    settings.spellcheckEnabled,
    settings.spellcheckLanguage,
    settings.typewriterMode,
  ]);

  useEffect(() => {
    const sourceEditor = editor.current;
    if (!sourceEditor || !outlineOpen) {
      sourceEditor?.setOutlineListener(null);
      setOutlineItems([]);
      setOutlineLoading(false);
      return;
    }

    let active = true;
    setOutlineLoading(true);
    sourceEditor.setOutlineListener((items) => {
      if (!active) return;
      setOutlineItems(items);
      setOutlineLoading(false);
    });

    return () => {
      active = false;
      sourceEditor.setOutlineListener(null);
    };
  }, [activeDocumentId, outlineOpen, recoveryReady]);

  useEffect(() => {
    const sourceEditor = editor.current;
    if (!sourceEditor) return;

    let active = true;
    sourceEditor.setStatisticsListener((nextStatistics) => {
      if (active) {
        setStatisticsState({
          documentId: activeDocumentId,
          statistics: nextStatistics,
        });
      }
    });
    return () => {
      active = false;
      sourceEditor.setStatisticsListener(null);
    };
  }, [activeDocumentId, recoveryReady]);

  function updateSettings(next: AppSettings) {
    saveAppSettings(next);
    setSettings(next);
  }

  function updateShortcut(action: ShortcutAction, shortcut: string) {
    if (hasShortcutConflict(settings.shortcuts, action, shortcut)) {
      setNotice(`快捷键 ${formatShortcut(shortcut)} 已被其他操作使用。`);
      return;
    }
    setNotice(null);
    updateSettings({
      ...settings,
      shortcuts: { ...settings.shortcuts, [action]: shortcut },
    });
  }

  async function installThemeFile(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    try {
      const installed = installDocumentTheme(
        documentStyleLibrary,
        file.name,
        await file.text(),
      );
      saveDocumentStyleLibrary(installed.library);
      setDocumentStyleLibrary(installed.library);
      updateSettings({
        ...settings,
        documentThemeId: installed.theme.id,
      });
      setNotice(`已安装并启用文档主题“${installed.theme.name}”。`);
    } catch (error) {
      setNotice(`安装文档主题失败：${getErrorMessage(error)}`);
    } finally {
      if (documentThemeInput.current !== null) {
        documentThemeInput.current.value = "";
      }
    }
  }

  function deleteActiveDocumentTheme(): void {
    if (activeDocumentTheme === null) return;
    const next = removeDocumentTheme(
      documentStyleLibrary,
      activeDocumentTheme.id,
    );
    try {
      saveDocumentStyleLibrary(next);
      setDocumentStyleLibrary(next);
      updateSettings({ ...settings, documentThemeId: null });
      setNotice(`已移除文档主题“${activeDocumentTheme.name}”。`);
    } catch (error) {
      setNotice(`移除文档主题失败：${getErrorMessage(error)}`);
    }
  }

  async function installTrustedCssFile(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    if (!trustedCssAcknowledged) {
      setNotice("请先确认理解受信 CSS 会改变文档布局。");
      return;
    }
    try {
      const next = installTrustedDocumentCss(
        documentStyleLibrary,
        file.name,
        await file.text(),
      );
      saveDocumentStyleLibrary(next);
      setDocumentStyleLibrary(next);
      updateSettings({ ...settings, trustedDocumentCssEnabled: true });
      setTrustedCssAcknowledged(false);
      setNotice(
        `已加载并启用受信 CSS“${next.trustedCss?.name ?? file.name}”。`,
      );
    } catch (error) {
      setNotice(`加载受信 CSS 失败：${getErrorMessage(error)}`);
    } finally {
      if (trustedDocumentCssInput.current !== null) {
        trustedDocumentCssInput.current.value = "";
      }
    }
  }

  function removeTrustedDocumentCss(): void {
    if (documentStyleLibrary.trustedCss === null) return;
    const next = { ...documentStyleLibrary, trustedCss: null };
    try {
      saveDocumentStyleLibrary(next);
      setDocumentStyleLibrary(next);
      updateSettings({ ...settings, trustedDocumentCssEnabled: false });
      setTrustedCssAcknowledged(false);
      setNotice("已移除受信文档 CSS。");
    } catch (error) {
      setNotice(`移除受信 CSS 失败：${getErrorMessage(error)}`);
    }
  }

  useEffect(() => {
    if (!documentAdapter || recoveryCheckStarted.current) return;
    recoveryCheckStarted.current = true;

    void (async () => {
      try {
        const snapshot = await documentAdapter.loadRecoverySnapshot();
        if (snapshot === null) {
          recoveryWritable.current = true;
          setRecoveryStatus("ready");
          return;
        }

        const sourceNames = snapshot.documents.map(({ session: tabSession }) =>
          getDocumentName(tabSession.path),
        );
        const recoveryDescription =
          sourceNames.length === 1
            ? `“${sourceNames[0]}”`
            : `${sourceNames.length} 个文档`;
        const shouldRestore = await confirmAction(
          `发现 ${snapshot.capturedAt} 自动保存的${recoveryDescription}恢复工作区。是否恢复？`,
        );
        if (!shouldRestore) {
          await documentAdapter.clearRecoverySnapshot();
          recoveryWritable.current = true;
          setRecoveryStatus("ready");
          return;
        }

        // Recovery content deliberately reopens as an untitled draft. Native
        // path authorization is granted only by an explicit file dialog, so a
        // recovered webview cannot silently regain access to an old path.
        const recoveredIds = new Map<string, string>();
        const recovered = snapshot.documents.map((document) => {
          const id = globalThis.crypto.randomUUID();
          recoveredIds.set(document.session.id, id);
          return {
            text: document.text,
            session: {
              ...document.session,
              id,
              path: null,
              diskFingerprint: null,
            },
          } satisfies DecodedDocument;
        });
        for (const workspaceEditor of editors.current.values()) {
          workspaceEditor.editor.destroy();
          workspaceEditor.host.remove();
        }
        editors.current.clear();
        pendingTexts.current.clear();
        for (const document of recovered) {
          pendingTexts.current.set(document.session.id, document.text);
        }
        const restoredActiveId =
          recoveredIds.get(snapshot.activeId) ?? recovered[0]?.session.id;
        if (restoredActiveId === undefined) {
          throw new Error("恢复工作区不包含可打开的文档");
        }
        dispatchWorkspace({
          type: "replaceAll",
          sessions: recovered.map(
            ({ session: recoveredSession }) => recoveredSession,
          ),
          activeId: restoredActiveId,
        });
        setNotice(
          `已恢复${recoveryDescription}的未保存内容。为保护原文件，所有标签均需使用“另存为”确认保存位置。`,
        );
        recoveryWritable.current = true;
        setRecoveryStatus("ready");
      } catch (error) {
        setRecoveryStatus("unavailable");
        setNotice(`读取恢复稿失败：${getErrorMessage(error)}`);
      }
    })();
  }, [confirmAction, documentAdapter]);

  useEffect(() => {
    if (!documentAdapter) return;

    void documentAdapter
      .listRecentDocuments()
      .then(setRecentDocuments)
      .catch((error: unknown) => {
        setNotice(`读取最近文件失败：${getErrorMessage(error)}`);
      });
  }, [documentAdapter]);

  useEffect(() => {
    if (
      !documentAdapter ||
      recoveryStatus !== "ready" ||
      !recoveryWritable.current
    )
      return;

    if (dirtyTabSignature === "") {
      const operation = recoveryOperations.current
        .catch(() => undefined)
        .then(() => documentAdapter.clearRecoverySnapshot())
        .then(() => {
          lastRecoverySignature.current = null;
        });
      recoveryOperations.current = operation;
      void operation.catch((error: unknown) => {
        setNotice(`清理恢复稿失败：${getErrorMessage(error)}`);
      });
      return;
    }

    const saveLatestSnapshot = () => {
      const currentWorkspace = workspaceRef.current;
      const dirtyTabs = currentWorkspace.tabs.filter(
        ({ session: tabSession }) => isDirty(tabSession),
      );
      if (dirtyTabs.length === 0) return;
      const signature = dirtyTabs
        .map(
          ({ id, session: tabSession }) =>
            `${id}:${tabSession.currentRevision}`,
        )
        .join("|");
      if (signature === lastRecoverySignature.current) return;

      const documents = dirtyTabs.map(({ id, session: tabSession }) => ({
        text:
          editors.current.get(id)?.editor.getText() ??
          pendingTexts.current.get(id),
        session: tabSession,
      }));
      if (documents.some(({ text }) => text === undefined)) return;
      const recoveryActiveId = dirtyTabs.some(
        ({ id }) => id === currentWorkspace.activeId,
      )
        ? currentWorkspace.activeId
        : dirtyTabs[0]!.id;
      const snapshot = createWorkspaceRecoverySnapshot(
        documents.map(({ text, session: tabSession }) => ({
          text: text ?? "",
          session: tabSession,
        })),
        recoveryActiveId,
      );
      lastRecoverySignature.current = signature;
      const operation = recoveryOperations.current
        .catch(() => undefined)
        .then(() => documentAdapter.saveRecoverySnapshot(snapshot));
      recoveryOperations.current = operation;
      void operation.catch((error: unknown) => {
        if (lastRecoverySignature.current === signature) {
          lastRecoverySignature.current = null;
        }
        setNotice(`创建恢复稿失败：${getErrorMessage(error)}`);
      });
    };

    const interval = window.setInterval(saveLatestSnapshot, 1000);

    return () => window.clearInterval(interval);
  }, [dirtyTabSignature, documentAdapter, recoveryStatus]);

  useEffect(() => {
    if (!settings.autoSaveEnabled) {
      autoSavePausedDocuments.current.clear();
      return;
    }
    if (
      !documentAdapter ||
      recoveryStatus !== "ready" ||
      busy ||
      dirtyTabSignature === ""
    ) {
      return;
    }
    const adapter = documentAdapter;
    const timer = window.setTimeout(() => {
      if (autoSaveInFlight.current) return;
      const candidates = workspaceRef.current.tabs.filter(
        ({ id, session: tabSession }) =>
          isDirty(tabSession) &&
          !tabSession.readOnly &&
          tabSession.path !== null &&
          tabSession.diskFingerprint !== null &&
          !autoSavePausedDocuments.current.has(id),
      );
      if (candidates.length === 0) return;
      autoSaveInFlight.current = true;
      void (async () => {
        let savedAny = false;
        for (const candidate of candidates) {
          const current = workspaceRef.current.tabs.find(
            ({ id }) => id === candidate.id,
          );
          if (
            current === undefined ||
            !isDirty(current.session) ||
            current.session.readOnly ||
            current.session.path === null ||
            current.session.diskFingerprint === null ||
            autoSavePausedDocuments.current.has(current.id)
          ) {
            continue;
          }
          const text =
            editors.current.get(current.id)?.editor.getText() ??
            pendingTexts.current.get(current.id);
          if (text === undefined) continue;
          const revision = current.session.currentRevision;
          try {
            const saved = await adapter.saveDocument({
              path: current.session.path,
              bytes: encodeDocument(
                normalizeLineEndings(text, current.session.lineEnding),
                current.session,
              ),
              expectedFingerprint: current.session.diskFingerprint,
            });
            dispatchWorkspace({
              type: "save",
              id: current.id,
              path: saved.path,
              diskFingerprint: saved.diskFingerprint,
              revision,
            });
            autoSavePausedDocuments.current.delete(current.id);
            savedAny = true;
          } catch (error) {
            autoSavePausedDocuments.current.add(current.id);
            setNotice(
              `“${getDocumentName(current.session.path)}”自动保存失败，已暂停该标签的自动保存：${getErrorMessage(error)}。请手动保存或另存为解决。`,
            );
          }
        }
        if (savedAny) {
          void adapter
            .listRecentDocuments()
            .then(setRecentDocuments)
            .catch((error: unknown) => {
              setNotice(`刷新最近文件失败：${getErrorMessage(error)}`);
            });
        }
      })().finally(() => {
        autoSaveInFlight.current = false;
      });
    }, settings.autoSaveDelaySeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [
    busy,
    dirtyTabSignature,
    documentAdapter,
    recoveryStatus,
    settings.autoSaveDelaySeconds,
    settings.autoSaveEnabled,
  ]);

  function acceptOpenedDocument(opened: OpenedDocumentFile): DecodedDocument {
    const decoded = decodeDocument(opened.bytes, {
      id: opened.path,
      path: opened.path,
      diskFingerprint: opened.diskFingerprint,
    });
    autoSavePausedDocuments.current.delete(decoded.session.id);
    const openTab = findWorkspaceTabByPath(workspaceRef.current, opened.path);
    if (openTab !== undefined) {
      dispatchWorkspace({ type: "activate", id: openTab.id });
      setNotice("该文件已在标签页中打开");
    } else {
      pendingTexts.current.set(decoded.session.id, decoded.text);
      dispatchWorkspace({ type: "add", session: decoded.session });
    }
    if (decoded.session.readOnly) {
      setNotice(
        "文件包含当前版本不能安全回写的编码或换行符，已用只读模式打开。",
      );
    }
    return decoded;
  }

  acceptExternalDocumentRef.current = (event) => {
    if (event.kind === "error") {
      setNotice(`无法打开“${getDocumentName(event.path)}”：${event.message}`);
      return;
    }
    acceptOpenedDocument(event.document);
    refreshRecentDocuments();
    setNotice(`已打开：${event.document.path}`);
  };

  useEffect(() => {
    if (!documentAdapter || !recoveryReady) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void documentAdapter
      .subscribeExternalDocuments((event) =>
        acceptExternalDocumentRef.current(event),
      )
      .then((stop) => {
        if (disposed) stop();
        else unsubscribe = stop;
      })
      .catch((error: unknown) => {
        setNotice(`无法监听拖入文件：${getErrorMessage(error)}`);
      });
    if (!startupOpenStarted.current) {
      startupOpenStarted.current = true;
      void documentAdapter
        .openStartupDocuments()
        .then((events) => {
          for (const event of events) acceptExternalDocumentRef.current(event);
        })
        .catch((error: unknown) => {
          setNotice(`无法打开启动参数文件：${getErrorMessage(error)}`);
        });
    }
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [documentAdapter, recoveryReady]);

  function refreshRecentDocuments() {
    if (!documentAdapter) return;
    void documentAdapter
      .listRecentDocuments()
      .then(setRecentDocuments)
      .catch((error: unknown) => {
        setNotice(`刷新最近文件失败：${getErrorMessage(error)}`);
      });
  }

  async function openDocument(recentPath?: string) {
    if (!documentAdapter || busy) return;
    const alreadyOpen =
      recentPath === undefined
        ? undefined
        : findWorkspaceTabByPath(workspaceRef.current, recentPath);
    if (alreadyOpen !== undefined) {
      dispatchWorkspace({ type: "activate", id: alreadyOpen.id });
      setNotice("该文件已在标签页中打开");
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      const opened =
        recentPath === undefined
          ? await documentAdapter.openDocument()
          : await documentAdapter.openRecentDocument(recentPath);
      if (opened === null) return;
      acceptOpenedDocument(opened);
      refreshRecentDocuments();
    } catch (error) {
      setNotice(`打开失败：${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function openFolderWorkspace() {
    if (!documentAdapter || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const opened = await documentAdapter.openWorkspace();
      if (opened === null) return;
      cancelFolderSearch();
      setFolderWorkspace(opened);
      setWorkspaceSearchState({
        phase: "idle",
        matches: [],
        truncated: false,
      });
      setNotice(
        `已授权工作区“${opened.name}”，发现 ${opened.entries.length} 个条目。`,
      );
    } catch (error) {
      setNotice(`打开文件夹失败：${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function refreshFolderWorkspace() {
    if (!documentAdapter || folderWorkspace === null || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const refreshed = await documentAdapter.refreshWorkspace(
        folderWorkspace.root,
      );
      setFolderWorkspace(refreshed);
      setNotice(`已刷新工作区，共 ${refreshed.entries.length} 个条目。`);
    } catch (error) {
      setNotice(`刷新工作区失败：${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function closeFolderWorkspace() {
    if (!documentAdapter || folderWorkspace === null || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      cancelFolderSearch();
      await documentAdapter.closeWorkspace(folderWorkspace.root);
      setFolderWorkspace(null);
      setNotice("已关闭文件夹工作区；已打开文档仍可继续编辑和保存。");
    } catch (error) {
      setNotice(`关闭工作区失败：${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function cancelFolderSearch() {
    const requestId = activeWorkspaceSearch.current;
    if (!documentAdapter || requestId === null) return;
    activeWorkspaceSearch.current = null;
    setWorkspaceSearchState((current) => ({
      ...current,
      phase: "cancelled",
    }));
    void documentAdapter.cancelWorkspaceSearch(requestId).catch((error) => {
      setNotice(`取消全局搜索失败：${getErrorMessage(error)}`);
    });
  }

  function startFolderSearch(query: string, options: WorkspaceSearchOptions) {
    if (!documentAdapter || folderWorkspace === null) return;
    cancelFolderSearch();
    const requestId = globalThis.crypto.randomUUID();
    activeWorkspaceSearch.current = requestId;
    setWorkspaceSearchState({
      phase: "searching",
      matches: [],
      truncated: false,
    });
    void documentAdapter
      .startWorkspaceSearch(folderWorkspace.root, requestId, query, options)
      .catch((error: unknown) => {
        if (activeWorkspaceSearch.current !== requestId) return;
        activeWorkspaceSearch.current = null;
        setWorkspaceSearchState({
          phase: "error",
          matches: [],
          truncated: false,
        });
        setNotice(`启动全局搜索失败：${getErrorMessage(error)}`);
      });
  }

  function revealDocumentLocation(
    documentId: string,
    text: string,
    location: { readonly line: number; readonly column: number },
  ) {
    const position = documentPositionFromLineColumn(
      text,
      location.line,
      location.column,
    );
    pendingReveal.current = { documentId, position };
    window.requestAnimationFrame(() => {
      const reveal = pendingReveal.current;
      const target = editors.current.get(documentId)?.editor;
      if (
        reveal?.documentId === documentId &&
        reveal.position !== undefined &&
        target !== undefined
      ) {
        pendingReveal.current = null;
        target.revealPosition(reveal.position);
      }
    });
  }

  function revealDocumentHeading(documentId: string, fragment: string) {
    pendingReveal.current = { documentId, fragment };
    window.requestAnimationFrame(() => {
      const reveal = pendingReveal.current;
      const target = editors.current.get(documentId)?.editor;
      if (
        reveal?.documentId === documentId &&
        reveal.fragment !== undefined &&
        target !== undefined
      ) {
        pendingReveal.current = null;
        if (!target.revealHeading(reveal.fragment)) {
          setNotice(`目标文档中不存在标题“#${reveal.fragment}”。`);
        }
      }
    });
  }

  async function activateMarkdownLink(documentId: string, target: string) {
    if (linkNavigationBusy.current) return;
    const sourceTab = workspaceRef.current.tabs.find(
      (candidate) => candidate.id === documentId,
    );
    if (sourceTab === undefined) return;
    if (target.startsWith("#")) {
      const activated = editors.current
        .get(documentId)
        ?.editor.revealHeading(target.slice(1));
      setNotice(
        activated
          ? `已定位到当前文档标题“${target}”。`
          : `当前文档中不存在标题“${target}”。`,
      );
      return;
    }

    const protocol = /^([a-z][a-z0-9+.-]*):/iu.exec(target)?.[1]?.toLowerCase();
    if (protocol !== undefined) {
      if (!["http", "https", "mailto"].includes(protocol)) {
        setNotice(`已阻止不受支持的链接协议“${protocol}:”。`);
        return;
      }
      if (!documentAdapter) {
        setNotice("当前环境不能调用系统默认应用打开外部链接。");
        return;
      }
      linkNavigationBusy.current = true;
      try {
        await documentAdapter.openExternalUrl(target);
        setNotice("已交给系统默认应用打开外部链接。");
      } catch (error) {
        setNotice(`打开外部链接失败：${getErrorMessage(error)}`);
      } finally {
        linkNavigationBusy.current = false;
      }
      return;
    }

    const currentFolder = folderWorkspaceRef.current;
    if (
      !documentAdapter ||
      currentFolder === null ||
      sourceTab.session.path === null
    ) {
      setNotice("本地链接只能从当前已授权工作区中的文档打开。");
      return;
    }
    const sourcePath = sourceTab.session.path;
    const sourceEntry = currentFolder.entries.find(
      (entry) =>
        entry.kind === "file" &&
        pathIsWithinWorkspaceEntry(
          sourcePath,
          currentFolder.root,
          entry.relativePath,
        ),
    );
    if (sourceEntry === undefined) {
      setNotice("当前文档不属于已授权工作区，无法解析本地链接。");
      return;
    }

    linkNavigationBusy.current = true;
    try {
      const opened = await documentAdapter.openWorkspaceLink(
        currentFolder.root,
        sourceEntry.relativePath,
        target,
      );
      const decoded = acceptOpenedDocument(opened.document);
      if (opened.fragment !== null && opened.fragment !== "") {
        revealDocumentHeading(decoded.session.id, opened.fragment);
      }
      refreshRecentDocuments();
      setNotice(`已打开链接文档：${opened.relativePath}`);
    } catch (error) {
      setNotice(`打开本地链接失败：${getErrorMessage(error)}`);
    } finally {
      linkNavigationBusy.current = false;
    }
  }

  async function resolveWorkspaceImage(
    documentId: string,
    target: string,
  ): Promise<string | null> {
    const sourceTab = workspaceRef.current.tabs.find(
      (candidate) => candidate.id === documentId,
    );
    const currentFolder = folderWorkspaceRef.current;
    if (
      !documentAdapter ||
      currentFolder === null ||
      sourceTab === undefined ||
      sourceTab.session.path === null
    ) {
      return null;
    }
    const sourcePath = sourceTab.session.path;
    const sourceEntry = currentFolder.entries.find(
      (entry) =>
        entry.kind === "file" &&
        pathIsWithinWorkspaceEntry(
          sourcePath,
          currentFolder.root,
          entry.relativePath,
        ),
    );
    if (sourceEntry === undefined) return null;
    return documentAdapter.readWorkspaceImage(
      currentFolder.root,
      sourceEntry.relativePath,
      target,
    );
  }

  async function openFolderDocument(
    entry: WorkspaceEntry,
    location?: { readonly line: number; readonly column: number },
  ) {
    if (
      !documentAdapter ||
      folderWorkspace === null ||
      entry.kind !== "file" ||
      busy
    )
      return;
    setBusy(true);
    setNotice(null);
    try {
      const opened = await documentAdapter.openWorkspaceDocument(
        folderWorkspace.root,
        entry.relativePath,
      );
      const decoded = acceptOpenedDocument(opened);
      if (location !== undefined) {
        revealDocumentLocation(decoded.session.id, decoded.text, location);
      }
      refreshRecentDocuments();
    } catch (error) {
      setNotice(`打开工作区文件失败：${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function openFolderSearchMatch(match: WorkspaceSearchMatch) {
    if (folderWorkspace === null) return;
    const entry = folderWorkspace.entries.find(
      (candidate) =>
        candidate.kind === "file" &&
        candidate.relativePath === match.relativePath,
    );
    if (entry === undefined) {
      setNotice("搜索结果对应的文件已不存在，请重新搜索。");
      return;
    }
    const openTab = workspaceRef.current.tabs.find(
      ({ session: tabSession }) =>
        tabSession.path !== null &&
        pathIsWithinWorkspaceEntry(
          tabSession.path,
          folderWorkspace.root,
          match.relativePath,
        ),
    );
    if (openTab !== undefined) {
      const text =
        editors.current.get(openTab.id)?.editor.getText() ??
        pendingTexts.current.get(openTab.id) ??
        "";
      dispatchWorkspace({ type: "activate", id: openTab.id });
      revealDocumentLocation(openTab.id, text, match);
      setNotice(
        isDirty(openTab.session)
          ? "搜索结果来自磁盘版本；当前标签有未保存修改，已按原行列定位。"
          : null,
      );
      return;
    }
    void openFolderDocument(entry, {
      line: match.line,
      column: match.column,
    });
  }

  async function createFolderDocument(relativePath: string): Promise<boolean> {
    if (!documentAdapter || folderWorkspace === null || busy) return false;
    setBusy(true);
    setNotice(null);
    try {
      const opened = await documentAdapter.createWorkspaceFile(
        folderWorkspace.root,
        relativePath,
      );
      acceptOpenedDocument(opened);
      const refreshed = await documentAdapter.refreshWorkspace(
        folderWorkspace.root,
      );
      setFolderWorkspace(refreshed);
      refreshRecentDocuments();
      setNotice(`已新建 Markdown 文档：${relativePath}`);
      return true;
    } catch (error) {
      setNotice(`新建文档失败：${getErrorMessage(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createFolderDirectory(relativePath: string): Promise<boolean> {
    if (!documentAdapter || folderWorkspace === null || busy) return false;
    setBusy(true);
    setNotice(null);
    try {
      await documentAdapter.createWorkspaceDirectory(
        folderWorkspace.root,
        relativePath,
      );
      const refreshed = await documentAdapter.refreshWorkspace(
        folderWorkspace.root,
      );
      setFolderWorkspace(refreshed);
      setNotice(`已新建文件夹：${relativePath}`);
      return true;
    } catch (error) {
      setNotice(`新建文件夹失败：${getErrorMessage(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function importFolderImage(): Promise<boolean> {
    if (
      !documentAdapter ||
      folderWorkspace === null ||
      busy ||
      session.path === null ||
      session.readOnly
    ) {
      setNotice("请先在当前工作区打开一个可编辑的 Markdown 文档。");
      return false;
    }
    const sourcePath = session.path;
    const sourceEntry = folderWorkspace.entries.find(
      (entry) =>
        entry.kind === "file" &&
        pathIsWithinWorkspaceEntry(
          sourcePath,
          folderWorkspace.root,
          entry.relativePath,
        ),
    );
    const sourceEditor = editors.current.get(activeDocumentId)?.editor;
    if (sourceEntry === undefined || sourceEditor === undefined) {
      setNotice("当前文档不属于已授权工作区，无法导入图片。");
      return false;
    }
    setBusy(true);
    setNotice(null);
    try {
      const imported = await documentAdapter.importWorkspaceImage(
        folderWorkspace.root,
        sourceEntry.relativePath,
      );
      if (imported === null) {
        setNotice("已取消导入图片。");
        return false;
      }
      if (
        !sourceEditor.insertImageReference(
          imported.markdownPath,
          imported.suggestedAlt,
        )
      ) {
        throw new Error("无法在当前只读文档中插入图片引用");
      }
      const refreshed = await documentAdapter.refreshWorkspace(
        folderWorkspace.root,
      );
      setFolderWorkspace(refreshed);
      setNotice(`已导入图片：${imported.relativePath}`);
      return true;
    } catch (error) {
      setNotice(`导入图片失败：${getErrorMessage(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function importWorkspaceImageFiles(
    documentId: string,
    files: readonly File[],
  ): Promise<void> {
    if (imageImportBusy.current || files.length === 0) return;
    const sourceTab = workspaceRef.current.tabs.find(
      (candidate) => candidate.id === documentId,
    );
    const currentFolder = folderWorkspaceRef.current;
    if (
      !documentAdapter ||
      currentFolder === null ||
      sourceTab === undefined ||
      sourceTab.session.path === null ||
      sourceTab.session.readOnly
    ) {
      setNotice("剪贴板和拖放图片只能导入当前已授权工作区的可编辑文档。");
      return;
    }
    const sourcePath = sourceTab.session.path;
    const sourceEntry = currentFolder.entries.find(
      (entry) =>
        entry.kind === "file" &&
        pathIsWithinWorkspaceEntry(
          sourcePath,
          currentFolder.root,
          entry.relativePath,
        ),
    );
    const sourceEditor = editors.current.get(documentId)?.editor;
    if (sourceEntry === undefined || sourceEditor === undefined) {
      setNotice("当前文档不属于已授权工作区，无法导入图片。");
      return;
    }

    imageImportBusy.current = true;
    setBusy(true);
    setNotice(null);
    let importedCount = 0;
    try {
      for (const [index, file] of files.entries()) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const imported = await documentAdapter.importWorkspaceImageData(
          currentFolder.root,
          sourceEntry.relativePath,
          importedImageFileName(file, index),
          bytes,
        );
        if (
          !sourceEditor.insertImageReference(
            imported.markdownPath,
            imported.suggestedAlt,
          )
        ) {
          throw new Error("无法在当前文档中插入图片引用");
        }
        importedCount += 1;
      }
      const refreshed = await documentAdapter.refreshWorkspace(
        currentFolder.root,
      );
      setFolderWorkspace(refreshed);
      setNotice(`已导入 ${importedCount} 张图片。`);
    } catch (error) {
      if (importedCount > 0) {
        try {
          const refreshed = await documentAdapter.refreshWorkspace(
            currentFolder.root,
          );
          setFolderWorkspace(refreshed);
        } catch {
          // Preserve the primary import error; the watcher can still refresh.
        }
      }
      setNotice(
        `${importedCount > 0 ? `已导入 ${importedCount} 张；` : ""}图片导入失败：${getErrorMessage(error)}`,
      );
    } finally {
      imageImportBusy.current = false;
      setBusy(false);
    }
  }

  async function inspectFolderImages(): Promise<WorkspaceImageInspection | null> {
    if (!documentAdapter || folderWorkspace === null || busy) return null;
    setBusy(true);
    setNotice(null);
    try {
      const inspection = await documentAdapter.inspectWorkspaceImages(
        folderWorkspace.root,
      );
      setNotice(
        inspection.issues.length === 0
          ? "未发现失效或不可预览的本地图片引用。"
          : `发现 ${inspection.issues.length} 个图片引用问题。`,
      );
      return inspection;
    } catch (error) {
      setNotice(`检查图片引用失败：${getErrorMessage(error)}`);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function openFolderImageIssue(issue: WorkspaceImageIssue) {
    if (folderWorkspace === null) return;
    const entry = folderWorkspace.entries.find(
      (candidate) =>
        candidate.kind === "file" &&
        candidate.relativePath === issue.documentRelativePath,
    );
    if (entry === undefined) {
      setNotice("图片引用所在文档已不存在，请重新检查。");
      return;
    }
    void openFolderDocument(entry, {
      line: issue.line,
      column: issue.column,
    });
  }

  function entryHasDirtyDocument(entry: WorkspaceEntry): boolean {
    if (folderWorkspace === null) return false;
    return workspaceRef.current.tabs.some(
      ({ session: tabSession }) =>
        tabSession.path !== null &&
        isDirty(tabSession) &&
        pathIsWithinWorkspaceEntry(
          tabSession.path,
          folderWorkspace.root,
          entry.relativePath,
        ),
    );
  }

  function entryHasOpenDocument(entry: WorkspaceEntry): boolean {
    if (folderWorkspace === null) return false;
    return workspaceRef.current.tabs.some(
      ({ session: tabSession }) =>
        tabSession.path !== null &&
        pathIsWithinWorkspaceEntry(
          tabSession.path,
          folderWorkspace.root,
          entry.relativePath,
        ),
    );
  }

  async function moveFolderEntry(
    entry: WorkspaceEntry,
    destinationRelativePath: string,
  ): Promise<boolean> {
    if (!documentAdapter || folderWorkspace === null || busy) return false;
    const sourceRelativePath = entry.relativePath;
    if (entryHasDirtyDocument(entry)) {
      setNotice("该条目包含未保存的已打开文档；请先保存，再移动或重命名。");
      return false;
    }
    setBusy(true);
    setNotice(null);
    try {
      let relocations: readonly {
        readonly fromPath: string;
        readonly toPath: string;
      }[] = [];
      let updatedReferenceCount = 0;
      let updatedReferenceKind = "";
      if (isWorkspaceImageEntry(entry)) {
        const preview = await documentAdapter.previewWorkspaceImageMove(
          folderWorkspace.root,
          sourceRelativePath,
          destinationRelativePath,
        );
        if (preview.truncated) {
          setNotice("图片引用预览达到安全上限；未移动图片，也未改写任何文档。");
          return false;
        }
        const openReference = preview.updates.find((update) =>
          workspaceRef.current.tabs.some(
            ({ session: tabSession }) =>
              tabSession.path !== null &&
              pathIsWithinWorkspaceEntry(
                tabSession.path,
                folderWorkspace.root,
                update.documentRelativePath,
              ),
          ),
        );
        if (openReference !== undefined) {
          setNotice(
            `引用文档“${openReference.documentRelativePath}”仍在标签页中打开；请先关闭后再移动图片。`,
          );
          return false;
        }
        if (preview.updates.length > 0) {
          const documentCount = new Set(
            preview.updates.map((update) => update.documentRelativePath),
          ).size;
          const examples = preview.updates
            .slice(0, 5)
            .map(
              (update) =>
                `${update.documentRelativePath}:${update.line}:${update.column}\n${update.fromTarget} → ${update.toTarget}`,
            )
            .join("\n\n");
          const remainder = preview.updates.length - 5;
          const shouldRewrite = await confirmAction(
            `移动图片将更新 ${documentCount} 个文档中的 ${preview.updates.length} 个引用：\n\n${examples}${remainder > 0 ? `\n\n另有 ${remainder} 个引用…` : ""}\n\n确定继续吗？`,
          );
          if (!shouldRewrite) return false;
        }
        const updatedDocuments =
          await documentAdapter.moveWorkspaceImageWithReferences(
            folderWorkspace.root,
            sourceRelativePath,
            destinationRelativePath,
          );
        updatedReferenceCount = preview.updates.length;
        updatedReferenceKind = "图片引用";
        if (updatedDocuments.length > 0) refreshRecentDocuments();
      } else if (
        isWorkspaceMarkdownEntry(entry) ||
        entry.kind === "directory"
      ) {
        const preview = await documentAdapter.previewWorkspaceDocumentMove(
          folderWorkspace.root,
          sourceRelativePath,
          destinationRelativePath,
        );
        if (preview.truncated) {
          setNotice("文档链接更新预览达到安全上限；未移动或改写任何文档。");
          return false;
        }
        if (preview.updates.length === 0) {
          relocations = await documentAdapter.moveWorkspaceEntry(
            folderWorkspace.root,
            sourceRelativePath,
            destinationRelativePath,
          );
        } else if (entryHasOpenDocument(entry)) {
          setNotice(
            `该移动需要更新链接；请先关闭待移动${entry.kind === "directory" ? "目录内" : "的"}的 Markdown 文档。`,
          );
          return false;
        }
        const openAffectedDocument = preview.updates.find((update) =>
          workspaceRef.current.tabs.some(
            ({ session: tabSession }) =>
              tabSession.path !== null &&
              pathIsWithinWorkspaceEntry(
                tabSession.path,
                folderWorkspace.root,
                update.documentRelativePath,
              ),
          ),
        );
        if (openAffectedDocument !== undefined) {
          setNotice(
            `受影响文档“${openAffectedDocument.documentRelativePath}”仍在标签页中打开；请先关闭后再移动。`,
          );
          return false;
        }
        if (preview.updates.length > 0) {
          const documentCount = new Set(
            preview.updates.map((update) => update.documentRelativePath),
          ).size;
          const examples = preview.updates
            .slice(0, 5)
            .map(
              (update) =>
                `${update.documentRelativePath}:${update.line}:${update.column}\n${update.fromTarget} → ${update.toTarget}`,
            )
            .join("\n\n");
          const remainder = preview.updates.length - 5;
          const shouldRewrite = await confirmAction(
            `移动${entry.kind === "directory" ? "目录" : "文档"}将更新 ${documentCount} 个文档中的 ${preview.updates.length} 个链接：\n\n${examples}${remainder > 0 ? `\n\n另有 ${remainder} 个链接…` : ""}\n\n确定继续吗？`,
          );
          if (!shouldRewrite) return false;
        }
        if (preview.updates.length > 0) {
          await documentAdapter.moveWorkspaceDocumentWithLinks(
            folderWorkspace.root,
            sourceRelativePath,
            destinationRelativePath,
          );
        }
        updatedReferenceCount = preview.updates.length;
        updatedReferenceKind = "文档链接";
      } else {
        relocations = await documentAdapter.moveWorkspaceEntry(
          folderWorkspace.root,
          sourceRelativePath,
          destinationRelativePath,
        );
      }
      if (relocations.length > 0) {
        dispatchWorkspace({ type: "relocate", relocations });
      }
      const refreshed = await documentAdapter.refreshWorkspace(
        folderWorkspace.root,
      );
      setFolderWorkspace(refreshed);
      refreshRecentDocuments();
      setNotice(
        updatedReferenceCount === 0
          ? `已移动“${sourceRelativePath}”到“${destinationRelativePath}”。`
          : `已移动“${sourceRelativePath}”到“${destinationRelativePath}”，并更新 ${updatedReferenceCount} 个${updatedReferenceKind}。`,
      );
      return true;
    } catch (error) {
      setNotice(`移动工作区条目失败：${getErrorMessage(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function copyFolderEntry(
    entry: WorkspaceEntry,
    destinationRelativePath: string,
  ): Promise<boolean> {
    if (!documentAdapter || folderWorkspace === null || busy) return false;
    if (entryHasDirtyDocument(entry)) {
      setNotice("该条目包含未保存的已打开文档；请先保存，再复制磁盘版本。");
      return false;
    }
    setBusy(true);
    setNotice(null);
    try {
      await documentAdapter.copyWorkspaceEntry(
        folderWorkspace.root,
        entry.relativePath,
        destinationRelativePath,
      );
      const refreshed = await documentAdapter.refreshWorkspace(
        folderWorkspace.root,
      );
      setFolderWorkspace(refreshed);
      setNotice(
        `已复制“${entry.relativePath}”到“${destinationRelativePath}”。`,
      );
      return true;
    } catch (error) {
      setNotice(`复制工作区条目失败：${getErrorMessage(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function copyFolderImageWithReferences(
    entry: WorkspaceEntry,
    destinationRelativePath: string,
  ): Promise<boolean> {
    if (
      !documentAdapter ||
      folderWorkspace === null ||
      busy ||
      !isWorkspaceImageEntry(entry)
    ) {
      return false;
    }
    if (
      workspaceRef.current.tabs.some(({ session: tabSession }) => {
        const tabPath = tabSession.path;
        return (
          tabPath !== null &&
          isDirty(tabSession) &&
          folderWorkspace.entries.some(
            (candidate) =>
              candidate.kind === "file" &&
              pathIsWithinWorkspaceEntry(
                tabPath,
                folderWorkspace.root,
                candidate.relativePath,
              ),
          )
        );
      })
    ) {
      setNotice("工作区仍有未保存文档；请先保存，以便准确切换图片引用。");
      return false;
    }
    const sourceRelativePath = entry.relativePath;
    setBusy(true);
    setNotice(null);
    try {
      const preview = await documentAdapter.previewWorkspaceImageMove(
        folderWorkspace.root,
        sourceRelativePath,
        destinationRelativePath,
      );
      if (preview.truncated) {
        setNotice("图片引用预览达到安全上限；未复制图片，也未改写任何文档。");
        return false;
      }
      const openReference = preview.updates.find((update) =>
        workspaceRef.current.tabs.some(
          ({ session: tabSession }) =>
            tabSession.path !== null &&
            pathIsWithinWorkspaceEntry(
              tabSession.path,
              folderWorkspace.root,
              update.documentRelativePath,
            ),
        ),
      );
      if (openReference !== undefined) {
        setNotice(
          `引用文档“${openReference.documentRelativePath}”仍在标签页中打开；请先关闭后再复制图片并切换引用。`,
        );
        return false;
      }
      const documentCount = new Set(
        preview.updates.map((update) => update.documentRelativePath),
      ).size;
      const examples = preview.updates
        .slice(0, 5)
        .map(
          (update) =>
            `${update.documentRelativePath}:${update.line}:${update.column}\n${update.fromTarget} → ${update.toTarget}`,
        )
        .join("\n\n");
      const remainder = preview.updates.length - 5;
      const shouldRewrite = await confirmAction(
        preview.updates.length === 0
          ? "当前没有引用指向该图片。仍要创建图片副本吗？"
          : `复制图片将切换 ${documentCount} 个文档中的 ${preview.updates.length} 个引用：\n\n${examples}${remainder > 0 ? `\n\n另有 ${remainder} 个引用…` : ""}\n\n原图片会保留，确定继续吗？`,
      );
      if (!shouldRewrite) return false;
      await documentAdapter.copyWorkspaceImageWithReferences(
        folderWorkspace.root,
        sourceRelativePath,
        destinationRelativePath,
      );
      const refreshed = await documentAdapter.refreshWorkspace(
        folderWorkspace.root,
      );
      setFolderWorkspace(refreshed);
      refreshRecentDocuments();
      setNotice(
        `已复制“${sourceRelativePath}”到“${destinationRelativePath}”，并切换 ${preview.updates.length} 个图片引用。`,
      );
      return true;
    } catch (error) {
      setNotice(`复制图片并切换引用失败：${getErrorMessage(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function consolidateFolderImages(
    destinationRelativePath: string,
  ): Promise<boolean> {
    if (!documentAdapter || folderWorkspace === null || busy) return false;
    if (
      workspaceRef.current.tabs.some(({ session: tabSession }) => {
        const tabPath = tabSession.path;
        return (
          tabPath !== null &&
          isDirty(tabSession) &&
          folderWorkspace.entries.some(
            (candidate) =>
              candidate.kind === "file" &&
              pathIsWithinWorkspaceEntry(
                tabPath,
                folderWorkspace.root,
                candidate.relativePath,
              ),
          )
        );
      })
    ) {
      setNotice("工作区仍有未保存文档；请先保存，以便准确归拢图片引用。");
      return false;
    }
    setBusy(true);
    setNotice(null);
    try {
      const preview = await documentAdapter.previewWorkspaceImageConsolidation(
        folderWorkspace.root,
        destinationRelativePath,
      );
      if (preview.truncated) {
        setNotice("图片归拢预览达到安全上限；未复制图片，也未改写任何文档。");
        return false;
      }
      if (preview.copies.length === 0) {
        setNotice(`所有本地引用图片都已位于“${destinationRelativePath}”中。`);
        return true;
      }
      const openReference = preview.updates.find((update) =>
        workspaceRef.current.tabs.some(
          ({ session: tabSession }) =>
            tabSession.path !== null &&
            pathIsWithinWorkspaceEntry(
              tabSession.path,
              folderWorkspace.root,
              update.documentRelativePath,
            ),
        ),
      );
      if (openReference !== undefined) {
        setNotice(
          `引用文档“${openReference.documentRelativePath}”仍在标签页中打开；请先关闭后再归拢图片。`,
        );
        return false;
      }
      const examples = preview.copies
        .slice(0, 5)
        .map(
          (copy) =>
            `${copy.sourceRelativePath} → ${copy.destinationRelativePath}（${copy.referenceCount} 处引用）`,
        )
        .join("\n");
      const remainder = preview.copies.length - 5;
      const documentCount = new Set(
        preview.updates.map((update) => update.documentRelativePath),
      ).size;
      const confirmed = await confirmAction(
        `将复制 ${preview.copies.length} 张图片到“${destinationRelativePath}”，并切换 ${documentCount} 个文档中的 ${preview.updates.length} 个引用：\n\n${examples}${remainder > 0 ? `\n另有 ${remainder} 张图片…` : ""}\n\n原图片会保留，确定继续吗？`,
      );
      if (!confirmed) return false;
      await documentAdapter.consolidateWorkspaceImages(
        folderWorkspace.root,
        destinationRelativePath,
        preview,
      );
      const refreshed = await documentAdapter.refreshWorkspace(
        folderWorkspace.root,
      );
      setFolderWorkspace(refreshed);
      refreshRecentDocuments();
      setNotice(
        `已归拢 ${preview.copies.length} 张图片，并切换 ${preview.updates.length} 个引用。`,
      );
      return true;
    } catch (error) {
      setNotice(`归拢工作区图片失败：${getErrorMessage(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function deleteFolderEntry(entry: WorkspaceEntry): Promise<boolean> {
    if (!documentAdapter || folderWorkspace === null || busy) return false;
    if (entryHasOpenDocument(entry)) {
      setNotice("该条目仍在标签页中打开；请先关闭相关文档。");
      return false;
    }
    if (
      isWorkspaceImageEntry(entry) &&
      workspaceRef.current.tabs.some(({ session: tabSession }) => {
        const tabPath = tabSession.path;
        return (
          tabPath !== null &&
          isDirty(tabSession) &&
          folderWorkspace.entries.some(
            (candidate) =>
              candidate.kind === "file" &&
              pathIsWithinWorkspaceEntry(
                tabPath,
                folderWorkspace.root,
                candidate.relativePath,
              ),
          )
        );
      })
    ) {
      setNotice("工作区仍有未保存文档；请先保存，以便准确扫描其中的图片引用。");
      return false;
    }
    let imageReferences: Awaited<
      ReturnType<DocumentAdapter["inspectWorkspaceImageReferences"]>
    >["references"] = [];
    if (isWorkspaceImageEntry(entry)) {
      setBusy(true);
      setNotice(null);
      try {
        const inspection =
          await documentAdapter.inspectWorkspaceImageReferences(
            folderWorkspace.root,
            entry.relativePath,
          );
        if (inspection.truncated) {
          setNotice("图片引用扫描达到安全上限；未删除图片。");
          return false;
        }
        imageReferences = inspection.references;
      } catch (error) {
        setNotice(`扫描图片引用失败：${getErrorMessage(error)}`);
        return false;
      } finally {
        setBusy(false);
      }
    }
    try {
      const referencePreview = imageReferences
        .slice(0, 5)
        .map(
          (reference) =>
            `${reference.documentRelativePath}:${reference.line}:${reference.column}\n${reference.target}`,
        )
        .join("\n\n");
      const remainder = imageReferences.length - 5;
      const shouldDelete = await confirmAction(
        imageReferences.length === 0
          ? `确定要将“${entry.relativePath}”移到系统回收站吗？可以从回收站恢复。`
          : `“${entry.relativePath}”仍被 ${imageReferences.length} 处引用。删除后这些 Markdown 引用会失效：\n\n${referencePreview}${remainder > 0 ? `\n\n另有 ${remainder} 处引用…` : ""}\n\n确定仍要移到系统回收站吗？`,
      );
      if (!shouldDelete) return false;
    } catch (error) {
      setNotice(`无法显示删除确认：${getErrorMessage(error)}`);
      return false;
    }
    setBusy(true);
    setNotice(null);
    try {
      if (isWorkspaceImageEntry(entry)) {
        await documentAdapter.deleteWorkspaceImage(
          folderWorkspace.root,
          entry.relativePath,
          imageReferences,
        );
      } else {
        await documentAdapter.deleteWorkspaceEntry(
          folderWorkspace.root,
          entry.relativePath,
        );
      }
      const refreshed = await documentAdapter.refreshWorkspace(
        folderWorkspace.root,
      );
      setFolderWorkspace(refreshed);
      refreshRecentDocuments();
      setNotice(`已将“${entry.relativePath}”移到系统回收站。`);
      return true;
    } catch (error) {
      setNotice(`删除工作区条目失败：${getErrorMessage(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function newDocument() {
    const document: DecodedDocument = {
      text: "",
      session: createUntitledSession(globalThis.crypto.randomUUID()),
    };
    pendingTexts.current.set(document.session.id, document.text);
    dispatchWorkspace({ type: "add", session: document.session });
    setNotice(null);
  }

  async function closeDocument(id: string) {
    if (busy) return;
    const currentWorkspace = workspaceRef.current;
    const tab = currentWorkspace.tabs.find((candidate) => candidate.id === id);
    if (tab === undefined) return;
    if (isDirty(tab.session)) {
      try {
        const shouldClose = await confirmAction(
          `“${getDocumentName(tab.session.path)}”尚未保存。确定要关闭并放弃更改吗？`,
        );
        if (!shouldClose) return;
      } catch (error) {
        setNotice(`无法显示关闭确认：${getErrorMessage(error)}`);
        return;
      }
    }

    const closingEditor = editors.current.get(id);
    closingEditor?.editor.destroy();
    closingEditor?.host.remove();
    if (editor.current === closingEditor?.editor) editor.current = null;
    editors.current.delete(id);
    pendingTexts.current.delete(id);
    lastRecoverySignature.current = null;

    if (currentWorkspace.tabs.length === 1) {
      const replacement = createUntitledSession(globalThis.crypto.randomUUID());
      pendingTexts.current.set(replacement.id, "");
      pendingTabFocusId.current = replacement.id;
      dispatchWorkspace({ type: "replace", session: replacement });
    } else {
      const remainingTabs = currentWorkspace.tabs.filter(
        (candidate) => candidate.id !== id,
      );
      pendingTabFocusId.current =
        currentWorkspace.activeId === id
          ? (remainingTabs[
              Math.min(
                currentWorkspace.tabs.findIndex(
                  (candidate) => candidate.id === id,
                ),
                remainingTabs.length - 1,
              )
            ]?.id ?? null)
          : currentWorkspace.activeId;
      dispatchWorkspace({ type: "close", id });
    }
    if (documentAdapter && tab.session.path !== null) {
      try {
        await documentAdapter.releaseDocumentAuthorization(tab.session.path);
      } catch (error) {
        setNotice(
          `关闭了标签页，但释放文件授权失败：${getErrorMessage(error)}`,
        );
        return;
      }
    }
    setNotice(null);
  }

  function activateTabAt(index: number) {
    const tab = workspaceRef.current.tabs[index];
    if (tab === undefined || busy) return;
    dispatchWorkspace({ type: "activate", id: tab.id });
    window.requestAnimationFrame(() => {
      document.getElementById(`workspace-tab-${index}`)?.focus();
    });
  }

  function handleTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + workspace.tabs.length) % workspace.tabs.length;
    } else if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % workspace.tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = workspace.tabs.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    activateTabAt(nextIndex);
  }

  function handleToolbarKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "button[data-toolbar-index]:not(:disabled)",
      ),
    );
    if (buttons.length === 0) return;
    const currentIndex = buttons.findIndex((button) => button === event.target);
    if (currentIndex < 0) return;

    let nextIndex: number;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = buttons.length - 1;
    else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
    } else {
      nextIndex = (currentIndex + 1) % buttons.length;
    }
    event.preventDefault();
    const button = buttons[nextIndex];
    if (button === undefined) return;
    const toolbarIndex = Number(button.dataset.toolbarIndex);
    if (Number.isInteger(toolbarIndex)) setToolbarFocusIndex(toolbarIndex);
    button.focus();
  }

  function handleDisclosureKeyDown(
    event: ReactKeyboardEvent<HTMLDetailsElement>,
  ) {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.open = false;
    event.currentTarget.querySelector("summary")?.focus();
  }

  function handleTopMenuToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (!event.currentTarget.open) return;
    const current = event.currentTarget;
    document
      .querySelectorAll<HTMLDetailsElement>(".titlebar-actions > details[open]")
      .forEach((menu) => {
        if (menu !== current) menu.open = false;
      });
  }

  async function saveDocument(saveAs = false) {
    const sourceEditor = editor.current;
    if (!documentAdapter || !sourceEditor || busy || session.readOnly) return;
    if (autoSaveInFlight.current) {
      setNotice("自动保存正在完成，请稍后再手动保存。");
      return;
    }

    const documentId = activeDocumentId;
    const revisionBeingSaved = session.currentRevision;
    setBusy(true);
    setNotice(null);
    try {
      const bytes = encodeDocument(
        normalizeLineEndings(sourceEditor.getText(), session.lineEnding),
        session,
      );
      const saved =
        !saveAs && session.path !== null && session.diskFingerprint !== null
          ? await documentAdapter.saveDocument({
              path: session.path,
              bytes,
              expectedFingerprint: session.diskFingerprint,
            })
          : await documentAdapter.saveDocumentAs({
              bytes,
              suggestedName:
                session.path === null
                  ? "未命名.md"
                  : getDocumentName(session.path),
            });

      if (saved === null) return;
      dispatchWorkspace({
        type: "save",
        id: documentId,
        path: saved.path,
        diskFingerprint: saved.diskFingerprint,
        revision: revisionBeingSaved,
      });
      autoSavePausedDocuments.current.delete(documentId);
      let authorizationWarning: string | null = null;
      if (session.path !== null && session.path !== saved.path) {
        try {
          await documentAdapter.releaseDocumentAuthorization(session.path);
        } catch (error) {
          authorizationWarning = `已保存，但释放旧文件授权失败：${getErrorMessage(error)}`;
        }
      }
      void documentAdapter
        .listRecentDocuments()
        .then(setRecentDocuments)
        .catch((error: unknown) => {
          setNotice(`刷新最近文件失败：${getErrorMessage(error)}`);
        });
      setNotice(authorizationWarning ?? "已安全保存");
    } catch (error) {
      setNotice(`保存失败：${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function createCurrentExport(
    style: HtmlExportStyle = "styled",
  ): Promise<{ html: string; suggestedName: string }> {
    const sourceEditor = editor.current;
    if (sourceEditor === null) throw new Error("编辑器尚未就绪");
    const title = getDocumentName(session.path);
    let body = renderMarkdownToSafeHtml(sourceEditor.getText());
    body = await resolveSafeHtmlMathExpressions(
      body,
      async (source, displayMode) => {
        const { renderKatexMathMl } = await import("@mdeditor/renderers/katex");
        return renderKatexMathMl(source, displayMode);
      },
    );
    body = await resolveSafeHtmlMermaidDiagrams(body, async (source) => {
      const { renderMermaidDataUrl } =
        await import("@mdeditor/renderers/mermaid");
      return renderMermaidDataUrl(source);
    });
    body = await resolveSafeHtmlImageSources(body, async (source) => {
      if (!isRelativeLocalImageSource(source)) return null;
      const resolved = await resolveWorkspaceImage(activeDocumentId, source);
      if (resolved === null) return null;
      return resolved;
    });
    return {
      html: createSafeHtmlDocument({
        body,
        documentThemeCss:
          style === "styled" ? activeDocumentTheme?.css : undefined,
        printLayout: settings.printLayout,
        style,
        theme: resolveExportTheme(settings.theme),
        title,
        trustedDocumentCss:
          style === "styled" ? activeTrustedDocumentCss?.css : undefined,
      }),
      suggestedName: createHtmlExportName(title, style),
    };
  }

  splitExportRef.current = async () =>
    (await createCurrentExport("styled")).html;

  useEffect(() => {
    if (viewLayout !== "split" || !recoveryReady) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void splitExportRef
        .current()
        .then((html) => {
          if (!cancelled) {
            setSplitPreviewHtml(html);
            setSplitPreviewError(null);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setSplitPreviewHtml("");
            setSplitPreviewError(getErrorMessage(error));
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeDocumentId,
    activeDocumentTheme?.css,
    activeTrustedDocumentCss?.css,
    dirtyTabSignature,
    recoveryReady,
    settings.printLayout,
    settings.theme,
    viewLayout,
  ]);

  async function exportHtml(style: HtmlExportStyle) {
    if (busy || !recoveryReady) return;
    setBusy(true);
    setNotice(null);
    try {
      const exported = await createCurrentExport(style);
      if (documentAdapter === undefined) {
        downloadHtml(exported.html, exported.suggestedName);
        setNotice("HTML 导出已下载");
      } else {
        const path = await documentAdapter.exportHtml({
          bytes: new TextEncoder().encode(exported.html),
          suggestedName: exported.suggestedName,
        });
        if (path !== null) setNotice(`HTML 已导出：${path}`);
      }
    } catch (error) {
      setNotice(`HTML 导出失败：${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function exportImage() {
    if (busy || !recoveryReady) return;
    setBusy(true);
    setNotice(null);
    try {
      const exported = await createCurrentExport("styled");
      const bytes = await renderSafeHtmlToPng(
        exported.html,
        settings.imageExportScale,
      );
      const suggestedName = createImageExportName(
        getDocumentName(session.path),
      );
      if (documentAdapter === undefined) {
        downloadPng(bytes, suggestedName);
        setNotice("PNG 图片已下载");
      } else {
        const path = await documentAdapter.exportImage({
          bytes,
          suggestedName,
        });
        if (path !== null) setNotice(`PNG 已导出：${path}`);
      }
    } catch (error) {
      setNotice(`PNG 导出失败：${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function exportDocx() {
    if (busy || !recoveryReady || documentAdapter === undefined) return;
    setBusy(true);
    setNotice(null);
    try {
      const status = await documentAdapter.getPandocStatus();
      setPandocStatus(status);
      if (!status.available) {
        setNotice("未检测到 Pandoc；安装后重启 MDEditor 再导出 DOCX。");
        return;
      }
      const exported = await createCurrentExport("unstyled");
      const path = await documentAdapter.exportDocx({
        bytes: prepareSafeHtmlForDocx(exported.html),
        suggestedName: createDocxExportName(getDocumentName(session.path)),
      });
      if (path !== null) setNotice(`DOCX 已导出：${path}`);
    } catch (error) {
      setNotice(`DOCX 导出失败：${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function printDocument() {
    if (busy || !recoveryReady) return;
    setBusy(true);
    setNotice(null);
    try {
      printHtml((await createCurrentExport()).html);
      setNotice("已打开系统打印，可选择另存为 PDF");
    } catch (error) {
      setNotice(`打印失败：${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) return;
      const action = matchShortcut(event, settings.shortcuts);
      if (action === null) return;
      event.preventDefault();

      if (action === "toggleMode") {
        setViewLayout("single");
        setEditorMode((mode) => (mode === "source" ? "hybrid" : "source"));
        return;
      }
      if (action === "toggleOutline") {
        setOutlineOpen((open) => !open);
        return;
      }

      document
        .querySelector<HTMLButtonElement>(`[data-shortcut-action="${action}"]`)
        ?.click();
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [settings.shortcuts]);

  const documentName = getDocumentName(session.path);
  const collapsedOutlineItems =
    collapsedOutlineState.documentId === activeDocumentId
      ? collapsedOutlineState.items
      : new Set<number>();
  const statistics =
    statisticsState?.documentId === activeDocumentId
      ? statisticsState.statistics
      : null;
  const visibleOutlineItems = deriveOutlineView(
    outlineItems,
    outlineFilter,
    collapsedOutlineItems,
  );

  function runDocumentSearch(
    action: "next" | "previous" | "replace" | "replaceAll",
  ) {
    const applied = editor.current?.runSearch(
      searchQuery,
      replacement,
      searchOptions,
      action,
    );
    if (!applied) {
      setNotice(
        searchQuery.trim() === ""
          ? "请先输入查找内容。"
          : searchOptions.regularExpression
            ? "没有匹配项，或正则表达式无效。"
            : "没有匹配项。",
      );
    } else {
      setNotice(null);
    }
  }

  return (
    <main
      className="app-shell"
      data-theme={settings.theme}
      data-focus-mode={settings.focusMode}
      data-typewriter-mode={settings.typewriterMode}
      data-editor-mode={editorMode}
      data-view-layout={viewLayout}
      aria-busy={busy || !recoveryReady}
    >
      {compiledDocumentStyles === "" ? null : (
        <style data-md-document-styles>{compiledDocumentStyles}</style>
      )}
      <header className="titlebar">
        <div className="titlebar-leading">
          <h1 className="brand">MDEditor</h1>
          <div
            className="mode-switch"
            role="radiogroup"
            aria-label="编辑器布局"
          >
            <button
              type="button"
              role="radio"
              aria-checked={viewLayout === "single" && editorMode === "source"}
              onClick={() => {
                setViewLayout("single");
                setEditorMode("source");
              }}
            >
              源码
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={viewLayout === "single" && editorMode === "hybrid"}
              onClick={() => {
                setViewLayout("single");
                setEditorMode("hybrid");
              }}
            >
              混合
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={viewLayout === "split"}
              onClick={() => {
                setEditorMode("source");
                setViewLayout("split");
              }}
            >
              双栏
            </button>
          </div>
        </div>
        <span className="document-state" title={session.path ?? undefined}>
          {documentName}
          {isDirty(session) ? " · 未保存" : ""}
        </span>
        <div className="titlebar-actions" aria-label="文档操作">
          <button
            type="button"
            title="查找 / 替换（Ctrl/⌘ F）"
            disabled={!recoveryReady}
            aria-expanded={searchOpen}
            onClick={() => setSearchOpen((open) => !open)}
          >
            查找 / 替换
          </button>
          <details
            className="file-menu"
            onKeyDown={handleDisclosureKeyDown}
            onToggle={handleTopMenuToggle}
          >
            <summary>文件</summary>
            <div
              className="settings-panel file-panel"
              role="group"
              aria-label="文件操作"
            >
              <button
                type="button"
                data-shortcut-action="newDocument"
                disabled={busy || !recoveryReady}
                onClick={(event) => {
                  newDocument();
                  event.currentTarget
                    .closest(".file-menu")
                    ?.removeAttribute("open");
                }}
              >
                新建
              </button>
              <button
                type="button"
                data-shortcut-action="openDocument"
                disabled={!documentAdapter || busy || !recoveryReady}
                onClick={(event) => {
                  void openDocument();
                  event.currentTarget
                    .closest(".file-menu")
                    ?.removeAttribute("open");
                }}
              >
                打开
              </button>
              <button
                type="button"
                disabled={!documentAdapter || busy || !recoveryReady}
                onClick={(event) => {
                  void openFolderWorkspace();
                  event.currentTarget
                    .closest(".file-menu")
                    ?.removeAttribute("open");
                }}
              >
                打开文件夹
              </button>
              <select
                aria-label="最近文件"
                value=""
                disabled={
                  !documentAdapter ||
                  busy ||
                  !recoveryReady ||
                  recentDocuments.length === 0
                }
                onChange={(event) => {
                  const path = event.currentTarget.value;
                  if (path) void openDocument(path);
                  event.currentTarget
                    .closest(".file-menu")
                    ?.removeAttribute("open");
                }}
              >
                <option value="">最近文件</option>
                {recentDocuments.map((path) => (
                  <option key={path} value={path} title={path}>
                    {getDocumentName(path)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-shortcut-action="saveDocumentAs"
                disabled={
                  !documentAdapter || busy || !recoveryReady || session.readOnly
                }
                onClick={(event) => {
                  void saveDocument(true);
                  event.currentTarget
                    .closest(".file-menu")
                    ?.removeAttribute("open");
                }}
              >
                另存为
              </button>
            </div>
          </details>
          <details
            className="settings-menu"
            onKeyDown={handleDisclosureKeyDown}
            onToggle={handleTopMenuToggle}
          >
            <summary>设置</summary>
            <div className="settings-panel">
              <div
                className="settings-tabs"
                role="tablist"
                aria-label="设置分类"
              >
                {(
                  [
                    ["appearance", "外观"],
                    ["writing", "编辑"],
                    ["shortcuts", "快捷键"],
                    ["about", "关于"],
                  ] as const
                ).map(([section, label]) => (
                  <button
                    key={section}
                    type="button"
                    role="tab"
                    aria-selected={settingsSection === section}
                    aria-controls={`settings-${section}`}
                    onClick={() => setSettingsSection(section)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <section
                id="settings-appearance"
                className="settings-section"
                role="tabpanel"
                aria-label="外观设置"
                hidden={settingsSection !== "appearance"}
              >
                <label>
                  主题
                  <select
                    aria-label="主题"
                    value={settings.theme}
                    onChange={(event) =>
                      updateSettings({
                        ...settings,
                        theme: event.currentTarget
                          .value as AppSettings["theme"],
                      })
                    }
                  >
                    <option value="system">跟随系统</option>
                    <option value="paper">纸张浅色</option>
                    <option value="dark">深色</option>
                  </select>
                </label>
                <fieldset className="document-theme-settings">
                  <legend>文档主题与 CSS</legend>
                  <label>
                    文档主题
                    <select
                      aria-label="文档主题"
                      value={activeDocumentTheme?.id ?? ""}
                      onChange={(event) =>
                        updateSettings({
                          ...settings,
                          documentThemeId: event.currentTarget.value || null,
                        })
                      }
                    >
                      <option value="">默认文档样式</option>
                      {documentStyleLibrary.themes.map((theme) => (
                        <option key={theme.id} value={theme.id}>
                          {theme.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="document-theme-actions">
                    <input
                      ref={documentThemeInput}
                      className="visually-hidden-file"
                      type="file"
                      accept=".css,text/css"
                      aria-label="选择文档主题 CSS"
                      onChange={(event) =>
                        void installThemeFile(event.currentTarget.files?.[0])
                      }
                    />
                    <button
                      type="button"
                      onClick={() => documentThemeInput.current?.click()}
                    >
                      安装主题 CSS
                    </button>
                    <button
                      type="button"
                      disabled={activeDocumentTheme === null}
                      onClick={deleteActiveDocumentTheme}
                    >
                      移除当前主题
                    </button>
                  </div>
                  <small>
                    安装主题仅允许表现属性，并自动限定在编辑文档、带样式
                    HTML、PNG 与打印表面。
                  </small>
                  <label className="trusted-css-confirmation">
                    <input
                      type="checkbox"
                      checked={trustedCssAcknowledged}
                      onChange={(event) =>
                        setTrustedCssAcknowledged(event.currentTarget.checked)
                      }
                    />
                    我理解受信 CSS 可以改变文档布局
                  </label>
                  <div className="document-theme-actions">
                    <input
                      ref={trustedDocumentCssInput}
                      className="visually-hidden-file"
                      type="file"
                      accept=".css,text/css"
                      aria-label="选择受信文档 CSS"
                      onChange={(event) =>
                        void installTrustedCssFile(
                          event.currentTarget.files?.[0],
                        )
                      }
                    />
                    <button
                      type="button"
                      disabled={!trustedCssAcknowledged}
                      onClick={() => trustedDocumentCssInput.current?.click()}
                    >
                      加载受信 CSS
                    </button>
                    <button
                      type="button"
                      disabled={documentStyleLibrary.trustedCss === null}
                      onClick={removeTrustedDocumentCss}
                    >
                      移除受信 CSS
                    </button>
                  </div>
                  {documentStyleLibrary.trustedCss === null ? null : (
                    <label>
                      <input
                        type="checkbox"
                        checked={settings.trustedDocumentCssEnabled}
                        onChange={(event) =>
                          updateSettings({
                            ...settings,
                            trustedDocumentCssEnabled:
                              event.currentTarget.checked,
                          })
                        }
                      />
                      启用“{documentStyleLibrary.trustedCss.name}”
                    </label>
                  )}
                  <small>
                    即使明确受信，仍拒绝远程资源、@import、固定定位与越界选择器。
                  </small>
                </fieldset>
              </section>
              <section
                id="settings-writing"
                className="settings-section"
                role="tabpanel"
                aria-label="编辑设置"
                hidden={settingsSection !== "writing"}
              >
                <label>
                  字号
                  <input
                    type="range"
                    min="12"
                    max="24"
                    value={settings.fontSize}
                    onChange={(event) =>
                      updateSettings({
                        ...settings,
                        fontSize: Number(event.currentTarget.value),
                      })
                    }
                  />
                  <output>{settings.fontSize}px</output>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.lineWrapping}
                    onChange={(event) =>
                      updateSettings({
                        ...settings,
                        lineWrapping: event.currentTarget.checked,
                      })
                    }
                  />
                  自动换行
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.focusMode}
                    onChange={(event) =>
                      updateSettings({
                        ...settings,
                        focusMode: event.currentTarget.checked,
                      })
                    }
                  />
                  专注模式
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.typewriterMode}
                    onChange={(event) =>
                      updateSettings({
                        ...settings,
                        typewriterMode: event.currentTarget.checked,
                      })
                    }
                  />
                  打字机模式
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.markdownAutoPair}
                    onChange={(event) =>
                      updateSettings({
                        ...settings,
                        markdownAutoPair: event.currentTarget.checked,
                      })
                    }
                  />
                  Markdown 自动配对
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.spellcheckEnabled}
                    onChange={(event) =>
                      updateSettings({
                        ...settings,
                        spellcheckEnabled: event.currentTarget.checked,
                      })
                    }
                  />
                  拼写检查（离线）
                </label>
                <label>
                  拼写语言
                  <select
                    aria-label="拼写检查语言"
                    disabled={!settings.spellcheckEnabled}
                    value={settings.spellcheckLanguage}
                    onChange={(event) =>
                      updateSettings({
                        ...settings,
                        spellcheckLanguage: event.currentTarget
                          .value as AppSettings["spellcheckLanguage"],
                      })
                    }
                  >
                    <option value="en-US">English（美国）</option>
                    <option value="en-GB">English（英国）</option>
                  </select>
                </label>
                <small className="settings-hint">
                  词典仅在启用时加载；悬停波浪线可查看并应用替换建议。
                </small>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.autoSaveEnabled}
                    onChange={(event) =>
                      updateSettings({
                        ...settings,
                        autoSaveEnabled: event.currentTarget.checked,
                      })
                    }
                  />
                  自动保存已有文件
                </label>
                <label>
                  自动保存延迟
                  <select
                    aria-label="自动保存延迟"
                    disabled={!settings.autoSaveEnabled}
                    value={settings.autoSaveDelaySeconds}
                    onChange={(event) =>
                      updateSettings({
                        ...settings,
                        autoSaveDelaySeconds: Number(
                          event.currentTarget.value,
                        ) as AutoSaveDelaySeconds,
                      })
                    }
                  >
                    <option value="2">停止输入 2 秒后</option>
                    <option value="5">停止输入 5 秒后</option>
                    <option value="10">停止输入 10 秒后</option>
                    <option value="30">停止输入 30 秒后</option>
                  </select>
                </label>
              </section>
              <section
                id="settings-shortcuts"
                className="settings-section"
                role="tabpanel"
                aria-label="快捷键设置"
                hidden={settingsSection !== "shortcuts"}
              >
                <fieldset className="shortcut-settings">
                  <legend>快捷键</legend>
                  {SHORTCUT_ACTIONS.map((action) => (
                    <label key={action}>
                      {shortcutNames[action]}
                      <select
                        aria-label={`${shortcutNames[action]}快捷键`}
                        value={settings.shortcuts[action]}
                        onChange={(event) =>
                          updateShortcut(action, event.currentTarget.value)
                        }
                      >
                        {SUPPORTED_SHORTCUTS.map((shortcut) => (
                          <option key={shortcut} value={shortcut}>
                            {formatShortcut(shortcut)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </fieldset>
              </section>
              <section
                id="settings-about"
                className="settings-section settings-about"
                role="tabpanel"
                aria-label="关于 MDEditor"
                hidden={settingsSection !== "about"}
              >
                <strong>MDEditor {appVersion}</strong>
                <p>以下信息可用于填写 Windows 人工验收记录。</p>
                <textarea
                  aria-label="版本与环境信息"
                  readOnly
                  rows={12}
                  value={[
                    `MDEditor：${appVersion}`,
                    "构建提交：请手填（可用 git rev-parse --short HEAD 查询）",
                    `系统：${navigator.userAgent.match(/Windows NT [^;)]+/u)?.[0] ?? navigator.platform}（精确版本请用 winver 核对）`,
                    "Windows 精确版本：请用 winver 核对后手填",
                    `WebView2 / Edge：${navigator.userAgent.match(/Edg\/([\d.]+)/u)?.[1] ?? "未检测到"}`,
                    `显示分辨率：${window.screen.width} × ${window.screen.height}`,
                    `显示缩放：${Math.round(window.devicePixelRatio * 100)}%（请与 Windows 设置核对）`,
                    `窗口内容尺寸：${window.innerWidth} × ${window.innerHeight} CSS 像素`,
                    "Windows 对比度主题：请手填",
                    `语言：${navigator.language}`,
                    "中文输入法及版本：请手填",
                    "键盘布局 / 实体键盘：请手填",
                  ].join("\n")}
                />
                <button
                  type="button"
                  onClick={() => {
                    const information =
                      document.querySelector<HTMLTextAreaElement>(
                        "#settings-about textarea",
                      )?.value;
                    if (information === undefined) return;
                    void navigator.clipboard.writeText(information).then(
                      () => setNotice("版本与环境信息已复制。"),
                      () => setNotice("无法自动复制，请选中文本手动复制。"),
                    );
                  }}
                >
                  复制版本信息
                </button>
              </section>
            </div>
          </details>
          <details
            className="settings-menu export-menu"
            onKeyDown={handleDisclosureKeyDown}
            onToggle={handleTopMenuToggle}
          >
            <summary>导出</summary>
            <div className="export-panel">
              <label>
                纸张
                <select
                  aria-label="打印纸张"
                  value={settings.printLayout.pageSize}
                  onChange={(event) =>
                    updateSettings({
                      ...settings,
                      printLayout: {
                        ...settings.printLayout,
                        pageSize: event.currentTarget.value as "A4" | "Letter",
                      },
                    })
                  }
                >
                  <option value="A4">A4</option>
                  <option value="Letter">Letter</option>
                </select>
              </label>
              <label>
                方向
                <select
                  aria-label="打印方向"
                  value={settings.printLayout.orientation}
                  onChange={(event) =>
                    updateSettings({
                      ...settings,
                      printLayout: {
                        ...settings.printLayout,
                        orientation: event.currentTarget.value as
                          "portrait" | "landscape",
                      },
                    })
                  }
                >
                  <option value="portrait">纵向</option>
                  <option value="landscape">横向</option>
                </select>
              </label>
              <label>
                边距
                <select
                  aria-label="打印边距"
                  value={settings.printLayout.margin}
                  onChange={(event) =>
                    updateSettings({
                      ...settings,
                      printLayout: {
                        ...settings.printLayout,
                        margin: event.currentTarget.value as
                          "normal" | "narrow" | "wide",
                      },
                    })
                  }
                >
                  <option value="normal">标准（20 mm）</option>
                  <option value="narrow">窄（10 mm）</option>
                  <option value="wide">宽（30 mm）</option>
                </select>
              </label>
              <label>
                一级标题间分页
                <input
                  aria-label="一级标题间分页"
                  type="checkbox"
                  checked={
                    settings.printLayout.pageBreakBetweenTopLevelHeadings
                  }
                  onChange={(event) =>
                    updateSettings({
                      ...settings,
                      printLayout: {
                        ...settings.printLayout,
                        pageBreakBetweenTopLevelHeadings:
                          event.currentTarget.checked,
                      },
                    })
                  }
                />
              </label>
              <label>
                PDF 页眉
                <input
                  aria-label="PDF 页眉模板"
                  type="text"
                  maxLength={MAXIMUM_PRINT_TEMPLATE_CHARACTERS}
                  placeholder="${title}"
                  value={settings.printLayout.headerTemplate}
                  onChange={(event) =>
                    updateSettings({
                      ...settings,
                      printLayout: {
                        ...settings.printLayout,
                        headerTemplate: event.currentTarget.value,
                      },
                    })
                  }
                />
              </label>
              <label>
                PDF 页脚
                <input
                  aria-label="PDF 页脚模板"
                  type="text"
                  maxLength={MAXIMUM_PRINT_TEMPLATE_CHARACTERS}
                  placeholder="第 ${pageNo} / ${pageCount} 页"
                  value={settings.printLayout.footerTemplate}
                  onChange={(event) =>
                    updateSettings({
                      ...settings,
                      printLayout: {
                        ...settings.printLayout,
                        footerTemplate: event.currentTarget.value,
                      },
                    })
                  }
                />
              </label>
              <small>
                {"页眉页脚支持 ${title}、${pageNo}、${pageCount}；留空关闭。"}
              </small>
              <label>
                图片清晰度
                <select
                  aria-label="图片导出清晰度"
                  value={settings.imageExportScale}
                  onChange={(event) =>
                    updateSettings({
                      ...settings,
                      imageExportScale: Number(event.currentTarget.value) as
                        1 | 2,
                    })
                  }
                >
                  <option value="1">1×</option>
                  <option value="2">2×</option>
                </select>
              </label>
              <button
                type="button"
                disabled={busy || !recoveryReady}
                onClick={() => void exportImage()}
              >
                导出 PNG 图片
              </button>
              <button
                type="button"
                disabled={busy || !recoveryReady}
                onClick={() => void exportHtml("styled")}
              >
                导出带样式 HTML
              </button>
              <button
                type="button"
                disabled={busy || !recoveryReady}
                onClick={() => void exportHtml("unstyled")}
              >
                导出无样式 HTML
              </button>
              <button
                type="button"
                disabled={
                  busy || !recoveryReady || documentAdapter === undefined
                }
                onClick={() => void exportDocx()}
              >
                导出 DOCX（Pandoc）
              </button>
              {pandocStatus !== null && !pandocStatus.available ? (
                <button
                  type="button"
                  disabled={busy || documentAdapter === undefined}
                  onClick={() =>
                    void documentAdapter?.openExternalUrl(
                      pandocStatus.installUrl,
                    )
                  }
                >
                  查看 Pandoc 安装说明
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy || !recoveryReady}
                onClick={() => void printDocument()}
              >
                打印 / PDF
              </button>
              <small>
                {pandocStatus?.available === true
                  ? `DOCX：${pandocStatus.version ?? "Pandoc 可用"}。`
                  : "DOCX 需要桌面环境中的可选 Pandoc；PDF 由系统打印对话框生成。"}
              </small>
            </div>
          </details>
          <button
            type="button"
            data-shortcut-action="saveDocument"
            disabled={
              !documentAdapter || busy || !recoveryReady || session.readOnly
            }
            onClick={() => void saveDocument()}
          >
            保存
          </button>
        </div>
      </header>
      {searchOpen ? (
        <section className="document-search" aria-label="文档查找替换">
          <label>
            查找
            <input
              ref={searchInput}
              type="text"
              aria-label="查找"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  runDocumentSearch(event.shiftKey ? "previous" : "next");
                } else if (event.key === "Escape") {
                  setSearchOpen(false);
                  editor.current?.focus();
                }
              }}
            />
          </label>
          <label>
            替换
            <input
              type="text"
              aria-label="替换"
              value={replacement}
              onChange={(event) => setReplacement(event.currentTarget.value)}
            />
          </label>
          <button type="button" onClick={() => runDocumentSearch("previous")}>
            上一个
          </button>
          <button type="button" onClick={() => runDocumentSearch("next")}>
            下一个
          </button>
          <button
            type="button"
            disabled={session.readOnly}
            onClick={() => runDocumentSearch("replace")}
          >
            替换当前
          </button>
          <button
            type="button"
            disabled={session.readOnly}
            onClick={() => runDocumentSearch("replaceAll")}
          >
            全部替换
          </button>
          <label>
            <input
              type="checkbox"
              checked={searchOptions.caseSensitive}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSearchOptions((options) => ({
                  ...options,
                  caseSensitive: checked,
                }));
              }}
            />
            区分大小写
          </label>
          <label>
            <input
              type="checkbox"
              checked={searchOptions.wholeWord}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSearchOptions((options) => ({
                  ...options,
                  wholeWord: checked,
                }));
              }}
            />
            全字匹配
          </label>
          <label>
            <input
              type="checkbox"
              checked={searchOptions.regularExpression}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSearchOptions((options) => ({
                  ...options,
                  regularExpression: checked,
                }));
              }}
            />
            正则表达式
          </label>
          <button
            type="button"
            aria-label="关闭查找替换"
            onClick={() => {
              setSearchOpen(false);
              editor.current?.focus();
            }}
          >
            关闭
          </button>
        </section>
      ) : null}
      <div
        className="document-notice"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {notice}
      </div>
      <nav className="document-tabs" aria-label="打开的文档">
        <div className="document-tabs-inner">
          <div role="tablist" aria-label="文档标签页">
            {workspace.tabs.map((tab, index) => {
              const tabName =
                tab.session.path === null
                  ? `未命名 ${index + 1}`
                  : getDocumentName(tab.session.path);
              const dirty = isDirty(tab.session);
              return (
                <div
                  className="document-tab"
                  role="presentation"
                  data-active={tab.id === activeDocumentId}
                  key={tab.id}
                >
                  <button
                    type="button"
                    id={`workspace-tab-${index}`}
                    role="tab"
                    aria-controls="editor-workspace"
                    aria-selected={tab.id === activeDocumentId}
                    tabIndex={tab.id === activeDocumentId ? 0 : -1}
                    title={tab.session.path ?? tabName}
                    disabled={busy}
                    onClick={() =>
                      dispatchWorkspace({ type: "activate", id: tab.id })
                    }
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                  >
                    <span>{tabName}</span>
                    {dirty ? (
                      <span className="tab-dirty" aria-label="未保存">
                        ●
                      </span>
                    ) : null}
                  </button>
                </div>
              );
            })}
          </div>
          {/* Close buttons are visual overlays; the tablist owns only tabs. */}
          <div className="document-tab-close-layer">
            {workspace.tabs.map((tab, index) => {
              const tabName =
                tab.session.path === null
                  ? `未命名 ${index + 1}`
                  : getDocumentName(tab.session.path);
              return (
                <div className="document-tab-close-slot" key={tab.id}>
                  <button
                    type="button"
                    className="tab-close"
                    aria-label={`关闭 ${tabName}`}
                    title={`关闭 ${tabName}`}
                    disabled={busy}
                    onClick={() => {
                      void closeDocument(tab.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </nav>
      <section
        id="editor-workspace"
        className="workspace"
        role="tabpanel"
        aria-labelledby={`workspace-tab-${activeTabIndex}`}
      >
        <div
          ref={toolbarRef}
          className="editor-toolbar"
          role="toolbar"
          aria-label="Markdown 格式与插入工具"
          onKeyDown={handleToolbarKeyDown}
        >
          <button
            type="button"
            aria-pressed={outlineOpen}
            data-toolbar-index="0"
            tabIndex={toolbarTabStopIndex === 0 ? 0 : -1}
            onFocus={() => setToolbarFocusIndex(0)}
            onClick={() => setOutlineOpen((open) => !open)}
          >
            大纲
          </button>
          {visibleFormattingActions.map((action, index) => {
            const toolbarIndex = index + 1;
            return (
              <button
                key={action.command}
                type="button"
                aria-label={action.title}
                title={action.title}
                disabled={!recoveryReady || session.readOnly}
                data-toolbar-index={toolbarIndex}
                tabIndex={toolbarTabStopIndex === toolbarIndex ? 0 : -1}
                onFocus={() => setToolbarFocusIndex(toolbarIndex)}
                onClick={() => editor.current?.format(action.command)}
              >
                {action.label}
              </button>
            );
          })}
          <details className="format-menu" onKeyDown={handleDisclosureKeyDown}>
            <summary>更多格式</summary>
            <div
              className="format-panel"
              role="group"
              aria-label="更多格式命令"
            >
              {moreFormattingActions.map((action) => (
                <button
                  key={action.command}
                  type="button"
                  aria-label={action.title}
                  title={action.title}
                  disabled={!recoveryReady || session.readOnly}
                  onClick={(event) => {
                    editor.current?.format(action.command);
                    event.currentTarget
                      .closest(".format-menu")
                      ?.removeAttribute("open");
                  }}
                >
                  {action.label}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={settings.focusMode}
                onClick={() =>
                  updateSettings({
                    ...settings,
                    focusMode: !settings.focusMode,
                  })
                }
              >
                专注
              </button>
              <button
                type="button"
                aria-pressed={settings.typewriterMode}
                onClick={() =>
                  updateSettings({
                    ...settings,
                    typewriterMode: !settings.typewriterMode,
                  })
                }
              >
                打字机
              </button>
              <details
                className="table-tools"
                onKeyDown={handleDisclosureKeyDown}
              >
                <summary>表格结构操作</summary>
                <div role="toolbar" aria-label="表格结构操作">
                  {tableActions.map((action) => (
                    <button
                      key={action.command}
                      type="button"
                      disabled={!recoveryReady || session.readOnly}
                      onClick={() => {
                        const applied =
                          editor.current?.editTable(action.command) ?? false;
                        setNotice(
                          applied
                            ? `已${action.label}`
                            : "请先将光标置于可执行该操作的表格单元格",
                        );
                      }}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
                <small>表格内按 Tab / Shift+Tab 切换单元格</small>
              </details>
            </div>
          </details>
        </div>
        <div className="workspace-body">
          {folderWorkspace === null ? null : (
            <WorkspaceFiles
              key={folderWorkspace.root}
              workspace={folderWorkspace}
              busy={busy}
              onOpen={(entry) => void openFolderDocument(entry)}
              onRefresh={() => void refreshFolderWorkspace()}
              onClose={() => void closeFolderWorkspace()}
              onCreateFile={createFolderDocument}
              onCreateDirectory={createFolderDirectory}
              onImportImage={importFolderImage}
              onInspectImages={inspectFolderImages}
              onConsolidateImages={consolidateFolderImages}
              onOpenImageIssue={openFolderImageIssue}
              onMove={moveFolderEntry}
              onCopy={copyFolderEntry}
              onCopyImageWithReferences={copyFolderImageWithReferences}
              onDelete={deleteFolderEntry}
              searchAvailable={workspaceSearchAvailable}
              searchPhase={workspaceSearchState.phase}
              searchMatches={workspaceSearchState.matches}
              searchTruncated={workspaceSearchState.truncated}
              onOpenSearchMatch={openFolderSearchMatch}
              onStartSearch={startFolderSearch}
              onCancelSearch={cancelFolderSearch}
            />
          )}
          {outlineOpen ? (
            <nav className="outline-panel" aria-label="文档大纲">
              <div className="outline-heading">
                <strong>文档大纲</strong>
                <span>
                  {visibleOutlineItems.length === outlineItems.length
                    ? `${outlineItems.length} 个标题`
                    : `${visibleOutlineItems.length} / ${outlineItems.length} 个标题`}
                </span>
              </div>
              <label className="outline-filter">
                <span>筛选标题</span>
                <input
                  type="search"
                  aria-label="筛选大纲"
                  value={outlineFilter}
                  placeholder="筛选标题…"
                  onChange={(event) =>
                    setOutlineFilter(event.currentTarget.value)
                  }
                />
              </label>
              {outlineLoading ? (
                <p className="outline-empty" role="status">
                  正在分析标题…
                </p>
              ) : outlineItems.length === 0 ? (
                <p className="outline-empty">暂无标题</p>
              ) : visibleOutlineItems.length === 0 ? (
                <p className="outline-empty">没有匹配的标题</p>
              ) : (
                <ol className="outline-list">
                  {visibleOutlineItems.map((item) => {
                    const collapsed = collapsedOutlineItems.has(item.from);
                    return (
                      <li key={item.from}>
                        <div
                          className="outline-row"
                          style={{
                            paddingLeft: `${6 + (item.level - 1) * 14}px`,
                          }}
                        >
                          {item.hasChildren && outlineFilter.trim() === "" ? (
                            <button
                              className="outline-toggle"
                              type="button"
                              aria-label={`${collapsed ? "展开" : "折叠"}：${item.text}`}
                              aria-expanded={!collapsed}
                              onClick={() =>
                                setCollapsedOutlineState((current) => {
                                  const next = new Set(
                                    current.documentId === activeDocumentId
                                      ? current.items
                                      : [],
                                  );
                                  if (next.has(item.from))
                                    next.delete(item.from);
                                  else next.add(item.from);
                                  return {
                                    documentId: activeDocumentId,
                                    items: next,
                                  };
                                })
                              }
                            >
                              <span aria-hidden="true">
                                {collapsed ? "▸" : "▾"}
                              </span>
                            </button>
                          ) : (
                            <span className="outline-toggle-placeholder" />
                          )}
                          <button
                            className="outline-jump"
                            type="button"
                            title={`跳转到：${item.text}`}
                            onClick={() =>
                              editor.current?.revealPosition(item.from)
                            }
                          >
                            <span aria-hidden="true">H{item.level}</span>
                            {item.text}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </nav>
          ) : null}
          <div className="editor-pane">
            <div
              ref={editorHost}
              className="editor-host"
              data-md-document-style={
                compiledDocumentStyles === "" ? undefined : "true"
              }
            />
          </div>
          {viewLayout === "split" ? (
            <section className="split-preview" aria-label="文档预览">
              <div className="split-preview-heading">预览 · {documentName}</div>
              {splitPreviewError === null ? (
                splitPreviewHtml === "" ? (
                  <p role="status">正在更新预览…</p>
                ) : (
                  <iframe
                    title="Markdown 实时预览"
                    sandbox=""
                    srcDoc={splitPreviewHtml}
                  />
                )
              ) : (
                <p role="status">预览失败：{splitPreviewError}</p>
              )}
            </section>
          ) : null}
        </div>
      </section>
      <footer className="statusbar" aria-label="文档状态">
        <span>{session.encoding.toUpperCase()}</span>
        <span>{session.lineEnding === "\r\n" ? "CRLF" : "LF"}</span>
        <span>{session.hasFinalNewline ? "末尾换行" : "无末尾换行"}</span>
        {session.readOnly ? (
          <span className="statusbar-readonly">只读</span>
        ) : null}
        <span>修订 {session.currentRevision}</span>
        <span>{editorMode === "hybrid" ? "混合模式" : "源码模式"}</span>
        <span>{settings.lineWrapping ? "自动换行" : "不换行"}</span>
        <span>
          {settings.autoSaveEnabled
            ? `自动保存 ${settings.autoSaveDelaySeconds} 秒`
            : "自动保存关闭"}
        </span>
        {settings.focusMode ? <span>专注模式</span> : null}
        {settings.typewriterMode ? <span>打字机模式</span> : null}
        {statistics ? (
          <span
            className="document-statistics"
            aria-label={`文档统计：${statistics.document.words} 字，${statistics.document.characters} 字符，${statistics.document.lines} 行，约 ${statistics.document.readingTimeMinutes} 分钟`}
          >
            字数 {statistics.document.words}
            <span className="statistics-full">
              {" "}
              · 字符 {statistics.document.characters} · 行{" "}
              {statistics.document.lines} · 约{" "}
              {statistics.document.readingTimeMinutes} 分钟
            </span>
          </span>
        ) : null}
        {statistics?.selection ? (
          <span
            className="selection-statistics"
            aria-label={`选区统计：${statistics.selection.words} 字，${statistics.selection.characters} 字符，${statistics.selection.lines} 行`}
          >
            选中 {statistics.selection.words} 字 ·{" "}
            {statistics.selection.characters}
            字符
          </span>
        ) : null}
      </footer>
    </main>
  );
}
