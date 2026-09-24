import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  createUntitledSession,
  createWorkspaceRecoverySnapshot,
  parseRecoverySnapshot,
  recordEdit,
  serializeRecoverySnapshot,
} from "@mdeditor/document-session";

const nativeMockStateKey = "mdeditor.e2e.native-mock.v1";
const redoShortcut =
  process.platform === "darwin" ? "Meta+Shift+z" : "Control+y";
const linkModifier: "Meta" | "Control" =
  process.platform === "darwin" ? "Meta" : "Control";

async function normalizeSnapshotHeight(
  page: Page,
  png: Buffer,
  expectedHeight: number,
): Promise<Buffer> {
  const actualHeight = png.readUInt32BE(20);
  if (Math.abs(actualHeight - expectedHeight) > 8) {
    throw new Error(
      `Screenshot height changed from ${expectedHeight} to ${actualHeight}`,
    );
  }
  if (actualHeight === expectedHeight) return png;

  const encoded = await page.evaluate(
    async ({ base64, height }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("Canvas 2D context unavailable");
      context.drawImage(image, 0, 0);
      return canvas.toDataURL("image/png").split(",")[1];
    },
    { base64: png.toString("base64"), height: expectedHeight },
  );
  if (encoded === undefined) throw new Error("PNG encoding failed");
  return Buffer.from(encoded, "base64");
}

async function openFileMenu(page: Page) {
  await page.locator("details.file-menu > summary").click();
}

async function clickFileAction(page: Page, name: string) {
  await openFileMenu(page);
  await page
    .locator("details.file-menu")
    .getByRole("button", { name, exact: true })
    .click();
}

interface NativeMockState {
  readonly recovery: readonly number[] | null;
  readonly savedMarkdown: readonly number[] | null;
  readonly exportedHtml: readonly number[] | null;
  readonly exportedImage: readonly number[] | null;
  readonly exportedDocx: readonly number[] | null;
  readonly exportedDocxName: string | null;
  readonly recent: readonly string[];
  readonly commands: readonly string[];
  readonly confirmationMessages: readonly string[];
}

interface NativeAdapterMockOptions {
  readonly initialRecovery?: readonly number[];
  readonly startupMarkdown?: string;
  readonly rejectConfirmation?: boolean;
  readonly confirmationResults?: readonly ("Ok" | "Cancel")[];
  readonly cancelSaveAs?: boolean;
  readonly cancelExport?: boolean;
  readonly saveDocumentFailures?: number;
  readonly failWorkspaceImageRead?: boolean;
  readonly pandocAvailable?: boolean;
}

async function installNativeAdapterMock(
  page: Page,
  options: NativeAdapterMockOptions = {},
) {
  await page.addInitScript(
    ({ stateKey, options }) => {
      interface MutableNativeMockState {
        recovery: number[] | null;
        savedMarkdown: number[] | null;
        exportedHtml: number[] | null;
        exportedImage: number[] | null;
        exportedDocx: number[] | null;
        exportedDocxName: string | null;
        recent: string[];
        commands: string[];
        confirmationMessages: string[];
      }

      const emptyState = (): MutableNativeMockState => ({
        recovery: options.initialRecovery ? [...options.initialRecovery] : null,
        savedMarkdown: null,
        exportedHtml: null,
        exportedImage: null,
        exportedDocx: null,
        exportedDocxName: null,
        recent: [],
        commands: [],
        confirmationMessages: [],
      });
      const loadState = (): MutableNativeMockState => {
        try {
          const serialized = localStorage.getItem(stateKey);
          return serialized === null
            ? emptyState()
            : (JSON.parse(serialized) as MutableNativeMockState);
        } catch {
          return emptyState();
        }
      };
      const saveState = (state: MutableNativeMockState) =>
        localStorage.setItem(stateKey, JSON.stringify(state));
      let confirmationIndex = 0;
      let saveDocumentFailuresRemaining = options.saveDocumentFailures ?? 0;
      let workspaceRevision = 0;
      const importedImageDataNames = new Map<string, number>();
      const createdWorkspaceEntries: Array<{
        relativePath: string;
        name: string;
        kind: "directory" | "file";
        bytes: number | null;
      }> = [];
      let nextCallbackId = 1;
      let nextEventListenerId = 1;
      const callbacks = new Map<number, (payload: unknown) => void>();
      const eventListeners = new Map<
        number,
        { readonly event: string; readonly handler: number }
      >();
      const runtime = globalThis as typeof globalThis & { isTauri?: boolean };
      runtime.isTauri = true;
      const workspaceRoot = "C:\\文档 仓库";
      let workspaceEntries = [
        {
          relativePath: "指南",
          name: "指南",
          kind: "directory",
          bytes: null,
        },
        {
          relativePath: "指南/开始.md",
          name: "开始.md",
          kind: "file",
          bytes: 25,
        },
        {
          relativePath: "图片",
          name: "图片",
          kind: "directory",
          bytes: null,
        },
        {
          relativePath: "图片/封面.png",
          name: "封面.png",
          kind: "file",
          bytes: 1024,
        },
      ];
      const openedWorkspace = () => ({
        root: workspaceRoot,
        name: "文档 仓库",
        entries: [
          ...workspaceEntries,
          ...(workspaceRevision === 0
            ? []
            : [
                {
                  relativePath: "外部新增.md",
                  name: "外部新增.md",
                  kind: "file" as const,
                  bytes: 18,
                },
              ]),
          ...createdWorkspaceEntries,
        ],
      });
      const allWorkspaceEntries = () => [
        ...workspaceEntries,
        ...createdWorkspaceEntries,
      ];

      const eventRuntime = window as typeof window & {
        __TAURI_EVENT_PLUGIN_INTERNALS__?: {
          unregisterListener: (event: string, eventId: number) => void;
        };
        __MDEDITOR_E2E_EMIT_WORKSPACE__?: () => void;
        __MDEDITOR_E2E_EMIT_EXTERNAL__?: (name: string, source: string) => void;
        __MDEDITOR_E2E_EMIT_IMAGE_DROP__?: (path: string) => void;
      };
      eventRuntime.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: (_event, eventId) => {
          eventListeners.delete(eventId);
        },
      };
      eventRuntime.__MDEDITOR_E2E_EMIT_WORKSPACE__ = () => {
        workspaceRevision += 1;
        for (const [id, listener] of eventListeners) {
          if (listener.event !== "workspace-changed") continue;
          callbacks.get(listener.handler)?.({
            event: listener.event,
            id,
            payload: { root: workspaceRoot },
          });
        }
      };
      eventRuntime.__MDEDITOR_E2E_EMIT_EXTERNAL__ = (name, source) => {
        for (const [id, listener] of eventListeners) {
          if (listener.event !== "external-document-opened") continue;
          callbacks.get(listener.handler)?.({
            event: listener.event,
            id,
            payload: {
              kind: "opened",
              document: {
                path: `C:\\验收\\${name}`,
                bytes: [...new TextEncoder().encode(source)],
                diskFingerprint: `mock-external-${name}`,
              },
            },
          });
        }
      };
      eventRuntime.__MDEDITOR_E2E_EMIT_IMAGE_DROP__ = (path) => {
        for (const [id, listener] of eventListeners) {
          if (listener.event !== "external-image-dropped") continue;
          callbacks.get(listener.handler)?.({
            event: listener.event,
            id,
            payload: path,
          });
        }
      };

      const tauriWindow = window as typeof window & {
        __TAURI_INTERNALS__?: {
          invoke: (command: string, payload?: unknown) => Promise<unknown>;
          transformCallback: (
            callback: (payload: unknown) => void,
            once?: boolean,
          ) => number;
        };
      };
      tauriWindow.__TAURI_INTERNALS__ = {
        transformCallback: (callback, once = false) => {
          const id = nextCallbackId++;
          callbacks.set(
            id,
            once
              ? (payload) => {
                  callbacks.delete(id);
                  callback(payload);
                }
              : callback,
          );
          return id;
        },
        invoke: (command, payload) =>
          Promise.resolve().then(() => {
            const state = loadState();
            state.commands.push(command);
            const args = (payload ?? {}) as Record<string, unknown>;

            switch (command) {
              case "plugin:app|identifier":
                saveState(state);
                return "io.github.filexchen93.mdeditor";
              case "load_recovery_snapshot":
                saveState(state);
                return state.recovery;
              case "save_recovery_snapshot":
                state.recovery = [
                  ...((args.bytes as number[] | undefined) ?? []),
                ];
                saveState(state);
                return null;
              case "clear_recovery_snapshot":
                state.recovery = null;
                saveState(state);
                return null;
              case "list_recent_documents":
                saveState(state);
                return state.recent;
              case "open_startup_documents":
                saveState(state);
                return options.startupMarkdown === undefined
                  ? []
                  : [
                      {
                        kind: "opened",
                        document: {
                          path: "C:\\验收\\启动.md",
                          bytes: [
                            ...new TextEncoder().encode(
                              options.startupMarkdown,
                            ),
                          ],
                          diskFingerprint: "mock-startup",
                        },
                      },
                    ];
              case "plugin:event|listen": {
                const eventId = nextEventListenerId++;
                eventListeners.set(eventId, {
                  event: args.event as string,
                  handler: args.handler as number,
                });
                saveState(state);
                return eventId;
              }
              case "plugin:event|unlisten":
                eventListeners.delete(args.eventId as number);
                saveState(state);
                return null;
              case "open_workspace":
              case "refresh_workspace":
                saveState(state);
                return openedWorkspace();
              case "close_workspace":
                saveState(state);
                return null;
              case "open_workspace_document": {
                const relativePath = args.relativePath as string;
                if (relativePath !== "指南/开始.md") {
                  throw new Error(`Unexpected workspace file: ${relativePath}`);
                }
                const path = `${workspaceRoot}\\指南\\开始.md`;
                const bytes = [
                  ...new TextEncoder().encode("# 工作区文档\n\n来自嵌套目录。"),
                ];
                state.recent = [path];
                saveState(state);
                return {
                  path,
                  bytes,
                  diskFingerprint: "mock-workspace-fingerprint",
                };
              }
              case "open_workspace_link": {
                const target = args.target as string;
                if (target !== "../README.md#目标") {
                  throw new Error(`Unexpected workspace link: ${target}`);
                }
                const path = `${workspaceRoot}\\README.md`;
                state.recent = [path];
                saveState(state);
                return {
                  document: {
                    path,
                    bytes: [...new TextEncoder().encode("# 目标\n\n链接目标")],
                    diskFingerprint: "mock-linked-fingerprint",
                  },
                  relativePath: "README.md",
                  fragment: "目标",
                };
              }
              case "plugin:opener|open_url":
                saveState(state);
                return null;
              case "import_workspace_image": {
                createdWorkspaceEntries.push(
                  {
                    relativePath: "assets",
                    name: "assets",
                    kind: "directory",
                    bytes: null,
                  },
                  {
                    relativePath: "assets/封面 (终稿).png",
                    name: "封面 (终稿).png",
                    kind: "file",
                    bytes: 4096,
                  },
                );
                saveState(state);
                return {
                  relativePath: "assets/封面 (终稿).png",
                  markdownPath:
                    "../assets/%E5%B0%81%E9%9D%A2%20%28%E7%BB%88%E7%A8%BF%29.png",
                  suggestedAlt: "封面 (终稿)",
                };
              }
              case "import_document_image":
              case "import_dropped_document_image":
              case "import_document_image_data":
                saveState(state);
                return {
                  relativePath: "assets/本地图.png",
                  markdownPath: "assets/%E6%9C%AC%E5%9C%B0%E5%9B%BE.png",
                  suggestedAlt: "本地图",
                };
              case "read_document_image":
                saveState(state);
                return {
                  dataUrl:
                    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                };
              case "read_workspace_image":
                saveState(state);
                if (options.failWorkspaceImageRead) {
                  throw new Error("工作区图片无法读取");
                }
                return {
                  dataUrl:
                    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                };
              case "inspect_workspace_images":
                saveState(state);
                return {
                  issues: [
                    {
                      documentRelativePath: "指南/开始.md",
                      line: 3,
                      column: 5,
                      target: "../assets/缺失 图.png",
                      reason: "无法读取工作区文件",
                    },
                  ],
                  truncated: false,
                };
              case "preview_workspace_image_consolidation":
                saveState(state);
                return {
                  copies: [
                    {
                      sourceRelativePath: "图片/封面.png",
                      destinationRelativePath: "assets/封面.png",
                      referenceCount: 1,
                    },
                  ],
                  updates: [
                    {
                      documentRelativePath: "指南/开始.md",
                      line: 4,
                      column: 7,
                      fromTarget: "../图片/封面.png",
                      toTarget: "../assets/封面.png",
                    },
                  ],
                  truncated: false,
                };
              case "consolidate_workspace_images":
                if (
                  !allWorkspaceEntries().some(
                    (entry) => entry.relativePath === "assets",
                  )
                ) {
                  createdWorkspaceEntries.push({
                    relativePath: "assets",
                    name: "assets",
                    kind: "directory",
                    bytes: null,
                  });
                }
                createdWorkspaceEntries.push({
                  relativePath: "assets/封面.png",
                  name: "封面.png",
                  kind: "file",
                  bytes: 1024,
                });
                saveState(state);
                return ["指南/开始.md"];
              case "inspect_workspace_image_references":
                saveState(state);
                return {
                  references: [
                    {
                      documentRelativePath: "指南/开始.md",
                      line: 4,
                      column: 7,
                      target: "../图片/封面.png",
                    },
                  ],
                  truncated: false,
                };
              case "import_workspace_image_data": {
                const requestedName = args.fileName as string;
                const dot = requestedName.lastIndexOf(".");
                const stem =
                  dot > 0 ? requestedName.slice(0, dot) : requestedName;
                const extension =
                  dot > 0 ? requestedName.slice(dot + 1).toLowerCase() : "png";
                const collisionKey = requestedName.toLocaleLowerCase();
                const collision =
                  (importedImageDataNames.get(collisionKey) ?? 0) + 1;
                importedImageDataNames.set(collisionKey, collision);
                const importedName = `${stem}${collision === 1 ? "" : `-${collision}`}.${extension}`;
                if (
                  !allWorkspaceEntries().some(
                    (entry) => entry.relativePath === "assets",
                  )
                ) {
                  createdWorkspaceEntries.push({
                    relativePath: "assets",
                    name: "assets",
                    kind: "directory",
                    bytes: null,
                  });
                }
                createdWorkspaceEntries.push({
                  relativePath: `assets/${importedName}`,
                  name: importedName,
                  kind: "file",
                  bytes: (args.bytes as number[]).length,
                });
                saveState(state);
                return {
                  relativePath: `assets/${importedName}`,
                  markdownPath: `../assets/${encodeURIComponent(importedName)}`,
                  suggestedAlt: stem,
                };
              }
              case "create_workspace_directory": {
                const relativePath = args.relativePath as string;
                if (
                  allWorkspaceEntries().some(
                    (entry) => entry.relativePath === relativePath,
                  )
                ) {
                  throw new Error("工作区目标已存在，不会覆盖");
                }
                createdWorkspaceEntries.push({
                  relativePath,
                  name: relativePath.split("/").at(-1) ?? relativePath,
                  kind: "directory",
                  bytes: null,
                });
                saveState(state);
                return null;
              }
              case "create_workspace_file": {
                const relativePath = args.relativePath as string;
                if (
                  allWorkspaceEntries().some(
                    (entry) => entry.relativePath === relativePath,
                  )
                ) {
                  throw new Error("工作区目标已存在，不会覆盖");
                }
                if (!relativePath.toLocaleLowerCase().endsWith(".md")) {
                  throw new Error("新建文档必须使用 Markdown 扩展名");
                }
                createdWorkspaceEntries.push({
                  relativePath,
                  name: relativePath.split("/").at(-1) ?? relativePath,
                  kind: "file",
                  bytes: 0,
                });
                const path = `${workspaceRoot}\\${relativePath.replaceAll("/", "\\")}`;
                state.recent = [path];
                saveState(state);
                return {
                  path,
                  bytes: [],
                  diskFingerprint: "mock-created-workspace-fingerprint",
                };
              }
              case "preview_workspace_image_move": {
                const sourceRelativePath = args.sourceRelativePath as string;
                const destinationRelativePath =
                  args.destinationRelativePath as string;
                if (sourceRelativePath !== "图片/封面.png") {
                  throw new Error("工作区图片不存在");
                }
                saveState(state);
                return {
                  updates: [
                    {
                      documentRelativePath: "指南/开始.md",
                      line: 4,
                      column: 7,
                      fromTarget: "../图片/封面.png",
                      toTarget: `../${destinationRelativePath}`,
                    },
                  ],
                  truncated: false,
                };
              }
              case "move_workspace_image_with_references": {
                const sourceRelativePath = args.sourceRelativePath as string;
                const destinationRelativePath =
                  args.destinationRelativePath as string;
                const image = workspaceEntries.find(
                  (entry) => entry.relativePath === sourceRelativePath,
                );
                if (image === undefined) throw new Error("工作区图片不存在");
                image.relativePath = destinationRelativePath;
                image.name =
                  destinationRelativePath.split("/").at(-1) ?? image.name;
                saveState(state);
                return ["指南/开始.md"];
              }
              case "copy_workspace_image_with_references": {
                const sourceRelativePath = args.sourceRelativePath as string;
                const destinationRelativePath =
                  args.destinationRelativePath as string;
                const image = workspaceEntries.find(
                  (entry) => entry.relativePath === sourceRelativePath,
                );
                if (image === undefined) throw new Error("工作区图片不存在");
                workspaceEntries.push({
                  relativePath: destinationRelativePath,
                  name: destinationRelativePath.split("/").at(-1) ?? image.name,
                  kind: "file",
                  bytes: image.bytes,
                });
                saveState(state);
                return ["指南/开始.md"];
              }
              case "preview_workspace_document_move": {
                const destinationRelativePath =
                  args.destinationRelativePath as string;
                saveState(state);
                return {
                  updates:
                    destinationRelativePath === "图片/开始.md"
                      ? [
                          {
                            documentRelativePath: "指南/开始.md",
                            line: 4,
                            column: 7,
                            fromTarget: "../图片/封面.png",
                            toTarget: "封面.png",
                          },
                        ]
                      : destinationRelativePath === "归档/指南"
                        ? [
                            {
                              documentRelativePath: "指南/开始.md",
                              line: 4,
                              column: 7,
                              fromTarget: "../图片/封面.png",
                              toTarget: "../../图片/封面.png",
                            },
                          ]
                        : [],
                  truncated: false,
                };
              }
              case "move_workspace_document_with_links": {
                const sourceRelativePath = args.sourceRelativePath as string;
                const destinationRelativePath =
                  args.destinationRelativePath as string;
                const affected = workspaceEntries.filter(
                  (entry) =>
                    entry.relativePath === sourceRelativePath ||
                    entry.relativePath.startsWith(`${sourceRelativePath}/`),
                );
                if (affected.length === 0) throw new Error("工作区文档不存在");
                for (const entry of affected) {
                  entry.relativePath = `${destinationRelativePath}${entry.relativePath.slice(sourceRelativePath.length)}`;
                  entry.name =
                    entry.relativePath.split("/").at(-1) ?? entry.name;
                }
                saveState(state);
                return affected
                  .filter((entry) => entry.kind === "file")
                  .map((entry) => entry.relativePath);
              }
              case "move_workspace_entry": {
                const sourceRelativePath = args.sourceRelativePath as string;
                const destinationRelativePath =
                  args.destinationRelativePath as string;
                const affected = allWorkspaceEntries().filter(
                  (entry) =>
                    entry.relativePath === sourceRelativePath ||
                    entry.relativePath.startsWith(`${sourceRelativePath}/`),
                );
                if (affected.length === 0) {
                  throw new Error("工作区移动源不存在");
                }
                if (
                  allWorkspaceEntries().some(
                    (entry) =>
                      !affected.includes(entry) &&
                      (entry.relativePath === destinationRelativePath ||
                        entry.relativePath.startsWith(
                          `${destinationRelativePath}/`,
                        )),
                  )
                ) {
                  throw new Error("工作区目标已存在，不会覆盖");
                }
                const relocations: Array<{
                  fromPath: string;
                  toPath: string;
                }> = [];
                for (const entry of affected) {
                  const oldRelativePath = entry.relativePath;
                  entry.relativePath = `${destinationRelativePath}${oldRelativePath.slice(sourceRelativePath.length)}`;
                  entry.name =
                    entry.relativePath.split("/").at(-1) ?? entry.name;
                  if (entry.kind === "file") {
                    relocations.push({
                      fromPath: `${workspaceRoot}\\${oldRelativePath.replaceAll("/", "\\")}`,
                      toPath: `${workspaceRoot}\\${entry.relativePath.replaceAll("/", "\\")}`,
                    });
                  }
                }
                state.recent = state.recent.map(
                  (path) =>
                    relocations.find(
                      (relocation) => relocation.fromPath === path,
                    )?.toPath ?? path,
                );
                saveState(state);
                return relocations;
              }
              case "copy_workspace_entry": {
                const sourceRelativePath = args.sourceRelativePath as string;
                const destinationRelativePath =
                  args.destinationRelativePath as string;
                const affected = allWorkspaceEntries().filter(
                  (entry) =>
                    entry.relativePath === sourceRelativePath ||
                    entry.relativePath.startsWith(`${sourceRelativePath}/`),
                );
                if (affected.length === 0) {
                  throw new Error("工作区复制源不存在");
                }
                if (
                  allWorkspaceEntries().some(
                    (entry) => entry.relativePath === destinationRelativePath,
                  )
                ) {
                  throw new Error("工作区目标已存在，不会覆盖");
                }
                createdWorkspaceEntries.push(
                  ...affected.map((entry) => {
                    const relativePath = `${destinationRelativePath}${entry.relativePath.slice(sourceRelativePath.length)}`;
                    return {
                      ...entry,
                      relativePath,
                      name: relativePath.split("/").at(-1) ?? entry.name,
                    };
                  }),
                );
                saveState(state);
                return null;
              }
              case "start_workspace_search": {
                const requestId = args.requestId as string;
                const query = args.query as string;
                const emitSearch = (payload: unknown) => {
                  for (const [id, listener] of eventListeners) {
                    if (listener.event !== "workspace-search") continue;
                    callbacks.get(listener.handler)?.({
                      event: listener.event,
                      id,
                      payload,
                    });
                  }
                };
                saveState(state);
                if (query === "[") {
                  emitSearch({
                    kind: "error",
                    requestId,
                    message: "正则表达式无效",
                  });
                  return null;
                }
                emitSearch({
                  kind: "batch",
                  requestId,
                  matches: [
                    {
                      relativePath: "指南/开始.md",
                      line: 3,
                      column: 1,
                      preview: `${query} 位于工作区文档`,
                    },
                  ],
                });
                if (query !== "slow") {
                  emitSearch({ kind: "complete", requestId, truncated: false });
                }
                return null;
              }
              case "cancel_workspace_search": {
                const requestId = args.requestId as string;
                saveState(state);
                for (const [id, listener] of eventListeners) {
                  if (listener.event !== "workspace-search") continue;
                  callbacks.get(listener.handler)?.({
                    event: listener.event,
                    id,
                    payload: { kind: "cancelled", requestId },
                  });
                }
                return null;
              }
              case "release_document_authorization":
                saveState(state);
                return null;
              case "delete_workspace_entry": {
                const relativePath = args.relativePath as string;
                const isDeleted = (candidate: string) =>
                  candidate === relativePath ||
                  candidate.startsWith(`${relativePath}/`);
                if (
                  !allWorkspaceEntries().some((entry) =>
                    isDeleted(entry.relativePath),
                  )
                ) {
                  throw new Error("工作区删除源不存在");
                }
                workspaceEntries = workspaceEntries.filter(
                  (entry) => !isDeleted(entry.relativePath),
                );
                const retainedCreated = createdWorkspaceEntries.filter(
                  (entry) => !isDeleted(entry.relativePath),
                );
                createdWorkspaceEntries.splice(
                  0,
                  createdWorkspaceEntries.length,
                  ...retainedCreated,
                );
                const deletedPath = `${workspaceRoot}\\${relativePath.replaceAll("/", "\\")}`;
                state.recent = state.recent.filter(
                  (path) =>
                    path !== deletedPath &&
                    !path.startsWith(`${deletedPath}\\`),
                );
                saveState(state);
                return null;
              }
              case "delete_workspace_image": {
                const relativePath = args.relativePath as string;
                const index = workspaceEntries.findIndex(
                  (entry) => entry.relativePath === relativePath,
                );
                if (index < 0) throw new Error("工作区图片不存在");
                workspaceEntries.splice(index, 1);
                saveState(state);
                return null;
              }
              case "plugin:dialog|message":
                state.confirmationMessages.push(
                  typeof args.message === "string" ? args.message : "",
                );
                saveState(state);
                if (options.rejectConfirmation) {
                  throw new Error("mock confirmation unavailable");
                }
                return (
                  options.confirmationResults?.[
                    Math.min(
                      confirmationIndex++,
                      options.confirmationResults.length - 1,
                    )
                  ] ?? "Ok"
                );
              case "save_document_as": {
                if (options.cancelSaveAs) {
                  saveState(state);
                  return null;
                }
                const request = args.request as {
                  readonly bytes: number[];
                };
                const path = "C:\\验收\\M4验收.md";
                state.savedMarkdown = [...request.bytes];
                state.recent = [path];
                saveState(state);
                return { path, diskFingerprint: "mock-fingerprint-1" };
              }
              case "save_document": {
                if (saveDocumentFailuresRemaining > 0) {
                  saveDocumentFailuresRemaining -= 1;
                  saveState(state);
                  throw new Error("文件已在外部修改");
                }
                const request = args.request as {
                  readonly bytes: number[];
                  readonly path: string;
                };
                state.savedMarkdown = [...request.bytes];
                state.recent = [request.path];
                saveState(state);
                return {
                  path: request.path,
                  diskFingerprint: "mock-fingerprint-2",
                };
              }
              case "export_html": {
                if (options.cancelExport) {
                  saveState(state);
                  return null;
                }
                const request = args.request as {
                  readonly bytes: number[];
                };
                state.exportedHtml = [...request.bytes];
                saveState(state);
                return "C:\\验收\\M4验收.html";
              }
              case "export_image": {
                const request = args.request as {
                  readonly bytes: number[];
                };
                state.exportedImage = [...request.bytes];
                saveState(state);
                return "C:\\验收\\M4验收.png";
              }
              case "get_pandoc_status":
                saveState(state);
                return {
                  available: options.pandocAvailable !== false,
                  version:
                    options.pandocAvailable === false ? null : "pandoc 3.8",
                  installUrl: "https://pandoc.org/installing.html",
                };
              case "export_docx": {
                const request = args.request as {
                  readonly bytes: number[];
                  readonly suggestedName: string;
                };
                state.exportedDocx = [...request.bytes];
                state.exportedDocxName = request.suggestedName;
                saveState(state);
                return "C:\\验收\\M4验收.docx";
              }
              default:
                throw new Error(`Unexpected native command: ${command}`);
            }
          }),
      };
    },
    { stateKey: nativeMockStateKey, options },
  );
}

