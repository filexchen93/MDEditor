import { describe, expect, it } from "vitest";

import {
  createMarkdownProfile,
  defaultMarkdownProfile,
  markdownFeatureNames,
  supportsMarkdownFeature,
} from "./profile.js";

describe("MarkdownProfile", () => {
  it("publishes a versioned M4 capability contract", () => {
    expect(defaultMarkdownProfile).toMatchObject({
      id: "mdeditor-m4",
      schemaVersion: 1,
    });
    expect(Object.keys(defaultMarkdownProfile.features)).toEqual([
      ...markdownFeatureNames,
    ]);
    expect(
      markdownFeatureNames.every((feature) =>
        supportsMarkdownFeature(defaultMarkdownProfile, feature),
      ),
    ).toBe(true);
  });

  it("creates immutable feature variants without changing the default", () => {
    const portable = createMarkdownProfile(
      { alerts: false, inlineMath: false },
      { id: "portable", revision: "1" },
    );

    expect(portable).toMatchObject({
      id: "portable",
      revision: "1",
      features: { alerts: false, inlineMath: false, footnotes: true },
    });
    expect(defaultMarkdownProfile.features.alerts).toBe(true);
    expect(Object.isFrozen(portable)).toBe(true);
    expect(Object.isFrozen(portable.features)).toBe(true);
  });
});
