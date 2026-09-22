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

export type ExternalDocumentEvent =
  | { readonly kind: "opened"; readonly document: OpenedDocumentFile }
  | { readonly kind: "error"; readonly path: string; readonly message: string };

export type WorkspaceEntryKind = "directory" | "file";

export interface WorkspaceEntry {
  readonly relativePath: string;
  readonly name: string;
  readonly kind: WorkspaceEntryKind;
  readonly bytes: number | null;
}

export interface OpenedWorkspace {
  readonly root: string;
  readonly name: string;
  readonly entries: readonly WorkspaceEntry[];
}

export interface OpenedWorkspaceLink {
  readonly document: OpenedDocumentFile;
  readonly relativePath: string;
  readonly fragment: string | null;
}

export interface ImportedWorkspaceImage {
  readonly relativePath: string;
  readonly markdownPath: string;
  readonly suggestedAlt: string;
}

export interface WorkspaceImageIssue {
  readonly documentRelativePath: string;
  readonly line: number;
  readonly column: number;
  readonly target: string;
  readonly reason: string;
}

export interface WorkspaceImageInspection {
  readonly issues: readonly WorkspaceImageIssue[];
  readonly truncated: boolean;
}

export interface WorkspaceImageReferenceUpdate {
  readonly documentRelativePath: string;
  readonly line: number;
  readonly column: number;
  readonly fromTarget: string;
  readonly toTarget: string;
}

export interface WorkspaceImageMovePreview {
  readonly updates: readonly WorkspaceImageReferenceUpdate[];
  readonly truncated: boolean;
}

export interface WorkspaceImageConsolidationCopy {
  readonly sourceRelativePath: string;
  readonly destinationRelativePath: string;
  readonly referenceCount: number;
}

export interface WorkspaceImageConsolidationPreview {
  readonly copies: readonly WorkspaceImageConsolidationCopy[];
  readonly updates: readonly WorkspaceImageReferenceUpdate[];
  readonly truncated: boolean;
}

export interface WorkspaceImageReference {
  readonly documentRelativePath: string;
  readonly line: number;
  readonly column: number;
  readonly target: string;
}

export interface WorkspaceImageReferenceInspection {
  readonly references: readonly WorkspaceImageReference[];
  readonly truncated: boolean;
}

export interface WorkspaceDocumentLinkUpdate {
  readonly documentRelativePath: string;
  readonly line: number;
  readonly column: number;
  readonly fromTarget: string;
  readonly toTarget: string;
}

export interface WorkspaceDocumentMovePreview {
  readonly updates: readonly WorkspaceDocumentLinkUpdate[];
  readonly truncated: boolean;
}

export interface WorkspaceChangedEvent {
  readonly root: string;
}

export interface WorkspaceRelocation {
  readonly fromPath: string;
  readonly toPath: string;
}

export interface WorkspaceSearchOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regularExpression: boolean;
}

export interface WorkspaceSearchMatch {
  readonly relativePath: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
}

export type WorkspaceSearchEvent =
  | {
      readonly kind: "batch";
      readonly requestId: string;
      readonly matches: readonly WorkspaceSearchMatch[];
    }
  | {
      readonly kind: "complete";
      readonly requestId: string;
      readonly truncated: boolean;
    }
  | {
      readonly kind: "cancelled";
      readonly requestId: string;
    }
  | {
      readonly kind: "error";
      readonly requestId: string;
      readonly message: string;
    };

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

export interface ExportHtmlRequest {
  readonly bytes: Uint8Array;
  readonly suggestedName: string;
}

export interface ExportImageRequest {
  readonly bytes: Uint8Array;
  readonly suggestedName: string;
}

export interface ExportDocxRequest {
  readonly bytes: Uint8Array;
  readonly suggestedName: string;
}

