import { describe, expect, it } from "vitest";

import { createUntitledSession, recordEdit } from "./session.js";
import {
  createRecoverySnapshot,
  createWorkspaceRecoverySnapshot,
  parseRecoverySnapshot,
  serializeRecoverySnapshot,
} from "./recovery.js";

describe("recovery snapshots", () => {
  it("round-trips dirty document content and metadata", () => {
    const session = recordEdit(createUntitledSession("draft-1"), "草稿\n");
    const snapshot = createRecoverySnapshot(
      "草稿\n",
      session,
      new Date("2026-08-24T10:00:00.000Z"),
    );

    expect(parseRecoverySnapshot(serializeRecoverySnapshot(snapshot))).toEqual(
      snapshot,
    );
  });

  it("refuses to create a snapshot for a clean document", () => {
    expect(() =>
      createRecoverySnapshot("", createUntitledSession("clean")),
    ).toThrow("unsaved changes");
  });

  it("round-trips every dirty workspace document and active tab", () => {
    const first = recordEdit(createUntitledSession("first"), "甲");
    const second = recordEdit(createUntitledSession("second"), "乙");
    const snapshot = createWorkspaceRecoverySnapshot(
      [
        { text: "甲", session: first },
        { text: "乙", session: second },
      ],
      "second",
      new Date("2026-08-25T10:00:00.000Z"),
    );

    expect(parseRecoverySnapshot(serializeRecoverySnapshot(snapshot))).toEqual(
      snapshot,
    );
  });

  it("migrates a version 1 single-document snapshot", () => {
    const session = recordEdit(createUntitledSession("legacy"), "旧草稿");
    const legacy = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        capturedAt: "2026-08-24T10:00:00.000Z",
        text: "旧草稿",
        session,
      }),
    );

    expect(parseRecoverySnapshot(legacy)).toEqual({
      version: 2,
      capturedAt: "2026-08-24T10:00:00.000Z",
      activeId: "legacy",
      documents: [{ text: "旧草稿", session }],
    });
  });

  it("rejects corrupt, future, and clean snapshots", () => {
    expect(() => parseRecoverySnapshot(new Uint8Array([0xff]))).toThrow(
      "valid UTF-8 JSON",
    );

    const base = createRecoverySnapshot(
      "draft",
      recordEdit(createUntitledSession("draft-2"), "draft"),
    );
    const encode = (value: unknown) =>
      new TextEncoder().encode(JSON.stringify(value));

    expect(() =>
      parseRecoverySnapshot(encode({ ...base, version: 3 })),
    ).toThrow("invalid or unsupported shape");
    expect(() =>
      parseRecoverySnapshot(
        encode({
          ...base,
          documents: base.documents.map((document, index) =>
            index === 0
              ? {
                  ...document,
                  session: { ...document.session, savedRevision: 1 },
                }
              : document,
          ),
        }),
      ),
    ).toThrow("invalid or unsupported shape");
  });
});