async function readNativeMockState(page: Page): Promise<NativeMockState> {
  return page.evaluate((stateKey) => {
    const serialized = localStorage.getItem(stateKey);
    if (serialized === null) throw new Error("Native mock state is missing");
    return JSON.parse(serialized) as NativeMockState;
  }, nativeMockStateKey);
}

async function readEditorSource(editor: Locator) {
  return editor.evaluate((element) => {
    const content = element.classList.contains("cm-content")
      ? element
      : element.querySelector(".cm-content");
    const rows = content === null ? [] : [...content.children];
    return rows
      .map((row) => {
        const block = row.querySelector<HTMLElement>("[data-md-source-block]");
        if (block !== null) return block.dataset.mdSourceBlock ?? "";
        if (row.querySelector("[data-md-source-continuation]") !== null) {
          return null;
        }
        if (!row.classList.contains("cm-line")) return null;

        const sourceLine = row.cloneNode(true) as HTMLElement;
        sourceLine
          .querySelectorAll<HTMLInputElement>("[data-md-task-checkbox]")
          .forEach((checkbox) => {
            checkbox.replaceWith(
              document.createTextNode(checkbox.checked ? "[x]" : "[ ]"),
            );
          });
        sourceLine
          .querySelectorAll<HTMLElement>("[data-md-source-mark]")
          .forEach((mark) => {
            mark.textContent = mark.dataset.mdSourceMark ?? "";
          });
        sourceLine
          .querySelectorAll<HTMLElement>("[data-md-source-inline]")
          .forEach((preview) => {
            preview.textContent = preview.dataset.mdSourceInline ?? "";
          });
        sourceLine
          .querySelectorAll(
            ".cm-placeholder, .cm-widgetBuffer, .cm-md-image-widget:not([data-md-source-inline]), .cm-md-complex-widget:not([data-md-source-inline])",
          )
          .forEach((widget) => widget.remove());
        return sourceLine.textContent ?? "";
      })
      .filter((row): row is string => row !== null)
      .join("\n");
  });
}

async function clickMoreFormat(page: Page, name: string) {
  const directAction = page
    .locator(".editor-toolbar > button")
    .and(page.getByRole("button", { name, exact: true }));
  if (await directAction.isVisible()) {
    await directAction.click();
    return;
  }
  await page.locator("details.format-menu > summary").click();
  await page
    .locator("details.format-menu .format-panel")
    .getByRole("button", { name, exact: true })
    .click();
}

test("recovery confirmation failures preserve the native snapshot", async ({
  page,
}) => {
  const recoveredText = "# 必须保留的恢复稿\n\n中文内容🙂";
  const recoveredSession = recordEdit(
    createUntitledSession("recovery-confirmation-failure"),
    recoveredText,
  );
  const snapshot = createWorkspaceRecoverySnapshot(
    [{ text: recoveredText, session: recoveredSession }],
    recoveredSession.id,
  );
  const recoveryBytes = [...serializeRecoverySnapshot(snapshot)];
  await installNativeAdapterMock(page, {
    initialRecovery: recoveryBytes,
    rejectConfirmation: true,
  });

  await page.goto("/");
  await expect(page.locator(".document-notice")).toContainText(
    "读取恢复稿失败：mock confirmation unavailable",
  );

  const nativeState = await readNativeMockState(page);
  expect(nativeState.commands).toContain("load_recovery_snapshot");
  expect(nativeState.commands).toContain("plugin:dialog|message");
  expect(nativeState.commands).not.toContain("clear_recovery_snapshot");
  expect(nativeState.commands).not.toContain("save_recovery_snapshot");
  expect(nativeState.recovery).toEqual(recoveryBytes);
});

test("native dirty close awaits asynchronous cancel and confirm results", async ({
  page,
}) => {
  await installNativeAdapterMock(page, {
    confirmationResults: ["Cancel", "Ok"],
  });
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await page.keyboard.insertText("native async close guard");

  const closeButton = page.getByRole("button", { name: "关闭 未命名 1" });
  await closeButton.click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect
    .poll(() => readEditorSource(editor))
    .toContain("native async close guard");

  await closeButton.click();
  await expect.poll(() => readEditorSource(editor)).toBe("");
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("未打开文件", { exact: true })).toBeVisible();

  const nativeState = await readNativeMockState(page);
  expect(
    nativeState.commands.filter(
      (command) => command === "plugin:dialog|message",
    ),
  ).toHaveLength(2);
});

test("native save-as and export cancellation preserve the dirty source", async ({
  page,
}) => {
  await installNativeAdapterMock(page, {
    cancelSaveAs: true,
    cancelExport: true,
  });
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = "# 取消对话框\n\n未保存内容🙂";
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);

  await openFileMenu(page);
  const saveAs = page.locator(
    'details.file-menu button[data-shortcut-action="saveDocumentAs"]',
  );
  await saveAs.click();
  await expect(saveAs).toBeEnabled();
  await expect(page.getByText("未命名 · 未保存")).toBeVisible();
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  await page.getByText("导出", { exact: true }).click();
  const exportHtml = page.getByRole("button", {
    name: "导出带样式 HTML",
  });
  await exportHtml.click();
  await expect(exportHtml).toBeEnabled();
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  const nativeState = await readNativeMockState(page);
  expect(nativeState.savedMarkdown).toBeNull();
  expect(nativeState.exportedHtml).toBeNull();
  expect(nativeState.commands).toEqual(
    expect.arrayContaining(["save_document_as", "export_html"]),
  );
});

