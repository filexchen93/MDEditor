import type {
  DecodeDocumentOptions,
  DecodedDocument,
  DocumentEncoding,
  DocumentSession,
  LineEnding,
  ReadOnlyReason,
} from "./types.js";

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= UTF8_BOM.length &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
  );
}

function detectLineEnding(text: string): {
  readonly lineEnding: LineEnding;
  readonly readOnlyReason: ReadOnlyReason;
} {
  let crlfCount = 0;
  let lfCount = 0;
  let hasBareCarriageReturn = false;

  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.charCodeAt(index);
    if (codePoint === 13) {
      if (text.charCodeAt(index + 1) === 10) {
        crlfCount += 1;
        index += 1;
      } else {
        hasBareCarriageReturn = true;
      }
    } else if (codePoint === 10) {
      lfCount += 1;
    }
  }

  return {
    lineEnding: crlfCount > lfCount ? "\r\n" : "\n",
    readOnlyReason: hasBareCarriageReturn ? "unsupported-line-ending" : null,
  };
}

function hasFinalNewline(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r");
}

export function decodeDocument(
  bytes: Uint8Array,
  options: DecodeDocumentOptions,
): DecodedDocument {
  const encoding: DocumentEncoding = hasUtf8Bom(bytes) ? "utf-8-bom" : "utf-8";
  const payload =
    encoding === "utf-8-bom" ? bytes.subarray(UTF8_BOM.length) : bytes;

  let text: string;
  let readOnlyReason: ReadOnlyReason = null;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    text = new TextDecoder("utf-8").decode(payload);
    readOnlyReason = "unsupported-encoding";
  }

  const lineAnalysis = detectLineEnding(text);
  readOnlyReason ??= lineAnalysis.readOnlyReason;

  return {
    text,
    session: {
      id: options.id,
      path: options.path ?? null,
      encoding,
      lineEnding: lineAnalysis.lineEnding,
      hasFinalNewline: hasFinalNewline(text),
      diskFingerprint: options.diskFingerprint ?? null,
      savedRevision: 0,
      currentRevision: 0,
      readOnly: readOnlyReason !== null,
      readOnlyReason,
    },
  };
}

export function encodeDocument(
  text: string,
  session: DocumentSession,
): Uint8Array {
  if (session.readOnly) {
    throw new Error(
      `Cannot encode a read-only document: ${session.readOnlyReason ?? "unknown reason"}`,
    );
  }

  const payload = new TextEncoder().encode(text);
  if (session.encoding === "utf-8") return payload;

  const bytes = new Uint8Array(UTF8_BOM.length + payload.length);
  bytes.set(UTF8_BOM);
  bytes.set(payload, UTF8_BOM.length);
  return bytes;
}

export function normalizeLineEndings(
  text: string,
  lineEnding: LineEnding,
): string {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return lineEnding === "\n" ? normalized : normalized.replaceAll("\n", "\r\n");
}
