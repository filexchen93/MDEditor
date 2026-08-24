import { useEffect, useRef, useState } from "react";

import {
  createRecoverySnapshot,
  createUntitledSession,
  decodeDocument,
  encodeDocument,
  isDirty,
  recordEdit,
  recordSave,
  type DecodedDocument,
  type DocumentAdapter,
} from "@mdeditor/document-session";
import {
  createSourceEditor,
  type EditorMode,
  type SourceEditor,
} from "@mdeditor/editor-core";

import {
  loadAppSettings,
  saveAppSettings,
  type AppSettings,
} from "./settings.js";

const initialText = `# 欢迎使用 MDEditor

这是 M2 的渐进式 Markdown 编辑器。Markdown 文本仍由 CodeMirror 持有，不会复制到 React Store。

- 在源码与混合模式间无损切换
- 渐进显示标题、强调、链接、引用、列表、图片与代码
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

function getDocumentName(path: string | null): string {
  if (path === null) return "未命名";
  return path.split(/[\\/]/).at(-1) || path;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AppShell({ documentAdapter }: AppShellProps) {
  const editorDocument = useRef(initialDocument);
  const editorHost = useRef<HTMLDivElement>(null);
  const editor = useRef<SourceEditor | null>(null);
  const recoveryCheckStarted = useRef(false);
  const recoveryOperations = useRef<Promise<void>>(Promise.resolve());
  const lastRecoveryRevision = useRef(-1);
  const [editorVersion, setEditorVersion] = useState(0);
  const [session, setSession] = useState(initialDocument.session);
  const sessionRef = useRef(session);
  const [recoveryReady, setRecoveryReady] = useState(
    () => documentAdapter === undefined,
  );
  const [recentDocuments, setRecentDocuments] = useState<readonly string[]>([]);
  const [settings, setSettings] = useState(loadAppSettings);
  const [editorMode, setEditorMode] = useState<EditorMode>("source");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const documentIsDirty = isDirty(session);

  useEffect(() => {
    const parent = editorHost.current;
    if (!parent) return;

    const document = editorDocument.current;
    const sourceEditor = createSourceEditor({
      parent,
      text: document.text,
      lineSeparator: document.session.lineEnding,
      readOnly: document.session.readOnly || !recoveryReady,
      fontSize: settings.fontSize,
      lineWrapping: settings.lineWrapping,
      mode: "source",
      onTextChange: (text) => {
        setSession((current) => recordEdit(current, text));
      },
    });
    editor.current = sourceEditor;
    sourceEditor.focus();

    return () => {
      sourceEditor.destroy();
      editor.current = null;
    };
  }, [editorVersion, recoveryReady, settings]);

  useEffect(() => {
    editor.current?.setMode(editorMode);
  }, [editorMode, editorVersion, recoveryReady, settings]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  function updateSettings(next: AppSettings) {
    const text = editor.current?.getText() ?? editorDocument.current.text;
    editorDocument.current = { text, session };
    saveAppSettings(next);
    setSettings(next);
  }

  useEffect(() => {
    if (!documentAdapter || recoveryCheckStarted.current) return;
    recoveryCheckStarted.current = true;

    void (async () => {
      try {
        const snapshot = await documentAdapter.loadRecoverySnapshot();
        if (snapshot === null) return;

        const sourceName = getDocumentName(snapshot.session.path);
        const shouldRestore = window.confirm(
          `发现 ${snapshot.capturedAt} 自动保存的“${sourceName}”恢复稿。是否恢复？`,
        );
        if (!shouldRestore) {
          await documentAdapter.clearRecoverySnapshot();
          return;
        }

        // Recovery content deliberately reopens as an untitled draft. Native
        // path authorization is granted only by an explicit file dialog, so a
        // recovered webview cannot silently regain access to an old path.
        const recovered: DecodedDocument = {
          text: snapshot.text,
          session: {
            ...snapshot.session,
            id: globalThis.crypto.randomUUID(),
            path: null,
            diskFingerprint: null,
          },
        };
        editorDocument.current = recovered;
        setSession(recovered.session);
        setEditorVersion((version) => version + 1);
        setNotice(
          `已恢复“${sourceName}”的未保存内容。为保护原文件，请使用“另存为”确认保存位置。`,
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

    if (!documentIsDirty) {
      const operation = recoveryOperations.current
        .catch(() => undefined)
        .then(() => documentAdapter.clearRecoverySnapshot());
      recoveryOperations.current = operation;
      void operation.catch((error: unknown) => {
        setNotice(`清理恢复稿失败：${getErrorMessage(error)}`);
      });
      return;
    }

    const saveLatestSnapshot = () => {
      const current = sessionRef.current;
      if (
        !isDirty(current) ||
        current.currentRevision === lastRecoveryRevision.current
      ) {
        return;
      }

      const text = editor.current?.getText();
      if (text === undefined) return;

      const snapshot = createRecoverySnapshot(text, current);
      const snapshotRevision = current.currentRevision;
      lastRecoveryRevision.current = snapshotRevision;
      const operation = recoveryOperations.current
        .catch(() => undefined)
        .then(() => documentAdapter.saveRecoverySnapshot(snapshot));
      recoveryOperations.current = operation;
      void operation.catch((error: unknown) => {
        if (lastRecoveryRevision.current === snapshotRevision) {
          lastRecoveryRevision.current = -1;
        }
        setNotice(`创建恢复稿失败：${getErrorMessage(error)}`);
      });
    };

    const interval = window.setInterval(saveLatestSnapshot, 1000);

    return () => window.clearInterval(interval);
  }, [documentAdapter, documentIsDirty, recoveryReady]);

  async function openDocument(recentPath?: string) {
    if (!documentAdapter || busy) return;
    if (
      isDirty(session) &&
      !window.confirm("当前文档尚未保存。确定要放弃更改并打开其他文档吗？")
    ) {
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
      editorDocument.current = decoded;
      setSession(decoded.session);
      setEditorVersion((version) => version + 1);
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
    if (
      isDirty(session) &&
      !window.confirm("当前文档尚未保存。确定要放弃更改并新建文档吗？")
    ) {
      return;
    }

    const document: DecodedDocument = {
      text: "",
      session: createUntitledSession(globalThis.crypto.randomUUID()),
    };
    editorDocument.current = document;
    setSession(document.session);
    setEditorVersion((version) => version + 1);
    setNotice(null);
  }

  async function saveDocument(saveAs = false) {
    const sourceEditor = editor.current;
    if (!documentAdapter || !sourceEditor || busy || session.readOnly) return;

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
      setSession((current) =>
        recordSave(
          current,
          saved.diskFingerprint,
          saved.path,
          revisionBeingSaved,
        ),
      );
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

  const documentName = getDocumentName(session.path);

  return (
    <main className="app-shell">
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
            disabled={busy || !recoveryReady}
            onClick={newDocument}
          >
            新建
          </button>
          <button
            type="button"
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
            </div>
          </details>
          <button
            type="button"
            disabled={
              !documentAdapter || busy || !recoveryReady || session.readOnly
            }
            onClick={() => void saveDocument()}
          >
            保存
          </button>
          <button
            type="button"
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
      <section className="workspace" aria-label="编辑区">
        <div ref={editorHost} className="editor-host" />
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