test("authorized folder workspace filters, refreshes, and opens nested Markdown", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");

  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });
  await expect(workspace).toBeVisible();
  await expect(workspace.getByText("文档 仓库", { exact: true })).toBeVisible();
  await expect(workspace.getByText("4 个条目", { exact: true })).toBeVisible();
  await expect(workspace.getByText("指南", { exact: true })).toBeVisible();
  await expect(
    workspace.getByRole("button", { name: "封面.png", exact: true }),
  ).toBeDisabled();

  const filter = workspace.getByRole("searchbox", {
    name: "筛选工作区文件",
  });
  await filter.fill("开始");
  await expect(workspace.getByRole("treeitem")).toHaveCount(1);
  await expect(
    workspace.getByRole("button", { name: "开始.md", exact: true }),
  ).toBeVisible();
  await filter.fill("");

  await page.evaluate(() => {
    const runtime = window as typeof window & {
      __MDEDITOR_E2E_EMIT_WORKSPACE__?: () => void;
    };
    runtime.__MDEDITOR_E2E_EMIT_WORKSPACE__?.();
  });
  await expect(workspace.getByText("5 个条目", { exact: true })).toBeVisible();
  await expect(
    workspace.getByRole("button", { name: "外部新增.md", exact: true }),
  ).toBeVisible();

  await workspace.getByRole("button", { name: "开始.md", exact: true }).click();
  await expect(page.getByRole("tab", { name: /开始\.md/ })).toBeVisible();
  await expect
    .poll(() =>
      readEditorSource(
        page.getByRole("textbox", { name: "Markdown 源码编辑器" }),
      ),
    )
    .toBe("# 工作区文档\n\n来自嵌套目录。");

  await workspace.getByRole("button", { name: "刷新" }).click();
  await expect(page.locator(".document-notice")).toContainText(
    "已刷新工作区，共 5 个条目。",
  );
  await workspace.getByRole("button", { name: "关闭" }).click();
  await expect(workspace).toBeHidden();

  const nativeState = await readNativeMockState(page);
  expect(nativeState.commands).toEqual(
    expect.arrayContaining([
      "open_workspace",
      "plugin:event|listen",
      "open_workspace_document",
      "refresh_workspace",
      "close_workspace",
      "plugin:event|unlisten",
    ]),
  );
  expect(
    nativeState.commands.filter((command) => command === "refresh_workspace"),
  ).toHaveLength(2);
});

test("workspace image import copies an asset and inserts a portable relative reference", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });
  await workspace.getByRole("button", { name: "开始.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\n");

  await workspace.getByRole("button", { name: "导入图片" }).click();

  await expect
    .poll(() => readEditorSource(editor))
    .toContain(
      "![封面 (终稿)](../assets/%E5%B0%81%E9%9D%A2%20%28%E7%BB%88%E7%A8%BF%29.png)",
    );
  await expect(workspace.getByText("6 个条目", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "已导入图片：assets/封面 (终稿).png",
  );
  await page.getByRole("radio", { name: "混合" }).click();
  await expect(page.locator(".cm-md-image-widget img")).toBeVisible();

  const sourceBeforeExport = await readEditorSource(editor);
  await page.getByText("导出", { exact: true }).click();
  await page.getByRole("button", { name: "导出带样式 HTML" }).click();
  await expect(page.getByRole("status")).toContainText("HTML 已导出");

  const nativeState = await readNativeMockState(page);
  const exportedHtml = new TextDecoder().decode(
    Uint8Array.from(nativeState.exportedHtml ?? []),
  );
  expect(exportedHtml).toContain(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  );
  expect(exportedHtml).not.toContain(
    "../assets/%E5%B0%81%E9%9D%A2%20%28%E7%BB%88%E7%A8%BF%29.png",
  );
  await expect.poll(() => readEditorSource(editor)).toBe(sourceBeforeExport);
  expect(nativeState.commands).toEqual(
    expect.arrayContaining([
      "import_workspace_image",
      "read_workspace_image",
      "export_html",
    ]),
  );
});

test("HTML export fails closed when an authorized local image cannot be embedded", async ({
  page,
}) => {
  await installNativeAdapterMock(page, { failWorkspaceImageRead: true });
  await page.goto("/");
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });
  await workspace.getByRole("button", { name: "开始.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = "# 图片导出\n\n![封面](../图片/封面.png)";
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);

  await page.getByText("导出", { exact: true }).click();
  await page.getByRole("button", { name: "导出带样式 HTML" }).click();

  await expect(page.getByRole("status")).toContainText(
    "HTML 导出失败：工作区图片无法读取",
  );
  await expect.poll(() => readEditorSource(editor)).toBe(source);
  const nativeState = await readNativeMockState(page);
  expect(nativeState.exportedHtml).toBeNull();
  expect(nativeState.commands).toContain("read_workspace_image");
  expect(nativeState.commands).not.toContain("export_html");
});

test("HTML export fails closed when a Mermaid diagram cannot be rendered", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = "```mermaid\nnot a diagram\n```";
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);

  await page.getByText("导出", { exact: true }).click();
  await page.getByRole("button", { name: "导出带样式 HTML" }).click();

  await expect(page.locator(".document-notice")).toContainText("HTML 导出失败");
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});

test("HTML export fails closed when a KaTeX expression cannot be rendered", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = "Invalid math $\\notARealCommand{$ remains editable.";
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);

  await page.getByText("导出", { exact: true }).click();
  await page.getByRole("button", { name: "导出带样式 HTML" }).click();

  await expect(page.locator(".document-notice")).toContainText("HTML 导出失败");
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});

test("PNG export rasterizes the safe benchmark at the selected scale", async ({
  page,
}) => {
  const source = await readFile(
    new URL("../fixtures/m6-output-benchmark.md", import.meta.url),
    "utf8",
  );
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);

  await page.getByText("导出", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "图片导出清晰度" })
    .selectOption("2");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 PNG 图片" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("未命名.png");
  const downloadPath = await download.path();
  if (downloadPath === null) throw new Error("PNG download has no local path");
  const png = await readFile(downloadPath);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.readUInt32BE(16)).toBe(1720);
  expect(png.readUInt32BE(20)).toBeGreaterThan(1_000);
  if (process.platform === "win32") {
    const normalized = await normalizeSnapshotHeight(page, png, 2962);
    expect(normalized).toMatchSnapshot("m6-benchmark-png-export.png", {
      maxDiffPixelRatio: 0.02,
    });
  }
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});

test("PNG export rejects remote images without changing source", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = "# Remote image\n\n![remote](https://example.com/image.png)";
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);

  await page.getByText("导出", { exact: true }).click();
  await page.getByRole("button", { name: "导出 PNG 图片" }).click();

  await expect(page.getByRole("status")).toContainText(
    "PNG 导出失败：图片导出不加载远程图片",
  );
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});

test("optional Pandoc export receives only offline sanitized HTML", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = "# DOCX 验收\n\n公式 $x^2$ 与 **安全正文**。";
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);

  await page.getByText("导出", { exact: true }).click();
  await page.getByRole("button", { name: "导出 DOCX（Pandoc）" }).click();
  await expect(page.getByRole("status")).toContainText(
    "DOCX 已导出：C:\\验收\\M4验收.docx",
  );

  let state = await readNativeMockState(page);
  const html = new TextDecoder().decode(
    Uint8Array.from(state.exportedDocx ?? []),
  );
  expect(state.exportedDocxName).toBe("未命名.docx");
  expect(html).toContain("<!doctype html>");
  expect(html).toContain("<math");
  expect(html).toContain("安全正文");
  expect(html).not.toContain("<style");
  expect(html).not.toContain("<script");
  expect(state.commands).toEqual(
    expect.arrayContaining(["get_pandoc_status", "export_docx"]),
  );
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  const remoteSource =
    "# Remote DOCX\n\n![remote](https://example.com/image.png)";
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(remoteSource);
  await page.getByText("导出", { exact: true }).click();
  await page.getByRole("button", { name: "导出 DOCX（Pandoc）" }).click();
  await expect(page.getByRole("status")).toContainText(
    "DOCX 导出失败：DOCX 导出不读取本地或远程图片",
  );
  state = await readNativeMockState(page);
  expect(
    state.commands.filter((command) => command === "export_docx"),
  ).toHaveLength(1);
  await expect.poll(() => readEditorSource(editor)).toBe(remoteSource);
});

test("missing Pandoc shows official installation guidance without exporting", async ({
  page,
}) => {
  await installNativeAdapterMock(page, { pandocAvailable: false });
  await page.goto("/");
  await page.getByText("导出", { exact: true }).click();
  await page.getByRole("button", { name: "导出 DOCX（Pandoc）" }).click();
  await expect(page.getByRole("status")).toContainText("未检测到 Pandoc");
  await page.getByRole("button", { name: "查看 Pandoc 安装说明" }).click();

  const state = await readNativeMockState(page);
  expect(state.exportedDocx).toBeNull();
  expect(state.commands).toContain("get_pandoc_status");
  expect(state.commands).not.toContain("export_docx");
  expect(state.commands).toContain("plugin:opener|open_url");
});

test("clipboard paste and file drop import image bytes through the workspace boundary", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });
  await workspace.getByRole("button", { name: "开始.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.press("ControlOrMeta+End");

  await editor.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(
        [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
        "剪贴 图.PNG",
        {
          type: "image/png",
        },
      ),
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  });
  await expect(page.getByRole("status")).toContainText("已导入 1 张图片");

  await editor.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(
        [new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80])],
        "拖放.webp",
        { type: "image/webp" },
      ),
    );
    element.dispatchEvent(
      new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
    element.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  await expect(page.getByRole("status")).toContainText("已导入 1 张图片");
  await expect
    .poll(() => readEditorSource(editor))
    .toContain("![剪贴 图](../assets/%E5%89%AA%E8%B4%B4%20%E5%9B%BE.png)");
  await expect
    .poll(() => readEditorSource(editor))
    .toContain("![拖放](../assets/%E6%8B%96%E6%94%BE.webp)");
  await expect(workspace.getByText("7 个条目", { exact: true })).toBeVisible();

  const nativeState = await readNativeMockState(page);
  expect(
    nativeState.commands.filter(
      (command) => command === "import_workspace_image_data",
    ),
  ).toHaveLength(2);
});

test("workspace image inspection reports broken references and opens their source location", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });

  await workspace.getByRole("button", { name: "检查图片" }).click();
  const results = workspace.getByRole("region", { name: "图片引用检查结果" });
  await expect(results).toContainText("1 个图片引用问题");
  const issue = results.getByRole("button", {
    name: /指南\/开始\.md:3:5/,
  });
  await expect(issue).toContainText("../assets/缺失 图.png");
  await issue.click();

  await expect(page.getByRole("tab", { name: /开始\.md/ })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Markdown 源码编辑器" }),
  ).toBeFocused();
  const nativeState = await readNativeMockState(page);
  expect(nativeState.commands).toEqual(
    expect.arrayContaining([
      "inspect_workspace_images",
      "open_workspace_document",
    ]),
  );
});

test("workspace image consolidation previews copies and switches all references", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });

  await workspace.getByRole("button", { name: "归拢图片" }).click();
  await expect(
    workspace.getByRole("textbox", { name: "图片归拢目录" }),
  ).toHaveValue("assets");
  await workspace.getByRole("button", { name: "预览并归拢" }).click();

  await expect(workspace.getByTitle("assets", { exact: true })).toBeVisible();
  await expect(workspace.getByTitle(/^assets\/封面\.png/)).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "已归拢 1 张图片，并切换 1 个引用",
  );
  const nativeState = await readNativeMockState(page);
  expect(nativeState.confirmationMessages.at(-1)).toContain(
    "将复制 1 张图片到“assets”",
  );
  expect(nativeState.confirmationMessages.at(-1)).toContain(
    "图片/封面.png → assets/封面.png（1 处引用）",
  );
  expect(nativeState.commands).toEqual(
    expect.arrayContaining([
      "preview_workspace_image_consolidation",
      "consolidate_workspace_images",
      "refresh_workspace",
    ]),
  );
});

test("image move previews and confirms repository reference rewrites", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });

  await workspace.getByRole("button", { name: "管理 封面.png" }).click();
  await workspace
    .getByRole("textbox", { name: "目标相对路径" })
    .fill("图片/归档.png");
  await workspace.getByRole("button", { name: "移动 / 重命名" }).click();

  await expect(workspace.getByText("归档.png", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("并更新 1 个图片引用");
  const nativeState = await readNativeMockState(page);
  expect(nativeState.confirmationMessages.at(-1)).toContain(
    "1 个文档中的 1 个引用",
  );
  expect(nativeState.confirmationMessages.at(-1)).toContain("指南/开始.md:4:7");
  expect(nativeState.confirmationMessages.at(-1)).toContain(
    "../图片/封面.png → ../图片/归档.png",
  );
  expect(nativeState.commands).toEqual(
    expect.arrayContaining([
      "preview_workspace_image_move",
      "move_workspace_image_with_references",
      "refresh_workspace",
    ]),
  );
  expect(nativeState.commands).not.toContain("move_workspace_entry");
});

test("image copy can preserve the source and switch confirmed references", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });

  await workspace.getByRole("button", { name: "管理 封面.png" }).click();
  await workspace
    .getByRole("textbox", { name: "目标相对路径" })
    .fill("图片/副本.png");
  await workspace.getByRole("button", { name: "复制并切换引用" }).click();

  await expect(workspace.getByText("封面.png", { exact: true })).toBeVisible();
  await expect(workspace.getByText("副本.png", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("并切换 1 个图片引用");
  const nativeState = await readNativeMockState(page);
  expect(nativeState.confirmationMessages.at(-1)).toContain(
    "复制图片将切换 1 个文档中的 1 个引用",
  );
  expect(nativeState.commands).toEqual(
    expect.arrayContaining([
      "preview_workspace_image_move",
      "copy_workspace_image_with_references",
      "refresh_workspace",
    ]),
  );
  expect(nativeState.commands).not.toContain("copy_workspace_entry");
});

test("document move previews and confirms inbound and outbound link rewrites", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });

  await workspace.getByRole("button", { name: "管理 开始.md" }).click();
  await workspace
    .getByRole("textbox", { name: "目标相对路径" })
    .fill("图片/开始.md");
  await workspace.getByRole("button", { name: "移动 / 重命名" }).click();

  await expect(page.getByRole("status")).toContainText("并更新 1 个文档链接");
  const nativeState = await readNativeMockState(page);
  expect(nativeState.confirmationMessages.at(-1)).toContain(
    "1 个文档中的 1 个链接",
  );
  expect(nativeState.confirmationMessages.at(-1)).toContain(
    "../图片/封面.png → 封面.png",
  );
  expect(nativeState.commands).toEqual(
    expect.arrayContaining([
      "preview_workspace_document_move",
      "move_workspace_document_with_links",
      "refresh_workspace",
    ]),
  );
  expect(nativeState.commands).not.toContain("move_workspace_entry");
});

test("directory move previews and confirms links crossing the moved tree", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });

  await workspace.getByRole("button", { name: "管理 指南" }).click();
  await workspace
    .getByRole("textbox", { name: "目标相对路径" })
    .fill("归档/指南");
  await workspace.getByRole("button", { name: "移动 / 重命名" }).click();

  await expect(
    workspace.getByTitle("归档/指南", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("并更新 1 个文档链接");
  const nativeState = await readNativeMockState(page);
  expect(nativeState.confirmationMessages.at(-1)).toContain(
    "移动目录将更新 1 个文档中的 1 个链接",
  );
  expect(nativeState.confirmationMessages.at(-1)).toContain(
    "../图片/封面.png → ../../图片/封面.png",
  );
  expect(nativeState.commands).toEqual(
    expect.arrayContaining([
      "preview_workspace_document_move",
      "move_workspace_document_with_links",
      "refresh_workspace",
    ]),
  );
  expect(nativeState.commands).not.toContain("move_workspace_entry");
});

