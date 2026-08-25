export type DocumentEncoding = "utf-8" | "utf-8-bom";
export type LineEnding = "\n" | "\r\n";
export type ReadOnlyReason =
  "unsupported-encoding" | "unsupported-line-ending" | null;

/**
 * Metadata owned by the application layer. Document text is intentionally not
 * stored here; CodeMirror's EditorState owns it once an editor is mounted.
 */
export interface DocumentSession {
  readonly id: string;
  readonly path: string | null;
  readonly encoding: DocumentEncoding;
  readonly lineEnding: LineEnding;
  readonly hasFinalNewline: boolean;
  readonly diskFingerprint: string | null;
  readonly savedRevision: number;
  readonly currentRevision: number;
  readonly readOnly: boolean;
  readonly readOnlyReason: ReadOnlyReason;
}

export interface DecodedDocument {
  readonly session: DocumentSession;
  readonly text: string;
}

export interface DecodeDocumentOptions {
  readonly id: string;
  readonly path?: string | null;
  readonly diskFingerprint?: string | null;
}

export interface OpenedDocumentFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly diskFingerprint: string;
}

export interface SaveDocumentRequest {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly expectedFingerprint: string;
}

export interface SaveDocumentAsRequest {
  readonly bytes: Uint8Array;
  readonly suggestedName: string;
}

export interface SavedDocumentFile {
  readonly path: string;
  readonly diskFingerprint: string;
}

export interface RecoveryDocument {
  readonly text: string;
  readonly session: DocumentSession;
}

export interface RecoverySnapshot {
  readonly version: 2;
  readonly capturedAt: string;
  readonly activeId: string;
  readonly documents: readonly RecoveryDocument[];
}

/**
 * The UI depends on this narrow boundary instead of filesystem APIs. Desktop
 * implementations are responsible for path authorization and atomic writes.
 */
export interface DocumentAdapter {
  readonly openDocument: () => Promise<OpenedDocumentFile | null>;
  readonly openRecentDocument: (path: string) => Promise<OpenedDocumentFile>;
  readonly listRecentDocuments: () => Promise<readonly string[]>;
  readonly saveDocument: (
    request: SaveDocumentRequest,
  ) => Promise<SavedDocumentFile>;
  readonly saveDocumentAs: (
    request: SaveDocumentAsRequest,
  ) => Promise<SavedDocumentFile | null>;
  readonly loadRecoverySnapshot: () => Promise<RecoverySnapshot | null>;
  readonly saveRecoverySnapshot: (snapshot: RecoverySnapshot) => Promise<void>;
  readonly clearRecoverySnapshot: () => Promise<void>;
}
