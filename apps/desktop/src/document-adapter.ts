import { invoke } from "@tauri-apps/api/core";

import type { AppShellProps } from "@mdeditor/ui";
import {
  parseRecoverySnapshot,
  serializeRecoverySnapshot,
} from "@mdeditor/document-session";

type DocumentAdapter = NonNullable<AppShellProps["documentAdapter"]>;
type OpenedDocumentFile = Awaited<ReturnType<DocumentAdapter["openDocument"]>>;
type SaveDocumentRequest = Parameters<DocumentAdapter["saveDocument"]>[0];
type SaveDocumentAsRequest = Parameters<DocumentAdapter["saveDocumentAs"]>[0];
type ExportHtmlRequest = Parameters<DocumentAdapter["exportHtml"]>[0];
type SavedDocumentFile = Awaited<ReturnType<DocumentAdapter["saveDocument"]>>;

interface OpenDocumentResponse {
  readonly path: string;
  readonly bytes: number[];
  readonly diskFingerprint: string;
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

function toSavedDocument(response: SavedDocumentFile): SavedDocumentFile {
  return response;
}

export function createDesktopDocumentAdapter(): DocumentAdapter {
  return {
    async openDocument(): Promise<OpenedDocumentFile> {
      const response = await invoke<OpenDocumentResponse | null>(
        "open_document",
      );
      if (response === null) return null;

      return {
        ...response,
        bytes: Uint8Array.from(response.bytes),
      };
    },

    async openRecentDocument(path): Promise<NonNullable<OpenedDocumentFile>> {
      const response = await invoke<OpenDocumentResponse>(
        "open_recent_document",
        { path },
      );
      return {
        ...response,
        bytes: Uint8Array.from(response.bytes),
      };
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