test("workspace creation adds folders and opens new Markdown without overwriting", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });

  await workspace.getByRole("button", { name: "新建文件夹" }).click();
  await workspace
    .getByRole("textbox", { name: "新建文件夹相对路径" })
    .fill("指南/新章节");
  await workspace.getByRole("button", { name: "创建" }).click();
  await expect(workspace.getByText("5 个条目", { exact: true })).toBeVisible();
  await expect(workspace.getByText("新章节", { exact: true })).toBeVisible();

  await workspace.getByRole("button", { name: "新建文档" }).click();
  await workspace
    .getByRole("textbox", { name: "新建 Markdown 相对路径" })
    .fill("指南/新章节/草稿.md");
  await workspace.getByRole("button", { name: "创建" }).click();
  await expect(page.getByRole("tab", { name: /草稿\.md/ })).toBeVisible();
  await expect(workspace.getByText("6 个条目", { exact: true })).toBeVisible();
  await expect(
    workspace.getByRole("button", { name: "草稿.md", exact: true }),
  ).toBeVisible();

  await workspace.getByRole("button", { name: "新建文档" }).click();
  const createPath = workspace.getByRole("textbox", {
    name: "新建 Markdown 相对路径",
  });
  await createPath.fill("指南/新章节/草稿.md");
  await workspace.getByRole("button", { name: "创建" }).click();
  await expect(page.getByRole("status")).toContainText(
    "工作区目标已存在，不会覆盖",
  );
  await expect(createPath).toHaveValue("指南/新章节/草稿.md");

  const nativeState = await readNativeMockState(page);
  expect(nativeState.commands).toEqual(
    expect.arrayContaining([
      "create_workspace_directory",
      "create_workspace_file",
      "refresh_workspace",
    ]),
  );
});

test("workspace move preserves clean open tabs and copy refuses dirty disk versions", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });
  await workspace.getByRole("button", { name: "开始.md", exact: true }).click();

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await page.keyboard.insertText("未保存 ");
  await workspace.getByRole("button", { name: "管理 开始.md" }).click();
  const destination = workspace.getByRole("textbox", {
    name: "目标相对路径",
  });
  await destination.fill("指南/入门.md");
  await workspace.getByRole("button", { name: "复制" }).click();
  await expect(page.getByRole("status")).toContainText(
    "请先保存，再复制磁盘版本",
  );
  expect((await readNativeMockState(page)).commands).not.toContain(
    "copy_workspace_entry",
  );

  await page.getByRole("button", { name: "保存", exact: true }).click();
  await workspace.getByRole("button", { name: "移动 / 重命名" }).click();
  await expect(
    workspace.getByRole("button", { name: "入门.md", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: /入门\.md/ })).toBeVisible();
  await expect(
    workspace.getByRole("button", { name: "开始.md", exact: true }),
  ).toHaveCount(0);

  await editor.click();
  await page.keyboard.insertText("移动后保存 ");
  await page.getByRole("button", { name: "保存", exact: true }).click();

  await workspace.getByRole("button", { name: "管理 入门.md" }).click();
  await workspace
    .getByRole("textbox", { name: "目标相对路径" })
    .fill("指南/入门副本.md");
  await workspace.getByRole("button", { name: "复制" }).click();
  await expect(
    workspace.getByRole("button", { name: "入门副本.md", exact: true }),
  ).toBeVisible();
  await expect(workspace.getByText("5 个条目", { exact: true })).toBeVisible();

  const nativeState = await readNativeMockState(page);
  expect(nativeState.commands).toEqual(
    expect.arrayContaining([
      "save_document",
      "move_workspace_entry",
      "copy_workspace_entry",
    ]),
  );
  expect(nativeState.recent[0]).toContain("指南\\入门.md");
});

test("image deletion previews references and uses the guarded native command", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });

  await workspace.getByRole("button", { name: "管理 封面.png" }).click();
  await workspace.getByRole("button", { name: "移到回收站" }).click();

  await expect(workspace.getByText("封面.png", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("移到系统回收站");
  const nativeState = await readNativeMockState(page);
  expect(nativeState.confirmationMessages.at(-1)).toContain("仍被 1 处引用");
  expect(nativeState.confirmationMessages.at(-1)).toContain("指南/开始.md:4:7");
  expect(nativeState.confirmationMessages.at(-1)).toContain("../图片/封面.png");
  expect(nativeState.commands).toEqual(
    expect.arrayContaining([
      "inspect_workspace_image_references",
      "delete_workspace_image",
      "refresh_workspace",
    ]),
  );
  expect(nativeState.commands).not.toContain("delete_workspace_entry");
});

test("workspace deletion requires closed tabs and moves entries to the recycle bin", async ({
  page,
}) => {
  await installNativeAdapterMock(page, {
    confirmationResults: ["Cancel", "Ok"],
  });
  await page.goto("/");
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });
  await workspace.getByRole("button", { name: "开始.md", exact: true }).click();
  await workspace.getByRole("button", { name: "管理 开始.md" }).click();

  await workspace.getByRole("button", { name: "移到回收站" }).click();
  await expect(page.getByRole("status")).toContainText(
    "该条目仍在标签页中打开；请先关闭相关文档",
  );
  expect((await readNativeMockState(page)).commands).not.toContain(
    "delete_workspace_entry",
  );

  await page.getByRole("button", { name: "关闭 开始.md" }).click();
  await expect
    .poll(async () => (await readNativeMockState(page)).commands)
    .toContain("release_document_authorization");

  await workspace.getByRole("button", { name: "移到回收站" }).click();
  await expect(
    workspace.getByRole("button", { name: "开始.md", exact: true }),
  ).toBeVisible();
  expect((await readNativeMockState(page)).commands).not.toContain(
    "delete_workspace_entry",
  );

  await workspace.getByRole("button", { name: "移到回收站" }).click();
  await expect(
    workspace.getByRole("button", { name: "开始.md", exact: true }),
  ).toHaveCount(0);
  await expect(workspace.getByText("3 个条目", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("移到系统回收站");

  const nativeState = await readNativeMockState(page);
  expect(
    nativeState.commands.filter(
      (command) => command === "plugin:dialog|message",
    ),
  ).toHaveLength(2);
  expect(
    nativeState.commands.filter(
      (command) => command === "delete_workspace_entry",
    ),
  ).toHaveLength(1);
  expect(nativeState.recent).toEqual([]);
});

test("workspace quick open and cancellable streamed search navigate results", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });

  await workspace.getByRole("button", { name: "快速打开" }).click();
  const quickOpen = workspace.getByRole("combobox", {
    name: "模糊查找 Markdown 文件",
  });
  await quickOpen.fill("开始");
  await quickOpen.press("Enter");
  await expect(page.getByRole("tab", { name: /开始\.md/ })).toBeVisible();

  const globalSearchButton = workspace.getByRole("button", {
    name: "全局搜索",
  });
  await expect(globalSearchButton).toBeEnabled();
  await globalSearchButton.click();
  const query = workspace.getByRole("textbox", { name: "搜索工作区内容" });
  await query.fill("工作区");
  await workspace.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(workspace.getByRole("status")).toContainText("找到 1 处");
  await workspace.getByRole("button", { name: /指南\/开始\.md:3:1/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Markdown 源码编辑器" }),
  ).toBeFocused();

  await globalSearchButton.click();
  await globalSearchButton.click();
  await query.fill("slow");
  await workspace.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(workspace.getByRole("status")).toContainText("正在搜索");
  await workspace.getByRole("button", { name: "取消搜索" }).click();
  await expect(workspace.getByRole("status")).toContainText("搜索已取消");

  const nativeState = await readNativeMockState(page);
  expect(nativeState.commands).toEqual(
    expect.arrayContaining([
      "start_workspace_search",
      "cancel_workspace_search",
      "open_workspace_document",
    ]),
  );
});

test("modifier link navigation handles headings, workspace files and safe external URLs", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });
  await workspace.getByRole("button", { name: "开始.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = [
    "# 章节",
    "",
    "[页内](#章节)",
    "[本地](../README.md#目标)",
    "[外部](https://example.com/path)",
    "[危险](javascript:alert(1))",
  ].join("\n");
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  await page.getByRole("radio", { name: "混合" }).click();

  const link = (label: string) =>
    page.locator(".cm-md-link").filter({ hasText: label }).first();
  await link("页内").click({ modifiers: [linkModifier] });
  await expect(page.getByRole("status")).toContainText("已定位到当前文档标题");

  await link("本地").click({ modifiers: [linkModifier] });
  await expect(page.getByRole("tab", { name: /README\.md/ })).toBeVisible();
  await expect(editor).toBeFocused();

  await page.getByRole("tab", { name: /开始\.md/ }).click();
  await link("外部").click({ modifiers: [linkModifier] });
  await expect(page.getByRole("status")).toContainText(
    "已交给系统默认应用打开外部链接",
  );
  await link("危险").click({ modifiers: [linkModifier] });
  await expect(page.getByRole("status")).toContainText(
    "已阻止不受支持的链接协议",
  );

  const nativeState = await readNativeMockState(page);
  expect(nativeState.commands).toContain("open_workspace_link");
  expect(
    nativeState.commands.filter(
      (command) => command === "plugin:opener|open_url",
    ),
  ).toHaveLength(1);
});

test("source editor accepts text and derives dirty state", async ({ page }) => {
  await installNativeAdapterMock(page);
  await page.goto("/");

  await expect(page).toHaveTitle("MDEditor");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await expect(editor).toBeVisible();
  await expect(editor.locator(".cm-placeholder")).toContainText(
    "输入 Markdown，例如：# 标题",
  );
  await expect.poll(() => readEditorSource(editor)).toBe("");

  await editor.click();
  await page.keyboard.type("# 我的内容");
  await expect.poll(() => readEditorSource(editor)).toBe("# 我的内容");
  await expect(editor.locator(".cm-placeholder")).toHaveCount(0);
  await expect(page.getByText("未命名 · 未保存")).toBeVisible();
  await expect(page.getByText(/^修订 [1-9]\d*$/)).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const nativeState = await readNativeMockState(page);
  expect(
    new TextDecoder().decode(Uint8Array.from(nativeState.savedMarkdown ?? [])),
  ).toBe("# 我的内容");
});

test("editor settings persist without losing the draft", async ({ page }) => {
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await page.keyboard.type("settings draft ");

  await page.getByText("设置", { exact: true }).click();
  await page.getByRole("tab", { name: "编辑" }).click();
  await page.getByRole("slider", { name: "字号" }).fill("20");
  await page.getByRole("checkbox", { name: "自动换行" }).check();

  await expect(editor).toContainText("settings draft");
  await expect(page.getByText("20px")).toBeVisible();
  await expect(
    page.getByText("自动换行", { exact: true }).last(),
  ).toBeVisible();

  await page.reload();
  await page.getByText("设置", { exact: true }).click();
  await page.getByRole("tab", { name: "编辑" }).click();
  await expect(page.getByText("20px")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "自动换行" })).toBeChecked();
});

test("offline spellcheck skips Markdown syntax and applies suggestions", async ({
  page,
}) => {
  const dictionaryRequests: string[] = [];
  page.on("request", (request) => {
    if (/en-(?:US|GB).*\.dic(?:\?|$)/u.test(request.url())) {
      dictionaryRequests.push(request.url());
    }
  });
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = [
    "Correct wrng [wrng](https://example.com/wrng)",
    "",
    "`wrng`",
    "",
    "~~~text",
    "wrng",
    "~~~",
  ].join("\n");
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  expect(dictionaryRequests).toEqual([]);

  await page.getByText("设置", { exact: true }).click();
  await page.getByRole("tab", { name: "编辑" }).click();
  await page.getByRole("checkbox", { name: "拼写检查（离线）" }).check();
  await page.getByText("设置", { exact: true }).click();

  await expect(editor).toHaveAttribute("data-spellcheck-state", "ready", {
    timeout: 10_000,
  });
  await expect(editor).toHaveAttribute("data-spellcheck-language", "en-US");
  expect(dictionaryRequests.some((url) => url.includes("en-US"))).toBe(true);
  await expect(page.locator(".cm-spelling-error")).toHaveCount(2);

  await page.locator(".cm-spelling-error").first().hover();
  const tooltip = page.locator(".cm-spelling-tooltip");
  await expect(tooltip).toContainText("可能的拼写错误：wrng");
  await tooltip.getByRole("button", { name: "将 wrng 改为 wrong" }).click();
  await expect
    .poll(() => readEditorSource(editor))
    .toBe(source.replace("Correct wrng", "Correct wrong"));
  await expect(page.locator(".cm-spelling-error")).toHaveCount(1);

  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText("color colour");
  await page.getByText("设置", { exact: true }).click();
  await page.getByRole("tab", { name: "编辑" }).click();
  await page
    .getByRole("combobox", { name: "拼写检查语言" })
    .selectOption("en-GB");
  await page.getByText("设置", { exact: true }).click();
  await expect(editor).toHaveAttribute("data-spellcheck-state", "ready", {
    timeout: 10_000,
  });
  await expect(editor).toHaveAttribute("data-spellcheck-language", "en-GB");
  expect(dictionaryRequests.some((url) => url.includes("en-GB"))).toBe(true);
  await expect(page.locator(".cm-spelling-error")).toHaveCount(1);
  await expect(page.locator(".cm-spelling-error")).toHaveText("color");

  await page.reload();
  await page.getByText("设置", { exact: true }).click();
  await page.getByRole("tab", { name: "编辑" }).click();
  await expect(
    page.getByRole("checkbox", { name: "拼写检查（离线）" }),
  ).toBeChecked();
  await expect(
    page.getByRole("combobox", { name: "拼写检查语言" }),
  ).toHaveValue("en-GB");
});

test("conservative auto-save persists named documents and clears recovery", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  await page.getByText("设置", { exact: true }).click();
  await page.getByRole("tab", { name: "编辑" }).click();
  await page.getByRole("checkbox", { name: "自动保存已有文件" }).check();
  await page.getByRole("combobox", { name: "自动保存延迟" }).selectOption("2");
  await page.getByText("设置", { exact: true }).click();
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });
  await workspace.getByRole("button", { name: "开始.md", exact: true }).click();

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await page.keyboard.insertText("自动保存内容 ");
  await expect(
    page.getByText("开始.md · 未保存", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await readNativeMockState(page)).commands.filter(
          (command) => command === "save_document",
        ).length,
      { timeout: 7000 },
    )
    .toBe(1);
  await expect(
    page.getByRole("tab", { name: "开始.md", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await readNativeMockState(page)).recovery, {
      timeout: 4000,
    })
    .toBeNull();
});

test("auto-save keeps untitled drafts in recovery without opening save-as", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  await page.getByText("设置", { exact: true }).click();
  await page.getByRole("tab", { name: "编辑" }).click();
  await page.getByRole("checkbox", { name: "自动保存已有文件" }).check();
  await page.getByRole("combobox", { name: "自动保存延迟" }).selectOption("2");
  await page.getByText("设置", { exact: true }).click();

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await page.keyboard.insertText("未命名恢复内容 ");
  await expect
    .poll(async () => (await readNativeMockState(page)).recovery, {
      timeout: 4000,
    })
    .not.toBeNull();
  await page.waitForTimeout(2500);
  const commands = (await readNativeMockState(page)).commands;
  expect(commands).not.toContain("save_document");
  expect(commands).not.toContain("save_document_as");
});

