import { describe, expect, it } from "vitest";

import { createUntitledSession, recordEdit } from "./session.js";
import {
  createRecoverySnapshot,
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
      parseRecoverySnapshot(encode({ ...base, version: 2 })),
    ).toThrow("invalid or unsupported shape");
    expect(() =>
      parseRecoverySnapshot(
        encode({
          ...base,
          session: { ...base.session, savedRevision: 1 },
        }),
      ),
    ).toThrow("invalid or unsupported shape");
  });
});