export interface PandocStatus {
  readonly available: boolean;
  readonly version: string | null;
  readonly installUrl: string;
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
  readonly openStartupDocuments: () => Promise<
    readonly ExternalDocumentEvent[]
  >;
  readonly subscribeExternalDocuments: (
    listener: (event: ExternalDocumentEvent) => void,
  ) => Promise<() => void>;
  readonly openWorkspace: () => Promise<OpenedWorkspace | null>;
  readonly refreshWorkspace: (root: string) => Promise<OpenedWorkspace>;
  readonly closeWorkspace: (root: string) => Promise<void>;
  readonly subscribeWorkspaceChanges: (
    listener: (event: WorkspaceChangedEvent) => void,
  ) => Promise<() => void>;
  readonly openWorkspaceDocument: (
    root: string,
    relativePath: string,
  ) => Promise<OpenedDocumentFile>;
  readonly openWorkspaceLink: (
    root: string,
    sourceRelativePath: string,
    target: string,
  ) => Promise<OpenedWorkspaceLink>;
  readonly openExternalUrl: (url: string) => Promise<void>;
  readonly importWorkspaceImage: (
    root: string,
    sourceRelativePath: string,
  ) => Promise<ImportedWorkspaceImage | null>;
  readonly importWorkspaceImageData: (
    root: string,
    sourceRelativePath: string,
    fileName: string,
    bytes: Uint8Array,
  ) => Promise<ImportedWorkspaceImage>;
  readonly readWorkspaceImage: (
    root: string,
    sourceRelativePath: string,
    target: string,
  ) => Promise<string>;
  readonly inspectWorkspaceImages: (
    root: string,
  ) => Promise<WorkspaceImageInspection>;
  readonly previewWorkspaceImageMove: (
    root: string,
    sourceRelativePath: string,
    destinationRelativePath: string,
  ) => Promise<WorkspaceImageMovePreview>;
  readonly inspectWorkspaceImageReferences: (
    root: string,
    sourceRelativePath: string,
  ) => Promise<WorkspaceImageReferenceInspection>;
  readonly moveWorkspaceImageWithReferences: (
    root: string,
    sourceRelativePath: string,
    destinationRelativePath: string,
  ) => Promise<readonly string[]>;
  readonly copyWorkspaceImageWithReferences: (
    root: string,
    sourceRelativePath: string,
    destinationRelativePath: string,
  ) => Promise<readonly string[]>;
  readonly previewWorkspaceImageConsolidation: (
    root: string,
    destinationRelativePath: string,
  ) => Promise<WorkspaceImageConsolidationPreview>;
  readonly consolidateWorkspaceImages: (
    root: string,
    destinationRelativePath: string,
    expectedPreview: WorkspaceImageConsolidationPreview,
  ) => Promise<readonly string[]>;
  readonly previewWorkspaceDocumentMove: (
    root: string,
    sourceRelativePath: string,
    destinationRelativePath: string,
  ) => Promise<WorkspaceDocumentMovePreview>;
  readonly moveWorkspaceDocumentWithLinks: (
    root: string,
    sourceRelativePath: string,
    destinationRelativePath: string,
  ) => Promise<readonly string[]>;
  readonly createWorkspaceFile: (
    root: string,
    relativePath: string,
  ) => Promise<OpenedDocumentFile>;
  readonly createWorkspaceDirectory: (
    root: string,
    relativePath: string,
  ) => Promise<void>;
  readonly moveWorkspaceEntry: (
    root: string,
    sourceRelativePath: string,
    destinationRelativePath: string,
  ) => Promise<readonly WorkspaceRelocation[]>;
  readonly copyWorkspaceEntry: (
    root: string,
    sourceRelativePath: string,
    destinationRelativePath: string,
  ) => Promise<void>;
  readonly deleteWorkspaceEntry: (
    root: string,
    relativePath: string,
  ) => Promise<void>;
  readonly deleteWorkspaceImage: (
    root: string,
    relativePath: string,
    expectedReferences: readonly WorkspaceImageReference[],
  ) => Promise<void>;
  readonly releaseDocumentAuthorization: (path: string) => Promise<void>;
  readonly subscribeWorkspaceSearch: (
    listener: (event: WorkspaceSearchEvent) => void,
  ) => Promise<() => void>;
  readonly startWorkspaceSearch: (
    root: string,
    requestId: string,
    query: string,
    options: WorkspaceSearchOptions,
  ) => Promise<void>;
  readonly cancelWorkspaceSearch: (requestId: string) => Promise<void>;
  readonly openRecentDocument: (path: string) => Promise<OpenedDocumentFile>;
  readonly listRecentDocuments: () => Promise<readonly string[]>;
  readonly saveDocument: (
    request: SaveDocumentRequest,
  ) => Promise<SavedDocumentFile>;
  readonly saveDocumentAs: (
    request: SaveDocumentAsRequest,
  ) => Promise<SavedDocumentFile | null>;
  readonly exportHtml: (request: ExportHtmlRequest) => Promise<string | null>;
  readonly exportImage: (request: ExportImageRequest) => Promise<string | null>;
  readonly getPandocStatus: () => Promise<PandocStatus>;
  readonly exportDocx: (request: ExportDocxRequest) => Promise<string | null>;
  readonly loadRecoverySnapshot: () => Promise<RecoverySnapshot | null>;
  readonly saveRecoverySnapshot: (snapshot: RecoverySnapshot) => Promise<void>;
  readonly clearRecoverySnapshot: () => Promise<void>;
}