test("auto-save pauses after a fingerprint failure until manual resolution", async ({
  page,
}) => {
  await installNativeAdapterMock(page, { saveDocumentFailures: 1 });
  await page.goto("/");
  await page.getByText("设置", { exact: true }).click();
  await page.getByRole("tab", { name: "编辑" }).click();
  await page.getByRole("checkbox", { name: "自动保存已有文件" }).check();
  await page.getByRole("combobox", { name: "自动保存延迟" }).selectOption("2");
  await page.getByText("设置", { exact: true }).click();
  await clickFileAction(page, "打开文件夹");
  const workspace = page.getByRole("complementary", { name: "工作区文件" });
  await workspace.getByRole("button", { name: "开始.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await page.keyboard.insertText("冲突内容 ");

  await expect(page.locator(".document-notice")).toContainText(
    "自动保存失败，已暂停该标签的自动保存",
    { timeout: 7000 },
  );
  await editor.click();
  await page.keyboard.insertText("继续编辑 ");
  await page.waitForTimeout(2500);
  expect(
    (await readNativeMockState(page)).commands.filter(
      (command) => command === "save_document",
    ),
  ).toHaveLength(1);

  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已安全保存");
  expect(
    (await readNativeMockState(page)).commands.filter(
      (command) => command === "save_document",
    ),
  ).toHaveLength(2);
});

test("ARIA landmarks and disclosures support keyboard-only navigation", async ({
  page,
}) => {
  await page.goto("/");
  await clickFileAction(page, "新建");

  const activeTab = page.getByRole("tab", { selected: true });
  const tabId = await activeTab.getAttribute("id");
  if (tabId === null) throw new Error("Active document tab has no id");
  await expect(page.getByRole("tabpanel")).toHaveAttribute(
    "aria-labelledby",
    tabId,
  );

  const status = page.getByRole("status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveAttribute("aria-atomic", "true");
  await expect(page.locator("main.app-shell")).toHaveAttribute(
    "aria-busy",
    "false",
  );

  const toolbar = page.getByRole("toolbar", {
    name: "Markdown 格式与插入工具",
  });
  const outline = toolbar.getByRole("button", { name: "大纲" });
  const bold = toolbar.getByRole("button", { name: "粗体" });
  const more = toolbar.locator("details.format-menu > summary");
  await outline.focus();
  await outline.press("ArrowRight");
  await expect(bold).toBeFocused();
  await expect(bold).toHaveAttribute("tabindex", "0");
  await bold.press("End");
  const lastAction = toolbar.locator("button[data-toolbar-index]").last();
  await expect(lastAction).toBeFocused();
  await lastAction.press("ArrowRight");
  await expect(outline).toBeFocused();
  await more.focus();
  await more.press("Enter");
  await expect(
    toolbar.locator(".format-panel").getByRole("button", { name: "插入目录" }),
  ).toBeVisible();
  await expect(
    toolbar
      .locator(".format-panel")
      .getByRole("button", { name: "插入打印分页标记" }),
  ).toBeVisible();
  await more.press("Escape");
  await expect(more).toBeFocused();

  const settings = page.locator("details.settings-menu").first();
  const settingsSummary = settings.locator("summary");
  await settingsSummary.click();
  const theme = page.getByLabel("主题", { exact: true });
  await theme.focus();
  await theme.press("Escape");
  await expect(settings).not.toHaveAttribute("open", "");
  await expect(settingsSummary).toBeFocused();
});

test("format toolbar grows with available width and menus close on outside click", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/");

  const toolbar = page.getByRole("toolbar", {
    name: "Markdown 格式与插入工具",
  });
  const actions = toolbar.locator("button[data-toolbar-index]");
  const compactCount = await actions.count();
  await expect(toolbar.locator("details.format-menu > summary")).toBeVisible();
  const more = toolbar.locator("details.format-menu");
  const expectNoDuplicateActions = async () => {
    const direct = await toolbar
      .locator(":scope > button[aria-label]")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      );
    const overflow = await more
      .locator(".format-panel > button[aria-label]")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      );
    expect(direct.filter((label) => overflow.includes(label))).toEqual([]);
  };
  await more.locator(":scope > summary").click();
  await expectNoDuplicateActions();
  await expect(
    more.locator(".format-panel").getByRole("button", { name: "插入表格" }),
  ).toBeVisible();
  await expect(
    toolbar.locator(":scope > button[aria-label='插入表格']"),
  ).toHaveCount(0);
  await more.locator(":scope > summary").click();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => actions.count()).toBeGreaterThan(compactCount);
  await expect(toolbar.getByRole("button", { name: "一级标题" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "无序列表" })).toBeVisible();
  await expect(
    toolbar.locator(":scope > button[aria-label='插入表格']"),
  ).toBeVisible();
  await more.locator(":scope > summary").click();
  await expectNoDuplicateActions();
  await expect(
    more.locator(".format-panel button[aria-label='插入表格']"),
  ).toHaveCount(0);
  await more.locator(":scope > summary").click();

  const settings = page.locator("details.settings-menu").first();
  await settings.locator("summary").click();
  await expect(settings).toHaveAttribute("open", "");
  await page.getByRole("textbox", { name: "Markdown 源码编辑器" }).click();
  await expect(settings).not.toHaveAttribute("open", "");

  await more.locator(":scope > summary").click();
  await expect(more).toHaveAttribute("open", "");
  await page.locator(".statusbar").click();
  await expect(more).not.toHaveAttribute("open", "");

  await page.setViewportSize({ width: 360, height: 640 });
  await expect(
    toolbar.locator(":scope > button[aria-label='插入表格']"),
  ).toHaveCount(0);
  await more.locator(":scope > summary").click();
  await expect(
    more.locator(".format-panel").getByRole("button", { name: "插入表格" }),
  ).toBeVisible();
  await expectNoDuplicateActions();
});

test("narrow and forced-colors windows keep editor controls reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/");

  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    forcedColors: matchMedia("(forced-colors: active)").matches,
  }));
  expect(viewport.forcedColors).toBe(true);
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
  await expect(
    page.getByRole("textbox", { name: "Markdown 源码编辑器" }),
  ).toBeVisible();

  const settings = page.locator("details.settings-menu").first();
  await settings.locator("summary").click();
  const panel = settings.locator(".settings-panel");
  await expect(panel).toBeVisible();
  const bounds = await panel.boundingBox();
  if (bounds === null) throw new Error("Settings panel has no bounds");
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  await expect(page.getByLabel("主题", { exact: true })).toBeVisible();

  await settings.locator("summary").click();
  const exportMenu = page.locator("details.export-menu");
  await exportMenu.locator("summary").click();
  const exportPanel = exportMenu.locator(".export-panel");
  await expect(exportPanel).toBeVisible();
  const exportBounds = await exportPanel.boundingBox();
  if (exportBounds === null) throw new Error("Export panel has no bounds");
  expect(exportBounds.x).toBeGreaterThanOrEqual(0);
  expect(exportBounds.x + exportBounds.width).toBeLessThanOrEqual(
    viewport.width,
  );
  await exportMenu.locator("summary").press("Tab");
  await expect(page.getByRole("combobox", { name: "打印纸张" })).toBeFocused();
});

test("export settings and actions stay inside the panel at desktop and narrow sizes", async ({
  page,
}) => {
  for (const [width, height] of [
    [1280, 720],
    [390, 640],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.locator("details.export-menu > summary").click();
    const panel = page.locator(".export-panel");
    await expect(panel).toBeVisible();
    const layout = await panel.evaluate((element) => {
      const right = element.getBoundingClientRect().right;
      return {
        panelBottom: element.getBoundingClientRect().bottom,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        controlRights: [
          ...element.querySelectorAll("select, input, button"),
        ].map((control) => control.getBoundingClientRect().right),
        right,
      };
    });
    expect(layout.panelBottom).toBeLessThanOrEqual(height);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(Math.max(...layout.controlRights)).toBeLessThanOrEqual(layout.right);
    const print = panel.getByRole("button", { name: "打印 / PDF" });
    await print.scrollIntoViewIfNeeded();
    await expect(print).toBeInViewport();
  }
});

test("navigation and wrapped prose fit desktop and narrow windows", async ({
  page,
}) => {
  for (const width of [1100, 800, 360, 346]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/");
    const editor = page.getByRole("textbox", {
      name: "Markdown 源码编辑器",
    });
    await editor.click();
    await page.keyboard.insertText(
      `${"这是一段用于检查正文自动换行的中文内容。".repeat(20)}\n${"a".repeat(500)}`,
    );
    const overflow = await page.evaluate(() => {
      const widthOf = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (element === null) throw new Error(`Missing ${selector}`);
        return {
          client: element.clientWidth,
          scroll: element.scrollWidth,
        };
      };
      return {
        page: {
          client: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
        },
        titlebar: widthOf(".titlebar"),
        toolbar: widthOf(".editor-toolbar"),
        editor: widthOf(".editor-host .cm-scroller"),
      };
    });
    for (const [name, area] of Object.entries(overflow)) {
      expect(
        area.scroll,
        `${name} overflows at ${width}px`,
      ).toBeLessThanOrEqual(area.client + 1);
    }
  }
});

test("formatting commands edit canonical Markdown and remain undoable", async ({
  page,
}) => {
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("format me");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+B");

  await expect.poll(() => readEditorSource(editor)).toBe("**format me**");
  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(() => readEditorSource(editor)).toBe("format me");

  await page.keyboard.press("ControlOrMeta+A");
  await clickMoreFormat(page, "一级标题");
  await expect.poll(() => readEditorSource(editor)).toBe("# format me");
  await clickMoreFormat(page, "一级标题");
  await expect.poll(() => readEditorSource(editor)).toBe("format me");

  await page.keyboard.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "链接（Ctrl/⌘ K）" }).click();
  await expect
    .poll(() => readEditorSource(editor))
    .toBe("[format me](https://)");
});

test("the toolbar inserts an undoable TOC from canonical Markdown", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = "# Alpha\n\n## Beta\n\nEnd";
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  await editor.press("ControlOrMeta+Home");
  await clickMoreFormat(page, "插入目录");
  await expect.poll(() => readEditorSource(editor)).toBe(`[toc]\n\n${source}`);

  await editor.press("ControlOrMeta+End");
  await page.getByRole("radio", { name: "混合" }).click();
  await expect(page.locator('[data-md-extension-preview="toc"]')).toContainText(
    "Alpha",
  );
  await expect(page.locator('[data-md-extension-preview="toc"]')).toContainText(
    "Beta",
  );

  await page.getByRole("radio", { name: "源码", exact: true }).click();
  await editor.press("ControlOrMeta+Z");
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});

test("extended commands share undoable source and preview workflows", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });

  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("alpha\nbeta");
  await page.keyboard.press("ControlOrMeta+A");
  await clickMoreFormat(page, "插入任务");
  await expect
    .poll(() => readEditorSource(editor))
    .toBe("- [ ] alpha\n- [ ] beta");
  await editor.press("ControlOrMeta+Z");
  await expect.poll(() => readEditorSource(editor)).toBe("alpha\nbeta");

  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText("架构图");
  await editor.press("ControlOrMeta+A");
  await clickMoreFormat(page, "插入图片");
  await expect.poll(() => readEditorSource(editor)).toBe("![架构图](图片路径)");
  await editor.press("ControlOrMeta+Z");
  await expect.poll(() => readEditorSource(editor)).toBe("架构图");

  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText("x^2 + y^2");
  await editor.press("ControlOrMeta+A");
  await clickMoreFormat(page, "插入 KaTeX 数学块");
  const mathSource = "```katex\nx^2 + y^2\n```";
  await expect.poll(() => readEditorSource(editor)).toBe(mathSource);
  await page.getByRole("radio", { name: "混合" }).click();
  await expect(
    page.locator('[data-md-complex-widget="katex"]'),
  ).toHaveAttribute("data-md-render-state", "ready");
  await page.getByRole("radio", { name: "源码", exact: true }).click();

  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText("正文");
  await clickMoreFormat(page, "插入水平线");
  await expect.poll(() => readEditorSource(editor)).toBe("正文\n\n---");
  await editor.press("ControlOrMeta+Home");
  await page.getByRole("radio", { name: "混合" }).click();
  const rulePreview = page.getByRole("button", { name: "编辑水平线源码" });
  await expect(rulePreview).toBeVisible();
  await rulePreview.press("Enter");
  await expect(rulePreview).toHaveCount(0);
  await expect.poll(() => readEditorSource(editor)).toBe("正文\n\n---");

  await editor.press("ControlOrMeta+End");
  await clickMoreFormat(page, "插入打印分页标记");
  await expect
    .poll(() => readEditorSource(editor))
    .toBe('正文\n\n---\n\n<div class="page-break"></div>');
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe("正文\n\n---");
});

test("hybrid rendering is derived and preserves caret and undo history", async ({
  page,
}) => {
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = [
    "# 标题 *强调* **加粗**",
    "",
    "> 引用 [链接](https://example.com)",
    "",
    "- 列表",
    "",
    "![图片](data:image/png;base64,iVBORw0KGgo=)",
    "",
    "`const value = 1`",
    "",
    "```js",
    "const highlighted = true",
    "```",
  ].join("\n");

  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);

  const hybridButton = page.getByRole("radio", { name: "混合" });
  await hybridButton.click();
  await expect(hybridButton).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".cm-md-heading-1")).toContainText("标题");
  await expect(page.locator(".cm-md-emphasis")).toContainText("强调");
  await expect(page.locator(".cm-md-strong")).toContainText("加粗");
  await expect(page.locator(".cm-md-link")).toContainText("链接");
  await expect(page.locator(".cm-code-keyword")).toContainText("const");
  await expect(page.locator('[data-md-image-widget="true"]')).toHaveCount(1);
  await expect(page.locator(".cm-md-hidden-syntax").first()).toBeAttached();
  await expect(page.locator(".cm-md-heading-1")).not.toContainText("#");
  await expect(page.locator(".cm-md-link")).not.toContainText(
    "https://example.com",
  );

  const imagePreview = page.getByRole("button", { name: "编辑图片源码" });
  await expect(imagePreview).toHaveAttribute("data-md-source-inline", /图片/u);
  await imagePreview.press("Enter");
  await expect(
    page.locator('[data-md-image-widget="true"]'),
  ).not.toHaveAttribute("data-md-source-inline");

  await page.locator(".cm-md-emphasis").click();
  await expect(page.locator(".cm-md-emphasis")).toContainText("*强调*");

  await editor.press("ControlOrMeta+End");
  await editor.press("x");
  await expect.poll(() => readEditorSource(editor)).toBe(`${source}x`);
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  await page.getByRole("radio", { name: "源码", exact: true }).click();
  await expect(page.locator(".cm-md-heading-1")).toHaveCount(0);
  await expect(page.locator('[data-md-image-widget="true"]')).toHaveCount(0);
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});

test("Chinese IME composition is committed once and remains undoable", async ({
  page,
}) => {
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const sourcePrefix = "![图片](data:image/png;base64,iVBORw0KGgo=)\n\n# ";
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(sourcePrefix);
  await page.getByRole("radio", { name: "混合" }).click();
  await editor.focus();
  await editor.press("End");
  const imageWidget = await page
    .locator('[data-md-image-widget="true"]')
    .elementHandle();
  expect(imageWidget).not.toBeNull();

  const devtools = await page.context().newCDPSession(page);
  await devtools.send("Input.imeSetComposition", {
    text: "中",
    selectionStart: 1,
    selectionEnd: 1,
  });
  expect(await imageWidget?.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await devtools.send("Input.imeSetComposition", {
    text: "中文，A🙂",
    selectionStart: 6,
    selectionEnd: 6,
  });
  await devtools.send("Input.insertText", { text: "中文，A🙂" });

  await expect
    .poll(() => readEditorSource(editor))
    .toBe(`${sourcePrefix}中文，A🙂`);
  await expect(page.locator(".cm-md-heading-1")).toContainText("中文，A🙂");
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe(sourcePrefix);
  await editor.press(redoShortcut);
  await expect
    .poll(() => readEditorSource(editor))
    .toBe(`${sourcePrefix}中文，A🙂`);
});

test("GFM task checkboxes change only their source marker", async ({
  page,
}) => {
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = "- [ ] first\n- [X] second";
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  await page.getByRole("radio", { name: "混合" }).click();

  const tasks = page.locator('[data-md-task-checkbox="true"]');
  await expect(tasks).toHaveCount(2);
  await expect(tasks.nth(0)).not.toBeChecked();
  await expect(tasks.nth(1)).toBeChecked();
  await tasks.nth(0).click();
  await expect(tasks.nth(0)).toBeChecked();

  await page.getByRole("radio", { name: "源码", exact: true }).click();
  await expect
    .poll(() => readEditorSource(editor))
    .toBe("- [x] first\n- [X] second");
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});

test("table insertion and Tab navigation include empty cells and new rows", async ({
  page,
}) => {
  await page.goto("/");
  await clickFileAction(page, "新建");
  await clickMoreFormat(page, "插入表格");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const starter = [
    "| 列 1 | 列 2 | 列 3 |",
    "| --- | --- | --- |",
    "|  |  |  |",
  ].join("\n");
  await expect.poll(() => readEditorSource(editor)).toBe(starter);

  await page.keyboard.insertText("v1");
  await page.keyboard.press("Tab");
  await page.keyboard.insertText("v2");
  await page.keyboard.press("Tab");
  await page.keyboard.insertText("v3");
  await page.keyboard.press("Tab");
  await page.keyboard.insertText("v4");

  await expect
    .poll(() => readEditorSource(editor))
    .toBe(
      [
        "| 列 1 | 列 2 | 列 3 |",
        "| --- | --- | --- |",
        "| v1 | v2 | v3 |",
        "| v4 |  |  |",
      ].join("\n"),
    );
});

test("table preview replaces inactive source and reopens it for editing", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = [
    "| 名称 | 状态 |",
    "| :--- | ---: |",
    "| M4 | **进行中** |",
    "",
    "表格之后",
  ].join("\n");

  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  await page.getByRole("radio", { name: "混合" }).click();

  const preview = page.getByRole("button", { name: "编辑表格源码" });
  await expect(preview).toBeVisible();
  await expect(
    preview.getByRole("columnheader", { name: "名称" }),
  ).toBeVisible();
  await expect(preview.getByRole("cell", { name: "进行中" })).toHaveAttribute(
    "align",
    "right",
  );
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  await preview.press("Enter");
  await expect(page.locator('[data-md-table-preview="true"]')).toHaveCount(0);
  await expect(editor).toContainText("| 名称 | 状态 |");
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  await editor.press("ControlOrMeta+End");
  await expect(page.locator('[data-md-table-preview="true"]')).toHaveCount(1);
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});

