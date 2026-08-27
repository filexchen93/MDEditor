import { describe, expect, it, vi } from "vitest";

import {
  createPluginGrant,
  createPluginHostApi,
  parsePluginManifest,
  PluginPermissionError,
  PluginValidationError,
  requirePluginPermission,
  type PluginDocumentSnapshot,
  type PluginEditRequest,
  type PluginManifest,
} from "./index.js";

const manifestSource = {
  manifestVersion: 1,
  id: "org.mdeditor.word-count",
  name: "字数统计",
  version: "1.2.0",
  entry: "dist/index.mjs",
  permissions: ["document:read", "document:edit"],
} as const;

const snapshot: PluginDocumentSnapshot = {
  id: "document-1",
  path: "C:\\文档\\示例.md",
  text: "你好，Markdown",
  revision: 7,
  readOnly: false,
};

describe("plugin manifests", () => {
  it("parses a versioned manifest into an immutable contract", () => {
    const manifest = parsePluginManifest(manifestSource);

    expect(manifest).toEqual(manifestSource);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.permissions)).toBe(true);
  });

  it.each([
    [{ ...manifestSource, manifestVersion: 2 }, "manifestVersion"],
    [{ ...manifestSource, id: "Unsafe ID" }, "id"],
    [{ ...manifestSource, version: "latest" }, "version"],
    [{ ...manifestSource, version: "1.0.0-01" }, "version"],
    [{ ...manifestSource, entry: "../index.js" }, "entry"],
    [{ ...manifestSource, entry: "C:/plugins/index.js" }, "entry"],
    [{ ...manifestSource, entry: "https://example.com/plugin.js" }, "entry"],
    [{ ...manifestSource, permissions: ["network:fetch"] }, "permission"],
    [{ ...manifestSource, unexpected: true }, "field"],
  ])("rejects an invalid or authority-expanding manifest", (value, message) => {
    expect(() => parsePluginManifest(value)).toThrow(PluginValidationError);
    expect(() => parsePluginManifest(value)).toThrow(message);
  });
});

describe("plugin grants", () => {
  const manifest = parsePluginManifest(manifestSource);

  it("allows only declared permissions and keeps denials explicit", () => {
    const grant = createPluginGrant(manifest, ["document:read"]);

    expect(grant.permissions).toEqual(["document:read"]);
    expect(() =>
      requirePluginPermission(manifest, grant, "document:edit"),
    ).toThrow(PluginPermissionError);
  });

  it("rejects duplicate, unknown, and undeclared grants at runtime", () => {
    expect(() =>
      createPluginGrant(manifest, ["document:read", "document:read"]),
    ).toThrow("Duplicate");
    expect(() =>
      createPluginGrant(manifest, ["network:fetch"] as never),
    ).toThrow("Unknown");

    const readOnlyManifest = parsePluginManifest({
      ...manifestSource,
      permissions: ["document:read"],
    });
    expect(() =>
      createPluginGrant(readOnlyManifest, ["document:edit"]),
    ).toThrow("undeclared");
  });
});

describe("plugin host API", () => {
  const manifest = parsePluginManifest(manifestSource);

  it("exposes only granted capabilities and returns immutable snapshots", async () => {
    const readActiveDocument = vi.fn(() => Promise.resolve(snapshot));
    const applyDocumentEdits = vi.fn(() => Promise.resolve(snapshot));
    const api = createPluginHostApi(
      manifest,
      createPluginGrant(manifest, ["document:read"]),
      { readActiveDocument, applyDocumentEdits },
    );

    expect(api.document.applyEdits).toBeUndefined();
    const received = await api.document.readActive?.();
    expect(received).toEqual(snapshot);
    expect(Object.isFrozen(received)).toBe(true);
    expect(readActiveDocument).toHaveBeenCalledOnce();
    expect(applyDocumentEdits).not.toHaveBeenCalled();
  });

  it("validates revisions, ordering, overlap, and edit size before mutation", async () => {
    const applyDocumentEdits = vi.fn(() => Promise.resolve(snapshot));
    const api = createPluginHostApi(
      manifest,
      createPluginGrant(manifest, ["document:edit"]),
      {
        readActiveDocument: () => Promise.resolve(snapshot),
        applyDocumentEdits,
      },
    );

    await expect(
      api.document.applyEdits?.({
        expectedRevision: 7,
        edits: [
          { from: 4, to: 7, insert: "一" },
          { from: 6, to: 8, insert: "二" },
        ],
      }),
    ).rejects.toThrow("overlapping");
    await expect(
      api.document.applyEdits?.({
        expectedRevision: -1,
        edits: [{ from: 0, to: 0, insert: "" }],
      }),
    ).rejects.toThrow("Invalid plugin edit request");
    await expect(
      api.document.applyEdits?.({
        expectedRevision: 7,
        edits: [{ from: 0, to: 0, insert: "x".repeat(1_048_577) }],
      }),
    ).rejects.toThrow("too much text");
    expect(applyDocumentEdits).not.toHaveBeenCalled();
  });

  it("passes a frozen, validated edit request to the trusted host", async () => {
    const applyDocumentEdits = vi.fn((request: PluginEditRequest) => {
      void request;
      return Promise.resolve({ ...snapshot, revision: 8 });
    });
    const api = createPluginHostApi(
      manifest,
      createPluginGrant(manifest, ["document:edit"]),
      {
        readActiveDocument: () => Promise.resolve(snapshot),
        applyDocumentEdits,
      },
    );
    const result = await api.document.applyEdits?.({
      expectedRevision: 7,
      edits: [{ from: 0, to: 2, insert: "您好" }],
    });

    const request = applyDocumentEdits.mock.calls[0]?.[0];
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request?.edits)).toBe(true);
    expect(Object.isFrozen(request?.edits[0])).toBe(true);
    expect(result?.revision).toBe(8);
  });

  it("rejects a grant issued for another plugin", () => {
    expect(() =>
      createPluginHostApi(
        manifest,
        { pluginId: "org.example.other", permissions: ["document:read"] },
        {
          readActiveDocument: () => Promise.resolve(snapshot),
          applyDocumentEdits: () => Promise.resolve(snapshot),
        },
      ),
    ).toThrow("does not match");
  });
});

void (manifestSource satisfies PluginManifest);
