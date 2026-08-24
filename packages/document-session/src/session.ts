import type { DocumentSession } from "./types.js";

export function isDirty(session: DocumentSession): boolean {
  return session.currentRevision !== session.savedRevision;
}

export function createUntitledSession(id: string): DocumentSession {
  return {
    id,
    path: null,
    encoding: "utf-8",
    lineEnding: "\n",
    hasFinalNewline: false,
    diskFingerprint: null,
    savedRevision: 0,
    currentRevision: 0,
    readOnly: false,
    readOnlyReason: null,
  };
}

export function recordEdit(
  session: DocumentSession,
  text: string,
): DocumentSession {
  if (session.readOnly) return session;

  return {
    ...session,
    currentRevision: session.currentRevision + 1,
    hasFinalNewline: text.endsWith("\n") || text.endsWith("\r"),
  };
}

export function recordSave(
  session: DocumentSession,
  diskFingerprint: string,
  path: string | null = session.path,
  savedRevision: number = session.currentRevision,
): DocumentSession {
  if (savedRevision > session.currentRevision) {
    throw new Error("Saved revision cannot be newer than the current revision");
  }

  return {
    ...session,
    path,
    diskFingerprint,
    savedRevision,
  };
}
