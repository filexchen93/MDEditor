import type { DocumentSession, RecoverySnapshot } from "./types.js";

const RECOVERY_VERSION = 1;

export function createRecoverySnapshot(
  text: string,
  session: DocumentSession,
  capturedAt: Date = new Date(),
): RecoverySnapshot {
  if (session.currentRevision <= session.savedRevision) {
    throw new Error("Recovery snapshots require unsaved changes");
  }

  return {
    version: RECOVERY_VERSION,
    capturedAt: capturedAt.toISOString(),
    text,
    session,
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
  const session = candidate.session as Record<string, unknown> | undefined;
  const capturedAt = candidate.capturedAt;
  const capturedAtTime =
    typeof capturedAt === "string" ? Date.parse(capturedAt) : Number.NaN;

  if (
    candidate.version !== RECOVERY_VERSION ||
    typeof candidate.text !== "string" ||
    !Number.isFinite(capturedAtTime) ||
    typeof session !== "object" ||
    session === null ||
    typeof session.id !== "string" ||
    !isNullableString(session.path) ||
    (session.encoding !== "utf-8" && session.encoding !== "utf-8-bom") ||
    (session.lineEnding !== "\n" && session.lineEnding !== "\r\n") ||
    typeof session.hasFinalNewline !== "boolean" ||
    !isNullableString(session.diskFingerprint) ||
    !isNonNegativeInteger(session.savedRevision) ||
    !isNonNegativeInteger(session.currentRevision) ||
    session.currentRevision <= session.savedRevision ||
    session.readOnly !== false ||
    session.readOnlyReason !== null
  ) {
    throw new Error("Recovery snapshot has an invalid or unsupported shape");
  }

  return value as RecoverySnapshot;
}
