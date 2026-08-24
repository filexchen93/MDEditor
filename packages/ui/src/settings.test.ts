import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, parseAppSettings } from "./settings.js";

describe("application settings", () => {
  it("loads supported settings", () => {
    expect(
      parseAppSettings(JSON.stringify({ fontSize: 20, lineWrapping: true })),
    ).toEqual({ fontSize: 20, lineWrapping: true });
  });

  it("falls back per field for corrupt or out-of-range values", () => {
    expect(parseAppSettings("not json")).toEqual(DEFAULT_SETTINGS);
    expect(
      parseAppSettings(JSON.stringify({ fontSize: 99, lineWrapping: true })),
    ).toEqual({ fontSize: DEFAULT_SETTINGS.fontSize, lineWrapping: true });
  });
});