test("safe HTML previews expand to exact source while active markup stays visible", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = [
    "按 <kbd>Ctrl</kbd> 继续。",
    "",
    "<details><summary>说明</summary>安全内容</details>",
    "",
    "<script>window.__unsafe = true</script>",
    "",
    '<div onclick="alert(1)">危险属性</div>',
    "",
    "结束。",
  ].join("\n");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  await editor.press("ControlOrMeta+End");
  await page.getByRole("radio", { name: "混合" }).click();

  const previews = page.locator("[data-md-html-preview]");
  await expect(previews).toHaveCount(2);
  await expect(previews.first().locator("kbd")).toHaveText("Ctrl");
  await expect(previews.last().locator("summary")).toHaveText("说明");
  await expect(previews.last().locator("details")).toHaveJSProperty(
    "inert",
    true,
  );
  await expect(page.locator(".cm-content script")).toHaveCount(0);
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  await previews.last().press("Enter");
  await expect(previews).toHaveCount(1);
  await expect(editor).toContainText("<details>");
  await expect.poll(() => readEditorSource(editor)).toBe(source);
  await editor.press("ControlOrMeta+End");
  await expect(previews).toHaveCount(2);
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  await page.getByText("导出", { exact: true }).click();
  await page.getByRole("button", { name: "导出带样式 HTML" }).click();
  const html = new TextDecoder().decode(
    Uint8Array.from((await readNativeMockState(page)).exportedHtml ?? []),
  );
  expect(html).toContain("<kbd>Ctrl</kbd>");
  expect(html).toContain("<summary>说明</summary>");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onclick=");
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});

test("table structure controls edit rows, columns and alignment atomically", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = [
    "| A | B |",
    "| --- | ---: |",
    "| a1 | b1 |",
    "",
    "表格之后",
  ].join("\n");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  await page.getByRole("radio", { name: "混合" }).click();
  await page.getByRole("button", { name: "编辑表格源码" }).press("Enter");
  await page.locator("details.format-menu > summary").click();
  await page.locator("summary", { hasText: "表格结构操作" }).click();

  await page.getByRole("button", { name: "右侧插入列" }).click();
  await page.keyboard.insertText("新列");
  await page.getByRole("button", { name: "居中对齐" }).click();
  await page.getByRole("button", { name: "下方插入行" }).click();
  await page.keyboard.insertText("值");
  await page.getByRole("button", { name: "右移列" }).click();

  const edited = [
    "| A | B | 新列 |",
    "| --- | ---: | :---: |",
    "|  |  | 值 |",
    "| a1 | b1 |  |",
    "",
    "表格之后",
  ].join("\n");
  await expect.poll(() => readEditorSource(editor)).toBe(edited);

  await page.getByRole("button", { name: "删除行" }).click();
  await expect.poll(() => readEditorSource(editor)).not.toContain("值");
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe(edited);

  await editor.press("ControlOrMeta+End");
  await page.getByRole("button", { name: "删除列" }).click();
  await expect(page.getByRole("status")).toContainText(
    "请先将光标置于可执行该操作的表格单元格",
  );
  await expect.poll(() => readEditorSource(editor)).toBe(edited);
});

test("outline derives headings, jumps to source, and updates after edits", async ({
  page,
}) => {
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = [
    "# 总览",
    "",
    "正文",
    "",
    "## 细节",
    "",
    "```md",
    "# 代码中的标题",
    "```",
    "",
    "附录",
    "====",
  ].join("\n");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  await page.getByRole("button", { name: "大纲" }).click();

  const outline = page.getByRole("navigation", { name: "文档大纲" });
  await expect(outline.locator(".outline-jump")).toHaveCount(3);
  await expect(outline).not.toContainText("代码中的标题");

  await outline.getByRole("button", { name: "折叠：总览" }).click();
  await expect(outline.getByRole("button", { name: "细节" })).toHaveCount(0);
  await expect(
    outline.getByRole("button", { name: "展开：总览" }),
  ).toHaveAttribute("aria-expanded", "false");
  await outline.getByRole("button", { name: "展开：总览" }).click();

  const filter = outline.getByRole("searchbox", { name: "筛选大纲" });
  await filter.fill("细");
  await expect(outline.locator(".outline-jump")).toHaveCount(1);
  await expect(outline).toContainText("1 / 3 个标题");
  await filter.fill("不存在");
  await expect(outline).toContainText("没有匹配的标题");
  await filter.fill("");

  await outline.getByRole("button", { name: "细节" }).click();
  await page.keyboard.insertText("已定位 ");

  await expect
    .poll(() => readEditorSource(editor))
    .toBe(source.replace("## 细节", "## 已定位 细节"));
  await expect(
    outline.getByRole("button", { name: "已定位 细节" }),
  ).toBeVisible();
});

test("search panel supports whole-word, case-sensitive and regexp replacement", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = "foo Foo foobar foo1\nfoo FOO";
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);

  await page.getByRole("button", { name: "查找 / 替换" }).click();
  const find = page.getByRole("textbox", { name: "查找" });
  const replace = page.getByRole("textbox", { name: "替换" });
  await expect(find).toBeFocused();
  await find.fill("foo");
  await page.getByRole("checkbox", { name: "区分大小写" }).check();
  await page.getByRole("checkbox", { name: "全字匹配" }).check();
  await replace.fill("X");
  await page.getByRole("button", { name: "全部替换", exact: true }).click();
  await expect
    .poll(() => readEditorSource(editor))
    .toBe("X Foo foobar foo1\nX FOO");

  await editor.click();
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  await page.getByRole("checkbox", { name: "区分大小写" }).uncheck();
  await page.getByRole("checkbox", { name: "全字匹配" }).uncheck();
  await page.getByRole("checkbox", { name: "正则表达式" }).check();
  await find.fill("f[o]+");
  await replace.fill("R");
  await page.getByRole("button", { name: "全部替换", exact: true }).click();
  await expect.poll(() => readEditorSource(editor)).toBe("R R Rbar R1\nR R");
});

test("settings tabs and About remain usable at narrow widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto("/");
  await page.getByText("设置", { exact: true }).click();
  const appearance = page.getByRole("tab", { name: "外观" });
  const writing = page.getByRole("tab", { name: "编辑" });
  const about = page.getByRole("tab", { name: "关于" });
  await expect(appearance).toHaveAttribute("aria-selected", "true");
  await writing.click();
  await expect(writing).toHaveAttribute("aria-selected", "true");
  await expect(appearance).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("slider", { name: "字号" })).toBeVisible();
  await about.click();
  const versions = page.getByRole("textbox", { name: "版本与环境信息" });
  await expect(versions).toHaveValue(/MDEditor：/u);
  await expect(versions).toHaveValue(/WebView2 \/ Edge：/u);
  await expect(versions).toHaveValue(/中文输入法及版本：请手填/u);
  const bounds = await page
    .locator("details.settings-menu > .settings-panel")
    .boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
});

test("split layout updates a right-side preview and keeps one mode selected", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText("# 初稿\n\n第一段");
  const split = page.getByRole("radio", { name: "双栏" });
  await split.click();
  await expect(split).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "源码" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  const preview = page.frameLocator('iframe[title="Markdown 实时预览"]');
  await expect(preview.getByRole("heading", { name: "初稿" })).toBeVisible();
  await expect(preview.getByText("第一段")).toBeVisible();
  const sourceBounds = await page.locator(".editor-pane").boundingBox();
  const previewBounds = await page.locator(".split-preview").boundingBox();
  expect(sourceBounds).not.toBeNull();
  expect(previewBounds).not.toBeNull();
  expect(sourceBounds!.x + sourceBounds!.width).toBeLessThanOrEqual(
    previewBounds!.x + 1,
  );
  await editor.click();
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText(" 更新");
  await expect(preview.getByText("第一段 更新")).toBeVisible();
  await page.getByRole("radio", { name: "混合" }).click();
  await expect(page.locator(".split-preview")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "混合" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("remote Markdown images load in the editor and split preview under the desktop CSP", async ({
  page,
}) => {
  const config = JSON.parse(
    await readFile(
      new URL("../../apps/desktop/src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  ) as { app: { security: { csp: string } } };
  const appUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "5173"}/`;
  await page.route(appUrl, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        // Vite injects an inline development script; the packaged app does not.
        "content-security-policy": `${config.app.security.csp}; script-src 'self' 'unsafe-inline'`,
      },
    });
  });
  await page.route("https://images.example.test/remote.png", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await page.keyboard.insertText(
    "![网络图片](https://images.example.test/remote.png)",
  );
  await page.getByRole("radio", { name: "混合" }).click();
  const inlineImage = page.locator(".cm-md-image-widget img");
  await expect(inlineImage).toBeVisible();
  await expect
    .poll(() =>
      inlineImage.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(1);

  await page.getByRole("radio", { name: "双栏" }).click();
  const previewImage = page
    .frameLocator('iframe[title="Markdown 实时预览"]')
    .locator("img");
  await expect(previewImage).toBeVisible();
  await expect
    .poll(() =>
      previewImage.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(1);
});

test("startup arguments and native file drops open Markdown tabs", async ({
  page,
}) => {
  await installNativeAdapterMock(page, { startupMarkdown: "# 启动文件" });
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await expect.poll(() => readEditorSource(editor)).toBe("# 启动文件");
  await expect(page.getByRole("tab", { name: /启动/u })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect
    .poll(async () => (await readNativeMockState(page)).commands)
    .toContain("plugin:event|listen");
  await page.evaluate(() => {
    const runtime = window as typeof window & {
      __MDEDITOR_E2E_EMIT_EXTERNAL__?: (name: string, source: string) => void;
    };
    runtime.__MDEDITOR_E2E_EMIT_EXTERNAL__?.("拖入.md", "# 拖入文件");
  });
  await expect.poll(() => readEditorSource(editor)).toBe("# 拖入文件");
  await expect(page.getByRole("tab", { name: /拖入/u })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(2);
});

test("single opened Markdown file can preview, select, and drop local images", async ({
  page,
}) => {
  await installNativeAdapterMock(page, {
    startupMarkdown:
      "# 单文件\n\n![原图](assets/%E6%9C%AC%E5%9C%B0%E5%9B%BE.png)",
  });
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await expect.poll(() => readEditorSource(editor)).toContain("![原图]");
  await expect(page.locator(".cm-md-image-widget img")).toBeVisible();
  await page.getByRole("radio", { name: "双栏" }).click();
  await expect(
    page.frameLocator('iframe[title="Markdown 实时预览"]').locator("img"),
  ).toBeVisible();
  await page.getByRole("radio", { name: "混合" }).click();
  await clickMoreFormat(page, "插入图片");
  await expect
    .poll(() => readEditorSource(editor))
    .toContain("![本地图](assets/");

  await editor.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(
        [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
        "拖入.png",
        {
          type: "image/png",
        },
      ),
    );
    element.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  await expect(page.getByRole("status")).toContainText("已导入 1 张图片");
  await page.evaluate(() => {
    const runtime = window as typeof window & {
      __MDEDITOR_E2E_EMIT_IMAGE_DROP__?: (path: string) => void;
    };
    runtime.__MDEDITOR_E2E_EMIT_IMAGE_DROP__?.("C:\\图片\\本地图.png");
  });
  await expect(page.getByRole("status")).toContainText(
    "已导入图片：assets/本地图.png",
  );
  const commands = (await readNativeMockState(page)).commands;
  expect(commands).toEqual(
    expect.arrayContaining([
      "read_document_image",
      "import_document_image",
      "import_document_image_data",
      "import_dropped_document_image",
    ]),
  );
});

test("launch starts without an untitled tab and first editing or open creates one", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("未打开文件", { exact: true })).toBeVisible();
  await expect.poll(() => readEditorSource(editor)).toBe("");

  await page.evaluate(() => {
    const runtime = window as typeof window & {
      __MDEDITOR_E2E_EMIT_EXTERNAL__?: (name: string, source: string) => void;
    };
    runtime.__MDEDITOR_E2E_EMIT_EXTERNAL__?.("第一篇.md", "# 第一篇");
  });
  await expect(page.getByRole("tab", { name: /第一篇/u })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect.poll(() => readEditorSource(editor)).toBe("# 第一篇");

  await page.getByRole("button", { name: "关闭 第一篇.md" }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await clickFileAction(page, "新建");
  await expect(page.getByRole("tab", { name: /未命名 1/u })).toBeVisible();
  await page.getByRole("button", { name: "关闭 未命名 1" }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await editor.click();
  await page.keyboard.insertText("# 新草稿");
  await expect(page.getByRole("tab", { name: /未命名 1/u })).toBeVisible();
  await expect.poll(() => readEditorSource(editor)).toBe("# 新草稿");
});

test("status bar updates document and selection statistics", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = "中文 hello\n第二行";
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);

  const documentStatistics = page.locator(".document-statistics");
  await expect(documentStatistics).toHaveAttribute(
    "aria-label",
    "文档统计：6 字，11 字符，2 行，约 1 分钟",
  );
  await editor.press("ControlOrMeta+A");
  await expect(page.locator(".selection-statistics")).toHaveAttribute(
    "aria-label",
    "选区统计：6 字，11 字符，2 行",
  );

  await page.keyboard.insertText("single");
  await expect(documentStatistics).toHaveAttribute(
    "aria-label",
    "文档统计：1 字，6 字符，1 行，约 1 分钟",
  );
  await expect(page.locator(".selection-statistics")).toHaveCount(0);
});

test("focus, typewriter, and Markdown pairing preserve canonical source", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = Array.from({ length: 90 }, (_, index) =>
    index === 45 ? "TARGET-MIDDLE paragraph" : `paragraph ${index}`,
  ).join("\n\n");
  const sourceCharacters = source.replaceAll("\n", "").length;
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);

  await page.locator("details.format-menu > summary").click();
  const focusButton = page.getByRole("button", { name: "专注", exact: true });
  await focusButton.click();
  await expect(focusButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".cm-focus-dimmed").first()).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".cm-focus-dimmed")
        .first()
        .evaluate((line) => getComputedStyle(line).opacity),
    )
    .toBe("1");
  await editor.focus();
  await expect
    .poll(() =>
      page
        .locator(".cm-focus-dimmed")
        .first()
        .evaluate((line) => getComputedStyle(line).opacity),
    )
    .toBe("0.82");
  await expect(page.locator(".document-statistics")).toHaveAttribute(
    "aria-label",
    new RegExp(`${sourceCharacters} 字符`),
  );

  const typewriterButton = page.getByRole("button", {
    name: "打字机",
    exact: true,
  });
  await typewriterButton.click();
  await expect(typewriterButton).toHaveAttribute("aria-pressed", "true");
  await editor.press("ControlOrMeta+f");
  await page.getByRole("textbox", { name: "查找" }).fill("TARGET-MIDDLE");
  await page.getByRole("button", { name: "下一个" }).click();
  await page.keyboard.press("Escape");
  await editor.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => {
      const cursor = await page.locator(".cm-cursor").boundingBox();
      const scroller = await page.locator(".cm-scroller").boundingBox();
      if (cursor === null || scroller === null) return Number.POSITIVE_INFINITY;
      return Math.abs(
        cursor.y + cursor.height / 2 - (scroller.y + scroller.height / 2),
      );
    })
    .toBeLessThan(90);
  await expect(page.locator(".document-statistics")).toHaveAttribute(
    "aria-label",
    new RegExp(`${sourceCharacters} 字符`),
  );

  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText("alpha");
  await editor.press("ControlOrMeta+A");
  await page.keyboard.type("`");
  await expect.poll(() => readEditorSource(editor)).toBe("`alpha`");
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe("alpha");

  await editor.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("*");
  await expect.poll(() => readEditorSource(editor)).toBe("**");
  await page.keyboard.press("Backspace");
  await expect.poll(() => readEditorSource(editor)).toBe("");

  await page.getByText("设置", { exact: true }).click();
  await page.getByRole("tab", { name: "编辑" }).click();
  await page.getByRole("checkbox", { name: "Markdown 自动配对" }).uncheck();
  await page.getByText("设置", { exact: true }).click();
  await editor.click();
  await page.keyboard.type("*");
  await expect.poll(() => readEditorSource(editor)).toBe("*");

  await page.reload();
  await page.getByText("设置", { exact: true }).click();
  await page.getByRole("tab", { name: "编辑" }).click();
  await expect(
    page.getByRole("checkbox", { name: "Markdown 自动配对" }),
  ).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "专注模式" })).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "打字机模式" }),
  ).toBeChecked();
});

