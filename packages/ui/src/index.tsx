import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
  createUntitledSession,
  createWorkspaceRecoverySnapshot,
  decodeDocument,
  encodeDocument,
  isDirty,
  type DecodedDocument,
  type DocumentAdapter,
} from "@mdeditor/document-session";
import {
  createSourceEditor,
  type ComplexBlockRenderers,
  type EditorMode,
  type OutlineItem,
  type SourceEditor,
} from "@mdeditor/editor-core";
import {
  createHtmlExportName,
  createStandaloneHtml,
  type ExportTheme,
} from "@mdeditor/markdown";

import {
  formatShortcut,
  hasShortcutConflict,
  loadAppSettings,
  matchShortcut,
  saveAppSettings,
  SHORTCUT_ACTIONS,
  SUPPORTED_SHORTCUTS,
  type AppSettings,
  type ShortcutAction,
} from "./settings.js";
import {
  createWorkspaceState,
  findWorkspaceTabByPath,
  getActiveWorkspaceTab,
  workspaceReducer,
} from "./workspace.js";

const shortcutNames: Readonly<Record<ShortcutAction, string>> = {
  newDocument: "新建",
  openDocument: "打开",
  saveDocument: "保存",
  saveDocumentAs: "另存为",
  toggleMode: "切换模式",
  toggleOutline: "切换大纲",
};

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

