export {
  decodeDocument,
  encodeDocument,
  normalizeLineEndings,
} from "./codec.js";
export {
  createUntitledSession,
  isDirty,
  recordEdit,
  recordSave,
} from "./session.js";
export {
  createRecoverySnapshot,
  createWorkspaceRecoverySnapshot,
  parseRecoverySnapshot,
  serializeRecoverySnapshot,
} from "./recovery.js";
export type {
  DecodeDocumentOptions,
  DecodedDocument,
  DocumentAdapter,
  DocumentEncoding,
  DocumentSession,
  LineEnding,
  OpenedDocumentFile,
  ReadOnlyReason,
  RecoveryDocument,
  RecoverySnapshot,
  SaveDocumentAsRequest,
  SaveDocumentRequest,
  SavedDocumentFile,
} from "./types.js";
