import { describe, expect, it } from "vitest";

import {
  EMPTY_DOCUMENT_STYLE_LIBRARY,
  installDocumentTheme,
  installTrustedDocumentCss,
  parseDocumentStyleLibrary,
  removeDocumentTheme,
} from "./document-styles.js";

describe("document style library", () => {
  it("installs, replaces and removes a named scoped theme", () => {
    const first = installDocumentTheme(
      EMPTY_DOCUMENT_STYLE_LIBRARY,
      "warm.css",
      "/* @mdeditor-theme Warm Notes */\nh1 { color: #a64; }",
    );
    expect(first.theme.name).toBe("Warm Notes");
    expect(first.library.themes).toHaveLength(1);

    const replaced = installDocumentTheme(
      first.library,
      "warm.css",
      "h1 { color: #864; }",
    );
    expect(replaced.library.themes).toHaveLength(1);
    expect(replaced.library.themes[0]?.css).toContain("#864");
    expect(
      removeDocumentTheme(replaced.library, replaced.theme.id).themes,
    ).toEqual([]);
  });

  it("keeps advanced CSS separate and drops corrupt persisted entries", () => {
    const library = installTrustedDocumentCss(
      EMPTY_DOCUMENT_STYLE_LIBRARY,
      "layout.css",
      ".callout { display: grid; }",
    );
    expect(library.trustedCss?.name).toBe("layout");

    expect(
      parseDocumentStyleLibrary(
        JSON.stringify({
          themes: [
            {
              id: "forged",
              name: "Remote",
              sourceName: "remote.css",
              css: "p { background: url(https://example.com/x); }",
            },
          ],
          trustedCss: library.trustedCss,
        }),
      ),
    ).toEqual({ themes: [], trustedCss: library.trustedCss });
  });
});
