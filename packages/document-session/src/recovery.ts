import type {
  DocumentSession,
  RecoveryDocument,
  RecoverySnapshot,
} from "./types.js";

const RECOVERY_VERSION = 2;
const LEGACY_RECOVERY_VERSION = 1;

export function createRecoverySnapshot(
  text: string,
  session: DocumentSession,
  capturedAt: Date = new Date(),
): RecoverySnapshot {
  return createWorkspaceRecoverySnapshot(
    [{ text, session }],
    session.id,
    capturedAt,
  );
}

export function createWorkspaceRecoverySnapshot(
  documents: readonly RecoveryDocument[],
  activeId: string,
  capturedAt: Date = new Date(),
): RecoverySnapshot {
  if (documents.length === 0) {
    throw new Error("Workspace recovery requires at least one document");
  }
  if (!documents.some(({ session }) => session.id === activeId)) {
    throw new Error("Workspace recovery active document is missing");
  }
  const ids = new Set<string>();
  for (const { session } of documents) {
    if (session.currentRevision <= session.savedRevision) {
      throw new Error("Recovery snapshots require unsaved changes");
    }
    if (ids.has(session.id)) {
      throw new Error("Workspace recovery document IDs must be unique");
    }
    ids.add(session.id);
  }

  return {
    version: RECOVERY_VERSION,
    capturedAt: capturedAt.toISOString(),
    activeId,
    documents,
  };
}

export function serializeRecoverySnapshot(
  snapshot: RecoverySnapshot,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(snapshot));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isValidDirtySession(value: unknown): value is DocumentSession {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.id === "string" &&
    isNullableString(session.path) &&
    (session.encoding === "utf-8" || session.encoding === "utf-8-bom") &&
    (session.lineEnding === "\n" || session.lineEnding === "\r\n") &&
    typeof session.hasFinalNewline === "boolean" &&
    isNullableString(session.diskFingerprint) &&
    isNonNegativeInteger(session.savedRevision) &&
    isNonNegativeInteger(session.currentRevision) &&
    Number(session.currentRevision) > Number(session.savedRevision) &&
    session.readOnly === false &&
    session.readOnlyReason === null
  );
}

function parseCapturedAt(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return value;
}

function parseLegacySnapshot(
  candidate: Record<string, unknown>,
): RecoverySnapshot | null {
  const capturedAt = parseCapturedAt(candidate.capturedAt);
  if (
    candidate.version !== LEGACY_RECOVERY_VERSION ||
    capturedAt === null ||
    typeof candidate.text !== "string" ||
    !isValidDirtySession(candidate.session)
  ) {
    return null;
  }
  const session = candidate.session;
  return {
    version: RECOVERY_VERSION,
    capturedAt,
    activeId: session.id,
    documents: [{ text: candidate.text, session }],
  };
}

function parseWorkspaceSnapshot(
  candidate: Record<string, unknown>,
): RecoverySnapshot | null {
  const capturedAt = parseCapturedAt(candidate.capturedAt);
  if (
    candidate.version !== RECOVERY_VERSION ||
    capturedAt === null ||
    typeof candidate.activeId !== "string" ||
    !Array.isArray(candidate.documents) ||
    candidate.documents.length === 0
  ) {
    return null;
  }

  const ids = new Set<string>();
  const documents: RecoveryDocument[] = [];
  for (const value of candidate.documents) {
    if (typeof value !== "object" || value === null) return null;
    const document = value as Record<string, unknown>;
    if (
      typeof document.text !== "string" ||
      !isValidDirtySession(document.session) ||
      ids.has(document.session.id)
    ) {
      return null;
    }
    ids.add(document.session.id);
    documents.push({ text: document.text, session: document.session });
  }
  if (!ids.has(candidate.activeId)) return null;

  return {
    version: RECOVERY_VERSION,
    capturedAt,
    activeId: candidate.activeId,
    documents,
  };
}

export function parseRecoverySnapshot(bytes: Uint8Array): RecoverySnapshot {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Recovery snapshot is not valid UTF-8 JSON");
  }

  if (typeof value !== "object" || value === null) {
    throw new Error("Recovery snapshot must be an object");
  }

  const candidate = value as Record<string, unknown>;
  const parsed =
    parseWorkspaceSnapshot(candidate) ?? parseLegacySnapshot(candidate);
  if (parsed === null) {
    throw new Error("Recovery snapshot has an invalid or unsupported shape");
  }
  return parsed;
}
