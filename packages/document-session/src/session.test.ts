import { describe, expect, it } from "vitest";

import {
  createUntitledSession,
  isDirty,
  recordEdit,
  recordSave,
} from "./session.js";

describe("DocumentSession revisions", () => {
  it("derives dirty state only from revisions", () => {
    const session = createUntitledSession("document-1");
    const edited = recordEdit(session, "draft");
    const saved = recordSave(edited, "fingerprint-1", "C:/文档/draft.md");

    expect(isDirty(session)).toBe(false);
    expect(isDirty(edited)).toBe(true);
    expect(isDirty(saved)).toBe(false);
    expect(saved).toMatchObject({
      currentRevision: 1,
      savedRevision: 1,
      diskFingerprint: "fingerprint-1",
      path: "C:/文档/draft.md",
    });
  });

  it("tracks final-newline state with edits", () => {
    const session = createUntitledSession("document-2");

    expect(recordEdit(session, "line\n").hasFinalNewline).toBe(true);
    expect(recordEdit(session, "line").hasFinalNewline).toBe(false);
  });

  it("keeps edits made during an asynchronous save dirty", () => {
    const firstEdit = recordEdit(
      createUntitledSession("document-async"),
      "first",
    );
    const revisionBeingSaved = firstEdit.currentRevision;
    const concurrentEdit = recordEdit(firstEdit, "second");

    const saved = recordSave(
      concurrentEdit,
      "fingerprint-2",
      "C:/notes/note.md",
      revisionBeingSaved,
    );

    expect(saved.savedRevision).toBe(revisionBeingSaved);
    expect(saved.currentRevision).toBe(2);
    expect(isDirty(saved)).toBe(true);
  });

  it("does not advance revisions for read-only sessions", () => {
    const session = {
      ...createUntitledSession("document-3"),
      readOnly: true,
      readOnlyReason: "unsupported-encoding" as const,
    };

    expect(recordEdit(session, "ignored")).toBe(session);
  });
});
