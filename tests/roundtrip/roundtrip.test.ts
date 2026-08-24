import { readFile } from "node:fs/promises";

import { decodeDocument, encodeDocument } from "@mdeditor/document-session";
import { describe, expect, it } from "vitest";

interface RoundTripFixture {
  readonly name: string;
  readonly hex: string;
}

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures.json", import.meta.url), "utf8"),
) as RoundTripFixture[];

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0)
    throw new Error("Hex fixture must contain complete bytes");

  const result = new Uint8Array(hex.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

describe("byte-level document round trips", () => {
  it.each(fixtures)("preserves $name", ({ name, hex }) => {
    const source = fromHex(hex);
    const document = decodeDocument(source, { id: name });

    expect(document.session.readOnly).toBe(false);
    expect(encodeDocument(document.text, document.session)).toEqual(source);
  });
});
