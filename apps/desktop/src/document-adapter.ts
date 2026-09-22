import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { AppShellProps } from "@mdeditor/ui";
import {
  parseRecoverySnapshot,
  serializeRecoverySnapshot,
  type WorkspaceImageInspection,
  type WorkspaceImageConsolidationPreview,
  type WorkspaceImageMovePreview,
  type WorkspaceImageReferenceInspection,
  type WorkspaceDocumentMovePreview,
  type WorkspaceSearchEvent,
} from "@mdeditor/document-session";

type DocumentAdapter = NonNullable<AppShellProps["documentAdapter"]>;
type OpenedDocumentFile = Awaited<ReturnType<DocumentAdapter["openDocument"]>>;
type OpenedDocument = NonNullable<OpenedDocumentFile>;
type SaveDocumentRequest = Parameters<DocumentAdapter["saveDocument"]>[0];
type SaveDocumentAsRequest = Parameters<DocumentAdapter["saveDocumentAs"]>[0];
type ExportHtmlRequest = Parameters<DocumentAdapter["exportHtml"]>[0];
type ExportImageRequest = Parameters<DocumentAdapter["exportImage"]>[0];
type ExportDocxRequest = Parameters<DocumentAdapter["exportDocx"]>[0];
type SavedDocumentFile = Awaited<ReturnType<DocumentAdapter["saveDocument"]>>;
type OpenedWorkspace = Awaited<ReturnType<DocumentAdapter["openWorkspace"]>>;

interface OpenDocumentResponse {
  readonly path: string;
  readonly bytes: number[];
  readonly diskFingerprint: string;
}

type ExternalDocumentResponse =
  | { readonly kind: "opened"; readonly document: OpenDocumentResponse }
  | { readonly kind: "error"; readonly path: string; readonly message: string };

interface OpenWorkspaceLinkResponse {
  readonly document: OpenDocumentResponse;
  readonly relativePath: string;
  readonly fragment: string | null;
}

interface ImportedWorkspaceImageResponse {
  readonly relativePath: string;
  readonly markdownPath: string;
  readonly suggestedAlt: string;
}

interface SaveDocumentPayload {
  readonly path: string;
  readonly bytes: number[];
  readonly expectedFingerprint: string;
}

interface SaveDocumentAsPayload {
  readonly bytes: number[];
  readonly suggestedName: string;
}

interface ExportHtmlPayload {
  readonly bytes: number[];
  readonly suggestedName: string;
}

interface ExportImagePayload {
  readonly bytes: number[];
  readonly suggestedName: string;
}

interface ExportDocxPayload {
  readonly bytes: number[];
  readonly suggestedName: string;
}

function toSavedDocument(response: SavedDocumentFile): SavedDocumentFile {
  return response;
}

function toOpenedDocument(response: OpenDocumentResponse): OpenedDocument {
  return { ...response, bytes: Uint8Array.from(response.bytes) };
}

function toExternalDocumentEvent(response: ExternalDocumentResponse) {
  return response.kind === "opened"
    ? { kind: "opened" as const, document: toOpenedDocument(response.document) }
    : response;
}

