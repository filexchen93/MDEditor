import { describe, expect, it } from "vitest";

import {
  decodeDocument,
  encodeDocument,
  normalizeLineEndings,
} from "./codec.js";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("document codec", () => {
  it.each([
    { name: "empty UTF-8", source: bytes() },
    {
      name: "LF with final newline",
      source: new TextEncoder().encode("中文🙂\n"),
    },
    {
      name: "LF without final newline",
      source: new TextEncoder().encode("no newline"),
    },
    {
      name: "CRLF with final newline",
      source: new TextEncoder().encode("first\r\nsecond\r\n"),
    },
    {
      name: "UTF-8 BOM",
      source: bytes(0xef, 0xbb, 0xbf, ...new TextEncoder().encode("标题\r\n")),
    },
  ])("round-trips $name byte-for-byte", ({ source }) => {
    const decoded = decodeDocument(source, { id: "fixture" });

    expect(decoded.session.readOnly).toBe(false);
    expect(encodeDocument(decoded.text, decoded.session)).toEqual(source);
  });

  it("records BOM, CRLF and final-newline metadata", () => {
    const source = bytes(
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode("a\r\nb\r\n"),
    );
    const decoded = decodeDocument(source, {
      id: "metadata",
      path: "C:/文档/示例.md",
      diskFingerprint: "fingerprint-1",
    });

    expect(decoded.session).toMatchObject({
      path: "C:/文档/示例.md",
      encoding: "utf-8-bom",
      lineEnding: "\r\n",
      hasFinalNewline: true,
      diskFingerprint: "fingerprint-1",
    });
  });

  it("opens invalid UTF-8 read-only without hiding its decoded content", () => {
    const decoded = decodeDocument(bytes(0x66, 0x80, 0x6f), { id: "invalid" });

    expect(decoded.text).toContain("�");
    expect(decoded.session).toMatchObject({
      readOnly: true,
      readOnlyReason: "unsupported-encoding",
    });
    expect(() => encodeDocument(decoded.text, decoded.session)).toThrow(
      /read-only/u,
    );
  });

  it("opens unsupported bare carriage-return files read-only", () => {
    const decoded = decodeDocument(new TextEncoder().encode("one\rtwo\r"), {
      id: "cr",
    });

    expect(decoded.session).toMatchObject({
      readOnly: true,
      readOnlyReason: "unsupported-line-ending",
    });
  });

  it("normalizes explicit edits only when requested", () => {
    expect(normalizeLineEndings("a\r\nb\rc\n", "\n")).toBe("a\nb\nc\n");
    expect(normalizeLineEndings("a\r\nb\rc\n", "\r\n")).toBe("a\r\nb\r\nc\r\n");
  });
});