const initialText = `# 欢迎使用 MDEditor

这是正在推进 M3 常用增强的渐进式 Markdown 编辑器。Markdown 文本仍由 CodeMirror 持有，不会复制到 React Store。

- 在源码与混合模式间无损切换
- 渐进显示标题、强调、链接、引用、列表、图片与代码
- 点击任务复选框，使用 Tab / Shift+Tab 在 GFM 表格单元格间移动
- 打开文档大纲并点击标题，快速定位到对应源码
- 按需渲染 KaTeX 数学公式与 Mermaid 图表，单个预览失败不会影响源码
- 使用标签页同时编辑多个文档，每个标签保留独立选择和撤销历史
- 切换纸张、深色或跟随系统主题，并按需配置常用快捷键
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

export function AppShell({ documentAdapter }: AppShellProps) {
  const editorHost = useRef<HTMLDivElement>(null);
  const editor = useRef<SourceEditor | null>(null);
  const editors = useRef(new Map<string, WorkspaceEditor>());
  const pendingTexts = useRef(
    new Map<string, string>([[initialDocument.session.id, initialText]]),
  );
  const recoveryCheckStarted = useRef(false);
  const recoveryOperations = useRef<Promise<void>>(Promise.resolve());
  const lastRecoverySignature = useRef<string | null>(null);
  const [workspace, dispatchWorkspace] = useReducer(
    workspaceReducer,
    initialDocument.session,
    createWorkspaceState,
  );
  const workspaceRef = useRef(workspace);
  const [recoveryReady, setRecoveryReady] = useState(
    () => documentAdapter === undefined,
  );
  const [recentDocuments, setRecentDocuments] = useState<readonly string[]>([]);
  const [settings, setSettings] = useState(loadAppSettings);
  const [editorMode, setEditorMode] = useState<EditorMode>("source");
  const settingsRef = useRef(settings);
  const editorModeRef = useRef(editorMode);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineItems, setOutlineItems] = useState<readonly OutlineItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const activeTab = getActiveWorkspaceTab(workspace);
  const activeDocumentId = activeTab.id;
  const session = activeTab.session;
  const dirtyTabSignature = workspace.tabs
    .filter(({ session: tabSession }) => isDirty(tabSession))
    .map(({ id, session: tabSession }) => `${id}:${tabSession.currentRevision}`)
    .join("|");

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    editorModeRef.current = editorMode;
  }, [editorMode]);

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
      const sourceEditor = createSourceEditor({
        parent: documentHost,
        text: pendingTexts.current.get(activeDocumentId) ?? "",
        lineSeparator: tab.session.lineEnding,
        readOnly: tab.session.readOnly,
        mode: editorModeRef.current,
        fontSize: settingsRef.current.fontSize,
        lineWrapping: settingsRef.current.lineWrapping,
        complexRenderers,
        onTextChange: (text) => {
          dispatchWorkspace({
            type: "edit",
            id: activeDocumentId,
            text,
          });
        },
      });
      workspaceEditor = { editor: sourceEditor, host: documentHost };
      editors.current.set(activeDocumentId, workspaceEditor);
      pendingTexts.current.delete(activeDocumentId);
    } else {
      workspaceEditor.editor.setMode(editorModeRef.current);
      workspaceEditor.editor.setPreferences({
        fontSize: settingsRef.current.fontSize,
        lineWrapping: settingsRef.current.lineWrapping,
      });
    }
    workspaceEditor.host.hidden = false;
    editor.current = workspaceEditor.editor;
    workspaceEditor.editor.focus();
  }, [activeDocumentId, recoveryReady]);

  useEffect(() => {
    editor.current?.setMode(editorMode);
  }, [activeDocumentId, editorMode, recoveryReady]);

  useEffect(() => {
    editor.current?.setPreferences({
      fontSize: settings.fontSize,
      lineWrapping: settings.lineWrapping,
    });
  }, [
    activeDocumentId,
    recoveryReady,
    settings.fontSize,
    settings.lineWrapping,
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

  useEffect(() => {
    if (!documentAdapter || recoveryCheckStarted.current) return;
    recoveryCheckStarted.current = true;

    void (async () => {
      try {
        const snapshot = await documentAdapter.loadRecoverySnapshot();
        if (snapshot === null) return;

        const sourceNames = snapshot.documents.map(({ session: tabSession }) =>
          getDocumentName(tabSession.path),
        );
        const recoveryDescription =
          sourceNames.length === 1
            ? `“${sourceNames[0]}”`
            : `${sourceNames.length} 个文档`;
        const shouldRestore = window.confirm(
          `发现 ${snapshot.capturedAt} 自动保存的${recoveryDescription}恢复工作区。是否恢复？`,
        );
        if (!shouldRestore) {
          await documentAdapter.clearRecoverySnapshot();
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
      } catch (error) {
        setNotice(`读取恢复稿失败：${getErrorMessage(error)}`);
        try {
          await documentAdapter.clearRecoverySnapshot();
        } catch {
          // Keep the original recovery error visible.
        }
      } finally {
        setRecoveryReady(true);
      }
    })();
  }, [documentAdapter]);

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
    if (!documentAdapter || !recoveryReady) return;

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
  }, [dirtyTabSignature, documentAdapter, recoveryReady]);

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

      const decoded = decodeDocument(opened.bytes, {
        id: opened.path,
        path: opened.path,
        diskFingerprint: opened.diskFingerprint,
      });
      const openTab = findWorkspaceTabByPath(workspaceRef.current, opened.path);
      if (openTab !== undefined) {
        dispatchWorkspace({ type: "activate", id: openTab.id });
        setNotice("该文件已在标签页中打开");
      } else {
        pendingTexts.current.set(decoded.session.id, decoded.text);
        dispatchWorkspace({ type: "add", session: decoded.session });
      }
      void documentAdapter
        .listRecentDocuments()
        .then(setRecentDocuments)
        .catch((error: unknown) => {
          setNotice(`刷新最近文件失败：${getErrorMessage(error)}`);
        });
      if (decoded.session.readOnly) {
        setNotice(
          "文件包含当前版本不能安全回写的编码或换行符，已用只读模式打开。",
        );
      }
    } catch (error) {
      setNotice(`打开失败：${getErrorMessage(error)}`);
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

  function closeDocument(id: string) {
    if (busy) return;
    const currentWorkspace = workspaceRef.current;
    const tab = currentWorkspace.tabs.find((candidate) => candidate.id === id);
    if (tab === undefined) return;
    if (
      isDirty(tab.session) &&
      !window.confirm(
        `“${getDocumentName(tab.session.path)}”尚未保存。确定要关闭并放弃更改吗？`,
      )
    ) {
      return;
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
      dispatchWorkspace({ type: "replace", session: replacement });
    } else {
      dispatchWorkspace({ type: "close", id });
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

  async function saveDocument(saveAs = false) {
    const sourceEditor = editor.current;
    if (!documentAdapter || !sourceEditor || busy || session.readOnly) return;

    const documentId = activeDocumentId;
    const revisionBeingSaved = session.currentRevision;
    setBusy(true);
    setNotice(null);
    try {
      const bytes = encodeDocument(sourceEditor.getText(), session);
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
      void documentAdapter
        .listRecentDocuments()
        .then(setRecentDocuments)
        .catch((error: unknown) => {
          setNotice(`刷新最近文件失败：${getErrorMessage(error)}`);
        });
      setNotice("已安全保存");
    } catch (error) {
      setNotice(`保存失败：${getErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function createCurrentExport(): { html: string; suggestedName: string } {
    const sourceEditor = editor.current;
    if (sourceEditor === null) throw new Error("编辑器尚未就绪");
    const title = getDocumentName(session.path);
    return {
      html: createStandaloneHtml({
        source: sourceEditor.getText(),
        theme: resolveExportTheme(settings.theme),
        title,
      }),
      suggestedName: createHtmlExportName(title),
    };
  }

  async function exportHtml() {
    if (busy || !recoveryReady) return;
    setBusy(true);
    setNotice(null);
    try {
      const exported = createCurrentExport();
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

  function printDocument() {
    if (busy || !recoveryReady) return;
    setNotice(null);
    try {
      printHtml(createCurrentExport().html);
      setNotice("已打开系统打印，可选择另存为 PDF");
    } catch (error) {
      setNotice(`打印失败：${getErrorMessage(error)}`);
    }
  }

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) return;
      const action = matchShortcut(event, settings.shortcuts);
      if (action === null) return;
      event.preventDefault();

      if (action === "toggleMode") {
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

  return (
    <main className="app-shell" data-theme={settings.theme}>
      <header className="titlebar">
        <div className="titlebar-leading">
          <span className="brand">MDEditor</span>
          <div className="mode-switch" aria-label="编辑器模式">
            <button
              type="button"
              aria-pressed={editorMode === "source"}
              onClick={() => setEditorMode("source")}
            >
              源码
            </button>
            <button
              type="button"
              aria-pressed={editorMode === "hybrid"}
              onClick={() => setEditorMode("hybrid")}
            >
              混合
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
            data-shortcut-action="newDocument"
            disabled={busy || !recoveryReady}
            onClick={newDocument}
          >
            新建
          </button>
          <button
            type="button"
            data-shortcut-action="openDocument"
            disabled={!documentAdapter || busy || !recoveryReady}
            onClick={() => void openDocument()}
          >
            打开
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
            }}
          >
            <option value="">最近文件</option>
            {recentDocuments.map((path) => (
              <option key={path} value={path} title={path}>
                {getDocumentName(path)}
              </option>
            ))}
          </select>
          <details className="settings-menu">
            <summary>设置</summary>
            <div className="settings-panel">
              <label>
                主题
                <select
                  aria-label="主题"
                  value={settings.theme}
                  onChange={(event) =>
                    updateSettings({
                      ...settings,
                      theme: event.currentTarget.value as AppSettings["theme"],
                    })
                  }
                >
                  <option value="system">跟随系统</option>
                  <option value="paper">纸张浅色</option>
                  <option value="dark">深色</option>
                </select>
              </label>
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
            </div>
          </details>
          <details className="settings-menu export-menu">
            <summary>导出</summary>
            <div className="export-panel">
              <button
                type="button"
                disabled={busy || !recoveryReady}
                onClick={() => void exportHtml()}
              >
                导出 HTML
              </button>
              <button
                type="button"
                disabled={busy || !recoveryReady}
                onClick={printDocument}
              >
                打印 / PDF
              </button>
              <small>PDF 由系统打印对话框生成。</small>
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
          <button
            type="button"
            data-shortcut-action="saveDocumentAs"
            disabled={
              !documentAdapter || busy || !recoveryReady || session.readOnly
            }
            onClick={() => void saveDocument(true)}
          >
            另存为
          </button>
        </div>
      </header>
      {notice ? (
        <div className="document-notice" role="status">
          {notice}
        </div>
      ) : null}
      <nav className="document-tabs" aria-label="打开的文档">
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
                <button
                  type="button"
                  className="tab-close"
                  aria-label={`关闭 ${tabName}`}
                  title={`关闭 ${tabName}`}
                  disabled={busy}
                  onClick={() => closeDocument(tab.id)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </nav>
      <section id="editor-workspace" className="workspace" aria-label="编辑区">
        <div
          className="editor-toolbar"
          role="toolbar"
          aria-label="Markdown 插入工具"
        >
          <button
            type="button"
            aria-pressed={outlineOpen}
            onClick={() => setOutlineOpen((open) => !open)}
          >
            大纲
          </button>
          <button
            type="button"
            disabled={!recoveryReady || session.readOnly}
            onClick={() => editor.current?.insertTask()}
          >
            插入任务
          </button>
          <button
            type="button"
            disabled={!recoveryReady || session.readOnly}
            onClick={() => editor.current?.insertTable()}
          >
            插入表格
          </button>
          <span>表格内按 Tab / Shift+Tab 切换单元格</span>
        </div>
        <div className="workspace-body">
          {outlineOpen ? (
            <nav className="outline-panel" aria-label="文档大纲">
              <div className="outline-heading">
                <strong>文档大纲</strong>
                <span>{outlineItems.length} 个标题</span>
              </div>
              {outlineLoading ? (
                <p className="outline-empty" role="status">
                  正在分析标题…
                </p>
              ) : outlineItems.length === 0 ? (
                <p className="outline-empty">暂无标题</p>
              ) : (
                <ol className="outline-list">
                  {outlineItems.map((item, index) => (
                    <li key={`${item.from}:${index}`}>
                      <button
                        type="button"
                        style={{
                          paddingLeft: `${12 + (item.level - 1) * 14}px`,
                        }}
                        title={`跳转到：${item.text}`}
                        onClick={() =>
                          editor.current?.revealPosition(item.from)
                        }
                      >
                        <span aria-hidden="true">H{item.level}</span>
                        {item.text}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </nav>
          ) : null}
          <div ref={editorHost} className="editor-host" />
        </div>
      </section>
      <footer className="statusbar" aria-label="文档状态">
        <span>{session.encoding.toUpperCase()}</span>
        <span>{session.lineEnding === "\r\n" ? "CRLF" : "LF"}</span>
        <span>{session.hasFinalNewline ? "末尾换行" : "无末尾换行"}</span>
        {session.readOnly ? <span>只读</span> : null}
        <span>修订 {session.currentRevision}</span>
        <span>{editorMode === "hybrid" ? "混合模式" : "源码模式"}</span>
        <span>{settings.lineWrapping ? "自动换行" : "不换行"}</span>
      </footer>
    </main>
  );
}