test("theme and editor preferences persist without replacing history", async ({
  page,
}) => {
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("draft");
  await page.waitForTimeout(600);
  await page.keyboard.insertText(" change");
  const editorElement = await editor.elementHandle();
  expect(editorElement).not.toBeNull();

  await page.getByText("设置", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("dark");
  await page.getByRole("tab", { name: "编辑" }).click();
  await page.getByRole("slider", { name: "字号" }).fill("21");
  await page.getByRole("checkbox", { name: "自动换行" }).check();

  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-theme",
    "dark",
  );
  expect(
    await page
      .locator(".app-shell")
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--app-bg").trim(),
      ),
  ).toBe("#1d1c1a");
  expect(await editorElement?.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await expect.poll(() => readEditorSource(editor)).toBe("draft change");
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe("draft");

  await page.reload();
  await page.getByText("设置", { exact: true }).click();
  await page.getByRole("tab", { name: "外观" }).click();
  await expect(
    page.getByRole("combobox", { name: "主题", exact: true }),
  ).toHaveValue("dark");
  await page.getByRole("tab", { name: "编辑" }).click();
  await expect(page.getByRole("slider", { name: "字号" })).toHaveValue("21");
  await expect(page.getByRole("checkbox", { name: "自动换行" })).toBeChecked();
});

test("document themes and trusted CSS stay scoped and follow styled exports", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  await page.goto("/");

  await page.getByText("设置", { exact: true }).click();
  await page.getByLabel("选择文档主题 CSS").setInputFiles({
    name: "sepia.css",
    mimeType: "text/css",
    buffer: Buffer.from(
      [
        "/* @mdeditor-theme Sepia Notes */",
        ".cm-content { background-color: rgb(250, 240, 220); color: rgb(67, 48, 34); }",
        "h1 { color: rgb(128, 64, 32); }",
        ".titlebar { background-color: rgb(255, 0, 0); }",
      ].join("\n"),
    ),
  });
  await expect(page.locator(".document-notice")).toContainText(
    "已安装并启用文档主题“Sepia Notes”",
  );
  await expect(page.getByRole("combobox", { name: "文档主题" })).toHaveValue(
    /theme-[a-f0-9]{8}/u,
  );

  await page
    .getByRole("checkbox", { name: "我理解受信 CSS 可以改变文档布局" })
    .check();
  await page.getByLabel("选择受信文档 CSS").setInputFiles({
    name: "layout.css",
    mimeType: "text/css",
    buffer: Buffer.from(
      ".cm-content { display: grid; grid-template-columns: minmax(0, 1fr); }\n.titlebar { display: none; }",
    ),
  });
  await expect(page.locator(".document-notice")).toContainText(
    "已加载并启用受信 CSS“layout”",
  );
  await expect(
    page.getByRole("checkbox", { name: "启用“layout”" }),
  ).toBeChecked();
  await page.getByText("设置", { exact: true }).click();

  const editorContent = page.locator(".cm-content");
  await expect(page.locator(".editor-host")).toHaveAttribute(
    "data-md-document-style",
    "true",
  );
  await expect(editorContent).toHaveCSS(
    "background-color",
    "rgb(250, 240, 220)",
  );
  await expect(editorContent).toHaveCSS("display", "grid");
  await expect(page.locator(".titlebar")).toBeVisible();
  await expect(page.locator(".titlebar")).not.toHaveCSS(
    "background-color",
    "rgb(255, 0, 0)",
  );

  await page.getByText("导出", { exact: true }).click();
  await page.getByRole("button", { name: "导出带样式 HTML" }).click();
  const styledState = await readNativeMockState(page);
  const styledHtml = new TextDecoder().decode(
    Uint8Array.from(styledState.exportedHtml ?? []),
  );
  expect(styledHtml).toContain('data-md-document-style="true"');
  expect(styledHtml).toContain('body[data-md-document-style="true"] h1');
  expect(styledHtml).toContain(
    'body[data-md-document-style="true"] .cm-content',
  );
  expect(styledHtml).toContain(
    'body[data-md-document-style="true"] .titlebar{display:none}',
  );

  await page.getByRole("button", { name: "导出无样式 HTML" }).click();
  const unstyledState = await readNativeMockState(page);
  const unstyledHtml = new TextDecoder().decode(
    Uint8Array.from(unstyledState.exportedHtml ?? []),
  );
  expect(unstyledHtml).not.toContain("data-md-document-style");
  expect(unstyledHtml).not.toContain("Sepia Notes");
  expect(unstyledHtml).not.toContain("grid-template-columns");

  await page.reload();
  await expect(page.locator(".editor-host")).toHaveAttribute(
    "data-md-document-style",
    "true",
  );
  await expect(page.locator(".cm-content")).toHaveCSS("display", "grid");
  await page.getByText("设置", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "文档主题" })).toHaveValue(
    /theme-[a-f0-9]{8}/u,
  );
  await expect(
    page.getByRole("checkbox", { name: "启用“layout”" }),
  ).toBeChecked();
  await page.getByRole("button", { name: "移除受信 CSS" }).click();
  await page.getByRole("button", { name: "移除当前主题" }).click();
  await expect(page.locator(".editor-host")).not.toHaveAttribute(
    "data-md-document-style",
  );
});

test("custom shortcuts execute actions and reject conflicts", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByText("设置", { exact: true }).click();
  await page.getByRole("tab", { name: "快捷键" }).click();
  const modeShortcut = page.getByRole("combobox", {
    name: "切换模式快捷键",
  });
  const outlineShortcut = page.getByRole("combobox", {
    name: "切换大纲快捷键",
  });
  await modeShortcut.selectOption("Mod-Alt-m");
  await outlineShortcut.selectOption("Mod-Alt-m");
  await expect(page.locator(".document-notice")).toContainText(
    "已被其他操作使用",
  );
  await expect(outlineShortcut).toHaveValue("Mod-Shift-o");

  const hybridButton = page.getByRole("radio", { name: "混合" });
  await page.keyboard.press("ControlOrMeta+Shift+M");
  await expect(hybridButton).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ControlOrMeta+Alt+M");
  await expect(hybridButton).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(
    page.getByRole("navigation", { name: "文档大纲" }),
  ).toBeVisible();

  await page.reload();
  const reloadedHybridButton = page.getByRole("radio", { name: "混合" });
  await expect(reloadedHybridButton).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Alt+M");
  await expect(reloadedHybridButton).toHaveAttribute("aria-checked", "false");
});

test("workspace tabs preserve source, selection, history, and dirty close guards", async ({
  page,
}) => {
  await page.goto("/");

  const activeEditor = () =>
    page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const firstTab = page.getByRole("tab", { name: /未命名 1/u });
  await activeEditor().click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("first tab");
  await activeEditor().press("ControlOrMeta+Home");
  for (let index = 0; index < 5; index += 1) {
    await activeEditor().press("ArrowRight");
  }

  await clickFileAction(page, "新建");
  await expect(page.getByRole("tab")).toHaveCount(2);
  const secondTab = page.getByRole("tab", { name: /未命名 2/u });
  await expect(secondTab).toHaveAttribute("aria-selected", "true");
  const tabBounds = await secondTab.boundingBox();
  const closeBounds = await page
    .getByRole("button", { name: "关闭 未命名 2" })
    .boundingBox();
  if (tabBounds === null || closeBounds === null) {
    throw new Error("Document tab controls have no bounds");
  }
  expect(closeBounds.x).toBeGreaterThan(tabBounds.x);
  expect(closeBounds.x + closeBounds.width).toBeLessThanOrEqual(
    tabBounds.x + tabBounds.width + 1,
  );
  await activeEditor().click();
  await page.keyboard.insertText("second tab");

  await firstTab.click();
  await expect.poll(() => readEditorSource(activeEditor())).toBe("first tab");
  await page.keyboard.insertText("X");
  await expect.poll(() => readEditorSource(activeEditor())).toBe("firstX tab");
  await activeEditor().press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(activeEditor())).toBe("first tab");

  await secondTab.click();
  await expect.poll(() => readEditorSource(activeEditor())).toBe("second tab");
  await secondTab.press("ArrowLeft");
  await expect(firstTab).toHaveAttribute("aria-selected", "true");
  await firstTab.press("ArrowRight");
  await expect(secondTab).toHaveAttribute("aria-selected", "true");

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "关闭 未命名 2" }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "关闭 未命名 2" }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(firstTab).toHaveAttribute("aria-selected", "true");
  await expect(firstTab).toBeFocused();
  await expect.poll(() => readEditorSource(activeEditor())).toBe("first tab");
});

test("KaTeX and Mermaid previews fail independently and preserve source", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = [
    "```katex",
    "\\frac{a}{b}",
    "```",
    "",
    "```katex",
    "\\notARealCommand{",
    "```",
    "",
    "```mermaid",
    "flowchart LR",
    "A --> B",
    "```",
    "",
    "```mermaid",
    "not a diagram",
    "```",
    "",
    "```mermaid",
    "flowchart LR",
    'click A "https://example.com"',
    "```",
  ].join("\n");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  await page.getByRole("radio", { name: "混合" }).click();
  await page.waitForTimeout(250);
  expect(pageErrors).toEqual([]);

  const widgets = page.locator(".cm-md-complex-widget");
  await expect(widgets).toHaveCount(5);
  await expect(
    page.locator('.cm-md-complex-widget[data-md-render-state="ready"]'),
  ).toHaveCount(3, { timeout: 15_000 });
  await expect(
    page.locator('.cm-md-complex-widget[data-md-render-state="error"]'),
  ).toHaveCount(2);
  await expect(
    page.locator('[data-md-complex-widget="katex"] .katex'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-md-complex-widget="mermaid"] svg'),
  ).toHaveCount(2);
  const unsafeMermaidOutput = await page
    .locator('[data-md-complex-widget="mermaid"] svg')
    .evaluateAll((svgs) =>
      svgs.flatMap((svg) => {
        const elements = [svg, ...svg.querySelectorAll("*")];
        return elements.flatMap((element) =>
          [...element.attributes]
            .filter((attribute) => {
              const name = attribute.name.toLocaleLowerCase();
              const value = attribute.value.trim().toLocaleLowerCase();
              return (
                name.startsWith("on") ||
                ((name === "href" || name === "xlink:href") &&
                  value !== "" &&
                  !value.startsWith("#"))
              );
            })
            .map((attribute) => `${element.tagName}:${attribute.name}`),
        );
      }),
    );
  expect(unsafeMermaidOutput).toEqual([]);
  await expect(
    page.locator('[data-md-complex-widget="mermaid"] script'),
  ).toHaveCount(0);
  await expect(page.locator(".cm-md-complex-error").first()).toContainText(
    "源码仍可编辑和保存",
  );
  const firstKatex = page
    .getByRole("button", { name: "编辑 KaTeX 数学源码" })
    .first();
  await expect(firstKatex).toHaveAttribute("data-md-source-block", /frac/u);
  await firstKatex.press("Enter");
  await expect(
    page.locator('[data-md-complex-widget="katex"]').first(),
  ).not.toHaveAttribute("data-md-source-block");
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  await editor.press("ControlOrMeta+End");
  await editor.press("x");
  await expect.poll(() => readEditorSource(editor)).toBe(`${source}x`);
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  await page.getByRole("radio", { name: "源码", exact: true }).click();
  await expect(widgets).toHaveCount(0);
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});

test("profile extensions share reversible live previews", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = [
    "---",
    "title: 扩展语法",
    "---",
    "[toc]",
    "# 第一章",
    "> [!TIP]",
    "> 保持源码可逆。",
    "正文包含 $x^2 + y^2$[^说明]。",
    "[^说明]: 这是脚注。",
    "$$",
    "E = mc^2",
    "$$",
  ].join("\n");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  await editor.press("ControlOrMeta+End");
  await page.getByRole("radio", { name: "混合" }).click();

  await expect(
    page.locator('[data-md-extension-preview="front-matter"]'),
  ).toBeVisible();
  await expect(page.locator('[data-md-extension-preview="toc"]')).toContainText(
    "第一章",
  );
  await expect(
    page.locator('[data-md-extension-preview="alert"]'),
  ).toContainText("保持源码可逆");
  await expect(
    page.locator('[data-md-extension-preview="footnote-reference"]'),
  ).toContainText("说明");
  await expect(
    page.locator('[data-md-extension-preview="footnote-definition"]'),
  ).toContainText("这是脚注");
  await expect(
    page.locator(
      '[data-md-complex-widget="katex"][data-md-render-state="ready"]',
    ),
  ).toHaveCount(2);
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  await page.getByRole("button", { name: "编辑提示块源码" }).press("Enter");
  await expect.poll(() => readEditorSource(editor)).toBe(source);
  await expect(page.locator('[data-md-extension-preview="alert"]')).toHaveCount(
    0,
  );
  await editor.press("x");
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});