export function createDesktopDocumentAdapter(): DocumentAdapter {
  return {
    async openDocument(): Promise<OpenedDocumentFile> {
      const response = await invoke<OpenDocumentResponse | null>(
        "open_document",
      );
      if (response === null) return null;

      return toOpenedDocument(response);
    },

    async openStartupDocuments() {
      const responses = await invoke<ExternalDocumentResponse[]>(
        "open_startup_documents",
      );
      return responses.map(toExternalDocumentEvent);
    },

    async subscribeExternalDocuments(listener) {
      return listen("external-document-opened", (event) => {
        listener(
          toExternalDocumentEvent(event.payload as ExternalDocumentResponse),
        );
      });
    },

    async openWorkspace(): Promise<OpenedWorkspace> {
      return invoke<OpenedWorkspace>("open_workspace");
    },

    async refreshWorkspace(root) {
      return invoke<NonNullable<OpenedWorkspace>>("refresh_workspace", {
        root,
      });
    },

    async closeWorkspace(root) {
      await invoke("close_workspace", { root });
    },

    async subscribeWorkspaceChanges(listener) {
      return listen("workspace-changed", (event) => {
        listener(event.payload as { readonly root: string });
      });
    },

    async openWorkspaceDocument(root, relativePath) {
      const response = await invoke<OpenDocumentResponse>(
        "open_workspace_document",
        { root, relativePath },
      );
      return toOpenedDocument(response);
    },

    async openWorkspaceLink(root, sourceRelativePath, target) {
      const response = await invoke<OpenWorkspaceLinkResponse>(
        "open_workspace_link",
        { root, sourceRelativePath, target },
      );
      return {
        ...response,
        document: toOpenedDocument(response.document),
      };
    },

    async openExternalUrl(url) {
      await openUrl(url);
    },

    async importWorkspaceImage(root, sourceRelativePath) {
      return invoke<ImportedWorkspaceImageResponse | null>(
        "import_workspace_image",
        { root, sourceRelativePath },
      );
    },

    async importWorkspaceImageData(root, sourceRelativePath, fileName, bytes) {
      return invoke<ImportedWorkspaceImageResponse>(
        "import_workspace_image_data",
        {
          root,
          sourceRelativePath,
          fileName,
          bytes: [...bytes],
        },
      );
    },

    async readWorkspaceImage(root, sourceRelativePath, target) {
      const response = await invoke<{ readonly dataUrl: string }>(
        "read_workspace_image",
        { root, sourceRelativePath, target },
      );
      return response.dataUrl;
    },

    async inspectWorkspaceImages(root) {
      return invoke<WorkspaceImageInspection>("inspect_workspace_images", {
        root,
      });
    },

    async previewWorkspaceImageMove(
      root,
      sourceRelativePath,
      destinationRelativePath,
    ) {
      return invoke<WorkspaceImageMovePreview>("preview_workspace_image_move", {
        root,
        sourceRelativePath,
        destinationRelativePath,
      });
    },

    async inspectWorkspaceImageReferences(root, sourceRelativePath) {
      return invoke<WorkspaceImageReferenceInspection>(
        "inspect_workspace_image_references",
        { root, sourceRelativePath },
      );
    },

    async moveWorkspaceImageWithReferences(
      root,
      sourceRelativePath,
      destinationRelativePath,
    ) {
      return invoke<readonly string[]>("move_workspace_image_with_references", {
        root,
        sourceRelativePath,
        destinationRelativePath,
      });
    },

    async copyWorkspaceImageWithReferences(
      root,
      sourceRelativePath,
      destinationRelativePath,
    ) {
      return invoke<readonly string[]>("copy_workspace_image_with_references", {
        root,
        sourceRelativePath,
        destinationRelativePath,
      });
    },

    async previewWorkspaceImageConsolidation(root, destinationRelativePath) {
      return invoke<WorkspaceImageConsolidationPreview>(
        "preview_workspace_image_consolidation",
        { root, destinationRelativePath },
      );
    },

    async consolidateWorkspaceImages(
      root,
      destinationRelativePath,
      expectedPreview,
    ) {
      return invoke<readonly string[]>("consolidate_workspace_images", {
        root,
        destinationRelativePath,
        expectedPreview,
      });
    },

    async previewWorkspaceDocumentMove(
      root,
      sourceRelativePath,
      destinationRelativePath,
    ) {
      return invoke<WorkspaceDocumentMovePreview>(
        "preview_workspace_document_move",
        { root, sourceRelativePath, destinationRelativePath },
      );
    },

    async moveWorkspaceDocumentWithLinks(
      root,
      sourceRelativePath,
      destinationRelativePath,
    ) {
      return invoke<readonly string[]>("move_workspace_document_with_links", {
        root,
        sourceRelativePath,
        destinationRelativePath,
      });
    },

    async createWorkspaceFile(root, relativePath) {
      const response = await invoke<OpenDocumentResponse>(
        "create_workspace_file",
        { root, relativePath },
      );
      return toOpenedDocument(response);
    },

    async createWorkspaceDirectory(root, relativePath) {
      await invoke("create_workspace_directory", { root, relativePath });
    },

    async moveWorkspaceEntry(
      root,
      sourceRelativePath,
      destinationRelativePath,
    ) {
      return invoke<
        readonly { readonly fromPath: string; readonly toPath: string }[]
      >("move_workspace_entry", {
        root,
        sourceRelativePath,
        destinationRelativePath,
      });
    },

    async copyWorkspaceEntry(
      root,
      sourceRelativePath,
      destinationRelativePath,
    ) {
      await invoke("copy_workspace_entry", {
        root,
        sourceRelativePath,
        destinationRelativePath,
      });
    },

    async deleteWorkspaceEntry(root, relativePath) {
      await invoke("delete_workspace_entry", { root, relativePath });
    },

    async deleteWorkspaceImage(root, relativePath, expectedReferences) {
      await invoke("delete_workspace_image", {
        root,
        relativePath,
        expectedReferences,
      });
    },

    async releaseDocumentAuthorization(path) {
      await invoke("release_document_authorization", { path });
    },

    async subscribeWorkspaceSearch(listener) {
      return listen("workspace-search", (event) => {
        listener(event.payload as WorkspaceSearchEvent);
      });
    },

    async startWorkspaceSearch(root, requestId, query, options) {
      await invoke("start_workspace_search", {
        root,
        requestId,
        query,
        options,
      });
    },

    async cancelWorkspaceSearch(requestId) {
      await invoke("cancel_workspace_search", { requestId });
    },

    async openRecentDocument(path): Promise<NonNullable<OpenedDocumentFile>> {
      const response = await invoke<OpenDocumentResponse>(
        "open_recent_document",
        { path },
      );
      return toOpenedDocument(response);
    },

    async listRecentDocuments() {
      return invoke<string[]>("list_recent_documents");
    },

    async saveDocument(
      request: SaveDocumentRequest,
    ): Promise<SavedDocumentFile> {
      const payload: SaveDocumentPayload = {
        ...request,
        bytes: Array.from(request.bytes),
      };
      return toSavedDocument(
        await invoke<SavedDocumentFile>("save_document", { request: payload }),
      );
    },

    async saveDocumentAs(
      request: SaveDocumentAsRequest,
    ): Promise<SavedDocumentFile | null> {
      const payload: SaveDocumentAsPayload = {
        ...request,
        bytes: Array.from(request.bytes),
      };
      const response = await invoke<SavedDocumentFile | null>(
        "save_document_as",
        { request: payload },
      );
      return response === null ? null : toSavedDocument(response);
    },

    async exportHtml(request: ExportHtmlRequest): Promise<string | null> {
      const payload: ExportHtmlPayload = {
        ...request,
        bytes: Array.from(request.bytes),
      };
      return invoke<string | null>("export_html", { request: payload });
    },

    async exportImage(request: ExportImageRequest): Promise<string | null> {
      const payload: ExportImagePayload = {
        ...request,
        bytes: Array.from(request.bytes),
      };
      return invoke<string | null>("export_image", { request: payload });
    },

    async getPandocStatus() {
      return invoke("get_pandoc_status");
    },

    async exportDocx(request: ExportDocxRequest): Promise<string | null> {
      const payload: ExportDocxPayload = {
        ...request,
        bytes: Array.from(request.bytes),
      };
      return invoke<string | null>("export_docx", { request: payload });
    },

    async loadRecoverySnapshot() {
      const bytes = await invoke<number[] | null>("load_recovery_snapshot");
      return bytes === null
        ? null
        : parseRecoverySnapshot(Uint8Array.from(bytes));
    },

    async saveRecoverySnapshot(snapshot) {
      await invoke("save_recovery_snapshot", {
        bytes: Array.from(serializeRecoverySnapshot(snapshot)),
      });
    },

    async clearRecoverySnapshot() {
      await invoke("clear_recovery_snapshot");
    },
  };
}
