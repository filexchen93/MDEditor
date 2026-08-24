import { describe, expect, it } from "vitest";

import { createEditorCoreConfig } from "./index.js";

describe("createEditorCoreConfig", () => {
  it("starts in lossless source mode", () => {
    expect(createEditorCoreConfig()).toMatchObject({
      mode: "source",
      dialect: { base: "commonmark" },
    });
  });
});