test("M4 writing flow stays canonical through recovery, save, and export", async ({
  page,
}) => {
  await installNativeAdapterMock(page);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/");

  let editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const seededSource = [
    "# M4 验收",
    "",
    "这是一段可靠写作草稿。",
    "",
    "## 清单",
    "",
    "- [ ] 校验源码",
    "",
    "正文引用脚注[^可靠]。",
    "",
    "[^可靠]: 恢复后仍能找到脚注。",
    "",
    "$$",
    "E = mc^2",
    "$$",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[输入] --> B[输出]",
    "```",
  ].join("\n");
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(seededSource);
  const hybridButton = page.getByRole("radio", { name: "混合" });
  await hybridButton.click();
  await expect(hybridButton).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".cm-md-heading-1")).toContainText("M4 验收");
  await expect(
    page.locator('[data-md-complex-widget="katex"]'),
  ).toHaveAttribute("data-md-render-state", "ready");
  await expect(
    page.locator('[data-md-complex-widget="mermaid"]'),
  ).toHaveAttribute("data-md-render-state", "ready");
  await expect(
    page.locator('[data-md-extension-preview="footnote-reference"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-md-extension-preview="footnote-definition"]'),
  ).toBeVisible();

  await page.getByRole("button", { name: "查找 / 替换" }).click();
  const find = page.getByRole("textbox", { name: "查找" });
  const replace = page.getByRole("textbox", { name: "替换" });
  await find.fill("草稿");
  await replace.fill("终稿");
  await page.getByRole("button", { name: "全部替换", exact: true }).click();
  let expectedSource = seededSource.replace("草稿", "终稿");
  await expect.poll(() => readEditorSource(editor)).toBe(expectedSource);
  await page.keyboard.press("Escape");

  const task = page.locator('[data-md-task-checkbox="true"]');
  await task.click();
  expectedSource = expectedSource.replace("- [ ] 校验源码", "- [x] 校验源码");
  await expect.poll(() => readEditorSource(editor)).toBe(expectedSource);

  await editor.focus();
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\n");
  await page.keyboard.type("*");
  await page.keyboard.insertText("重点");
  await page.keyboard.type("*");
  expectedSource += "\n\n*重点*";
  await expect.poll(() => readEditorSource(editor)).toBe(expectedSource);

  await editor.press("ControlOrMeta+End");
  const sourceBeforeIme = expectedSource;
  await page.keyboard.insertText("\n\n");
  const devtools = await page.context().newCDPSession(page);
  await devtools.send("Input.imeSetComposition", {
    text: "中",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await devtools.send("Input.imeSetComposition", {
    text: "中文，A🙂",
    selectionStart: 6,
    selectionEnd: 6,
  });
  await devtools.send("Input.insertText", { text: "中文，A🙂" });
  expectedSource += "\n\n中文，A🙂";
  await expect.poll(() => readEditorSource(editor)).toBe(expectedSource);
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe(sourceBeforeIme);
  await editor.press(redoShortcut);
  await expect.poll(() => readEditorSource(editor)).toBe(expectedSource);

  await page.getByRole("button", { name: "大纲" }).click();
  const outline = page.getByRole("navigation", { name: "文档大纲" });
  await outline.getByRole("searchbox", { name: "筛选大纲" }).fill("清单");
  await expect(outline.locator(".outline-jump")).toHaveCount(1);
  await outline.getByRole("button", { name: "清单" }).click();
  await page.locator("details.format-menu > summary").click();
  await page.getByRole("button", { name: "专注", exact: true }).click();
  await page.getByRole("button", { name: "打字机", exact: true }).click();
  await expect(page.locator(".cm-focus-dimmed").first()).toBeVisible();
  await expect(hybridButton).toHaveAttribute("aria-checked", "true");

  await expect
    .poll(
      async () => {
        const bytes = (await readNativeMockState(page)).recovery;
        if (bytes === null) return null;
        const snapshot = parseRecoverySnapshot(Uint8Array.from(bytes));
        return snapshot.documents.find(
          ({ session }) => session.id === snapshot.activeId,
        )?.text;
      },
      { timeout: 5_000 },
    )
    .toBe(expectedSource);

  await page.reload();
  await expect(page.getByText(/已恢复.*未保存内容/u)).toBeVisible();
  editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await expect.poll(() => readEditorSource(editor)).toBe(expectedSource);
  await page.getByRole("radio", { name: "混合" }).click();

  await clickFileAction(page, "另存为");
  await expect(page.getByRole("status")).toContainText("已安全保存");
  await expect(
    page.getByText("M4验收.md", { exact: false }).first(),
  ).toBeVisible();
  const savedState = await readNativeMockState(page);
  expect(
    new TextDecoder().decode(Uint8Array.from(savedState.savedMarkdown ?? [])),
  ).toBe(expectedSource);
  await expect
    .poll(async () => (await readNativeMockState(page)).recovery)
    .toBeNull();

  await page.getByText("导出", { exact: true }).click();
  await page.getByRole("button", { name: "导出带样式 HTML" }).click();
  await expect(page.getByRole("status")).toContainText(
    "HTML 已导出：C:\\验收\\M4验收.html",
  );
  const exportedState = await readNativeMockState(page);
  const html = new TextDecoder().decode(
    Uint8Array.from(exportedState.exportedHtml ?? []),
  );
  expect(html).toContain("<em>重点</em>");
  expect(html).toContain('type="checkbox"');
  expect(html).toContain("checked");
  expect(html).toContain('class="md-math md-math-block"');
  expect(html).toContain('class="md-footnotes"');
  expect(html).toContain('class="md-diagram-image"');
  expect(html).toContain('src="data:image/svg+xml;base64,');
  expect(html).not.toContain('class="language-mermaid"');
  expect(html).toContain("中文，A🙂");
  expect(html).not.toContain("<script");
  await expect(page.getByRole("radio", { name: "混合" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect.poll(() => readEditorSource(editor)).toBe(expectedSource);

  const commands = (await readNativeMockState(page)).commands;
  expect(commands).toEqual(
    expect.arrayContaining([
      "save_recovery_snapshot",
      "load_recovery_snapshot",
      "plugin:dialog|message",
      "save_document_as",
      "export_html",
    ]),
  );
});

test("HTML and print exports are sanitized derivatives and preserve editor state", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    const root = window as typeof window & {
      __mdeditorPrintSandbox?: string;
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof HTMLIFrameElement &&
            node.classList.contains("document-print-frame")
          ) {
            root.__mdeditorPrintSandbox = node.getAttribute("sandbox") ?? "";
            if (node.contentWindow !== null) {
              node.contentWindow.print = () => undefined;
            }
          }
        }
      }
    });
    observer.observe(document.body, { childList: true });
  });
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = [
    "---",
    "title: 安全导出",
    "---",
    "[toc]",
    "# 安全导出",
    "",
    "> [!WARNING]",
    "> **扩展语法**也必须经过清洗。",
    "",
    "公式 $x < y$ 与脚注[^安全]。",
    "[^安全]: 脚注正文。",
    "",
    "$$a < b$$",
    "",
    "```mermaid",
    "flowchart LR",
    "A --> B",
    "```",
    "",
    "# 第二节",
    "",
    "| 名称 | 值 |",
    "| --- | --- |",
    "| 中文 | **正常** |",
    "",
    "- [x] 已完成",
    "",
    '<div class="page-break"></div>',
    "",
    '[危险链接](javascript:alert(1)) <img src="x" onerror="alert(2)"> <input type="text" value="伪造控件">',
    '<script>alert(3)</script><iframe src="https://example.com"></iframe>',
  ].join("\n");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  const revision = await page.getByText(/^修订 \d+$/u).textContent();

  await page.getByText("导出", { exact: true }).click();
  await page.getByRole("combobox", { name: "打印纸张" }).selectOption("Letter");
  await page
    .getByRole("combobox", { name: "打印方向" })
    .selectOption("landscape");
  await page.getByRole("combobox", { name: "打印边距" }).selectOption("narrow");
  await page.getByRole("checkbox", { name: "一级标题间分页" }).check();
  await page.getByRole("textbox", { name: "PDF 页眉模板" }).fill("${title}");
  await page
    .getByRole("textbox", { name: "PDF 页脚模板" })
    .fill("第 ${pageNo} / ${pageCount} 页");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出带样式 HTML" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (downloadPath === null) throw new Error("HTML download has no local path");
  const html = await readFile(downloadPath, "utf8");

  expect(html).toContain("<!doctype html>");
  expect(html).toContain("Content-Security-Policy");
  expect(html).toContain("@media print");
  expect(html).toContain("@page {");
  expect(html).toContain("size: Letter landscape;");
  expect(html).toContain("margin: 10mm;");
  expect(html).toContain("@top-center");
  expect(html).toContain('content: "未命名";');
  expect(html).toContain("@bottom-center");
  expect(html).toContain(
    'content: "第 " counter(page) " / " counter(pages) " 页";',
  );
  expect(html).toContain(
    "body > h1 ~ h1, body > .md-footnotes { break-before: page; page-break-before: always; }",
  );
  expect(html).toContain(
    ".page-break { display: block; break-after: page; page-break-after: always; }",
  );
  expect(html).toContain("<table>");
  expect(html).toContain('class="md-front-matter"');
  expect(html).toContain('class="md-toc"');
  expect(html).toContain('class="md-alert md-alert-warning"');
  expect(html).toContain('class="md-math md-math-inline"');
  expect(html).toContain('class="md-math md-math-block"');
  expect(html).toContain('<span class="katex"><math');
  expect(html).not.toContain('class="md-math md-math-inline"><code>');
  expect(html).not.toContain('class="md-math md-math-block"><code>');
  expect(html).toContain('class="md-diagram-image"');
  expect(html).toContain('src="data:image/svg+xml;base64,');
  expect(html).not.toContain('class="language-mermaid"');
  const encodedSvg = /src="data:image\/svg\+xml;base64,([a-z0-9+/]+=*)"/iu.exec(
    html,
  )?.[1];
  expect(encodedSvg).toBeDefined();
  const exportedSvg = Buffer.from(encodedSvg ?? "", "base64").toString("utf8");
  expect(exportedSvg).not.toMatch(/<script|\son[a-z]+\s*=|@import/iu);
  expect(html).toContain('class="md-footnotes"');
  expect(html).toContain('href="#user-content-md-heading-安全导出"');
  expect(html).toContain('type="checkbox"');
  expect(html).toContain("disabled");
  expect(html).toContain('<div class="page-break"></div>');
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<iframe");
  expect(html).not.toContain("onerror");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('type="text"');
  const printOutput = await page.context().newPage();
  await printOutput.setContent(html, { waitUntil: "load" });
  await printOutput.emulateMedia({ media: "print" });
  expect(
    await printOutput.evaluate(() =>
      [...document.styleSheets]
        .flatMap((sheet) => [...sheet.cssRules])
        .map((rule) => rule.cssText)
        .find((cssText) => cssText.startsWith("@page")),
    ),
  ).toMatch(/@top-center[\s\S]*counter\(page\)[\s\S]*counter\(pages\)/u);
  expect(await printOutput.pdf({ format: "Letter", landscape: true })).toEqual(
    expect.objectContaining({ 0: 0x25, 1: 0x50, 2: 0x44, 3: 0x46 }),
  );
  expect(
    await printOutput.evaluate(() => {
      const headings = document.querySelectorAll("h1");
      const pageBreak = document.querySelector<HTMLElement>(".page-break");
      const footnotes = document.querySelector<HTMLElement>(".md-footnotes");
      return {
        footnoteBreakBefore:
          footnotes === null ? null : getComputedStyle(footnotes).breakBefore,
        headingBreakBefore:
          headings[1] === undefined
            ? null
            : getComputedStyle(headings[1]).breakBefore,
        manualBreakAfter:
          pageBreak === null ? null : getComputedStyle(pageBreak).breakAfter,
        manualDisplay:
          pageBreak === null ? null : getComputedStyle(pageBreak).display,
      };
    }),
  ).toEqual({
    footnoteBreakBefore: "page",
    headingBreakBefore: "page",
    manualBreakAfter: "page",
    manualDisplay: "block",
  });
  await printOutput.close();
  await expect.poll(() => readEditorSource(editor)).toBe(source);
  await expect(
    page.getByText(revision ?? "missing revision", { exact: true }),
  ).toBeVisible();

  const unstyledDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出无样式 HTML" }).click();
  const unstyledDownload = await unstyledDownloadPromise;
  expect(unstyledDownload.suggestedFilename()).toBe("未命名.unstyled.html");
  const unstyledDownloadPath = await unstyledDownload.path();
  if (unstyledDownloadPath === null) {
    throw new Error("Unstyled HTML download has no local path");
  }
  const unstyledHtml = await readFile(unstyledDownloadPath, "utf8");
  expect(unstyledHtml).toContain("<!doctype html>");
  expect(unstyledHtml).toContain("style-src 'none'");
  expect(unstyledHtml).not.toContain("<style>");
  expect(unstyledHtml).not.toContain("@page");
  expect(unstyledHtml).not.toContain("data-theme");
  expect(unstyledHtml).toContain("<table>");
  expect(unstyledHtml).toContain('class="md-toc"');
  expect(unstyledHtml).toContain('class="md-alert md-alert-warning"');
  expect(unstyledHtml).toContain('<span class="katex"><math');
  expect(unstyledHtml).not.toContain('class="md-math md-math-inline"><code>');
  expect(unstyledHtml).not.toContain('class="md-math md-math-block"><code>');
  expect(unstyledHtml).toContain('class="md-diagram-image"');
  expect(unstyledHtml).toContain('src="data:image/svg+xml;base64,');
  expect(unstyledHtml).not.toContain('class="language-mermaid"');
  expect(unstyledHtml).toContain('class="md-footnotes"');
  expect(unstyledHtml).not.toContain("<script");
  expect(unstyledHtml).not.toContain("<iframe");
  expect(unstyledHtml).not.toContain("onerror");
  expect(unstyledHtml).not.toContain('href="javascript:');
  await expect.poll(() => readEditorSource(editor)).toBe(source);
  await expect(
    page.getByText(revision ?? "missing revision", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "打印 / PDF" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __mdeditorPrintSandbox?: string;
            }
          ).__mdeditorPrintSandbox,
      ),
    )
    .toBe("allow-modals allow-same-origin");
  await expect(
    page.getByText("已打开系统打印，可选择另存为 PDF"),
  ).toBeVisible();
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});

test("M6 benchmark stays structurally and visually aligned across output surfaces", async ({
  page,
}) => {
  const source = await readFile(
    new URL("../fixtures/m6-output-benchmark.md", import.meta.url),
    "utf8",
  );
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  await editor.press("ControlOrMeta+End");
  await page.getByRole("radio", { name: "混合" }).click();

  await expect(
    page.locator('[data-md-extension-preview="front-matter"]'),
  ).toBeVisible();
  await expect(page.locator('[data-md-extension-preview="toc"]')).toContainText(
    "Delivery matrix",
  );
  await expect(
    page.locator('[data-md-extension-preview="alert"]'),
  ).toContainText("One canonical source powers every surface.");
  await expect(
    page.locator(
      '[data-md-complex-widget="katex"][data-md-render-state="ready"]',
    ),
  ).toHaveCount(2);
  await expect(
    page.locator(
      '[data-md-complex-widget="mermaid"][data-md-render-state="ready"]',
    ),
  ).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('[data-md-table-preview="true"]')).toHaveCount(1);
  await expect(page.locator('[data-md-task-checkbox="true"]')).toHaveCount(2);
  await expect(
    page.locator('[data-md-extension-preview="footnote-definition"]'),
  ).toContainText("byte-for-byte unchanged");
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  await page.locator(".cm-scroller").evaluate((element) => {
    element.scrollTop = 0;
  });
  if (process.platform === "win32") {
    const editorPng = await page.locator(".editor-host").screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "css",
    });
    expect(await normalizeSnapshotHeight(page, editorPng, 755)).toMatchSnapshot(
      "m6-benchmark-editor.png",
      { maxDiffPixelRatio: 0.02 },
    );
  }

  await page.getByText("导出", { exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出带样式 HTML" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (downloadPath === null) throw new Error("HTML download has no local path");
  const html = await readFile(downloadPath, "utf8");

  const outputPage = await page.context().newPage();
  await outputPage.setViewportSize({ width: 1200, height: 900 });
  await outputPage.setContent(html, { waitUntil: "load" });
  await expect(outputPage.locator(".md-diagram-image")).toHaveCount(1);
  await expect(outputPage.locator(".md-diagram-image")).toHaveAttribute(
    "src",
    /^data:image\/svg\+xml;base64,/u,
  );
  await expect(outputPage.locator(".md-math math")).toHaveCount(2);
  await expect(outputPage.locator(".md-math > code")).toHaveCount(0);

  const expectedStructure = {
    alerts: 1,
    checkedTasks: 2,
    diagrams: 1,
    footnotes: 1,
    headings: ["Output Benchmark", "Delivery matrix"],
    math: 2,
    tableRows: 4,
    tocLinks: 2,
  };
  const readOutputStructure = () =>
    outputPage.locator("body").evaluate((body) => ({
      alerts: body.querySelectorAll(".md-alert").length,
      checkedTasks: body.querySelectorAll('input[type="checkbox"]:checked')
        .length,
      diagrams: body.querySelectorAll(".md-diagram-image").length,
      footnotes: body.querySelectorAll(".md-footnotes").length,
      headings: [...body.querySelectorAll("h1, h2")].map(
        (heading) => heading.textContent?.trim() ?? "",
      ),
      math: body.querySelectorAll(".md-math").length,
      tableRows: body.querySelectorAll("table tr").length,
      tocLinks: body.querySelectorAll(".md-toc a").length,
    }));

  expect(await readOutputStructure()).toEqual(expectedStructure);
  if (process.platform === "win32") {
    const styledPng = await outputPage.locator("body").screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "css",
    });
    expect(
      await normalizeSnapshotHeight(outputPage, styledPng, 1432),
    ).toMatchSnapshot("m6-benchmark-styled-html.png", {
      maxDiffPixelRatio: 0.02,
    });
  }

  await outputPage.emulateMedia({ media: "print" });
  expect(await readOutputStructure()).toEqual(expectedStructure);
  expect(
    await outputPage.locator("body").evaluate((body) => ({
      background: getComputedStyle(body).backgroundColor,
      color: getComputedStyle(body).color,
      maxWidth: getComputedStyle(body).maxWidth,
      padding: getComputedStyle(body).padding,
    })),
  ).toEqual({
    background: "rgb(255, 255, 255)",
    color: "rgb(17, 17, 17)",
    maxWidth: "none",
    padding: "0px",
  });
  if (process.platform === "win32") {
    const printPng = await outputPage.locator("body").screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "css",
    });
    expect(
      await normalizeSnapshotHeight(outputPage, printPng, 1388),
    ).toMatchSnapshot("m6-benchmark-print-media.png", {
      maxDiffPixelRatio: 0.02,
    });
  }

  await expect.poll(() => readEditorSource(editor)).toBe(source);
  await outputPage.close();
});
