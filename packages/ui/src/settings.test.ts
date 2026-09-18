import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SETTINGS,
  formatShortcut,
  hasShortcutConflict,
  loadAppSettings,
  matchShortcut,
  parseAppSettings,
} from "./settings.js";

describe("application settings", () => {
  it("enables wrapping when upgrading an existing settings profile", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "mdeditor.settings.v1"
          ? JSON.stringify({ theme: "dark", lineWrapping: false })
          : null,
    });
    try {
      expect(loadAppSettings()).toMatchObject({
        theme: "dark",
        lineWrapping: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads supported settings", () => {
    expect(
      parseAppSettings(
        JSON.stringify({
          fontSize: 20,
          lineWrapping: true,
          focusMode: true,
          typewriterMode: true,
          markdownAutoPair: false,
          spellcheckEnabled: true,
          spellcheckLanguage: "en-GB",
          autoSaveEnabled: true,
          autoSaveDelaySeconds: 10,
          printLayout: {
            pageSize: "Letter",
            orientation: "landscape",
            margin: "wide",
            pageBreakBetweenTopLevelHeadings: true,
            headerTemplate: "${title}",
            footerTemplate: "第 ${pageNo} / ${pageCount} 页",
          },
          imageExportScale: 1,
          documentThemeId: "theme-12abcdef",
          trustedDocumentCssEnabled: true,
        }),
      ),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      fontSize: 20,
      lineWrapping: true,
      focusMode: true,
      typewriterMode: true,
      markdownAutoPair: false,
      spellcheckEnabled: true,
      spellcheckLanguage: "en-GB",
      autoSaveEnabled: true,
      autoSaveDelaySeconds: 10,
      printLayout: {
        pageSize: "Letter",
        orientation: "landscape",
        margin: "wide",
        pageBreakBetweenTopLevelHeadings: true,
        headerTemplate: "${title}",
        footerTemplate: "第 ${pageNo} / ${pageCount} 页",
      },
      imageExportScale: 1,
      documentThemeId: "theme-12abcdef",
      trustedDocumentCssEnabled: true,
    });
  });

  it("falls back per field for corrupt or out-of-range values", () => {
    expect(parseAppSettings("not json")).toEqual(DEFAULT_SETTINGS);
    expect(
      parseAppSettings(
        JSON.stringify({
          fontSize: 99,
          lineWrapping: true,
          spellcheckEnabled: "yes",
          spellcheckLanguage: "fr-FR",
          autoSaveDelaySeconds: 3,
          printLayout: {
            pageSize: "Tabloid",
            orientation: "square",
            margin: "bleed",
            pageBreakBetweenTopLevelHeadings: "always",
            headerTemplate: "bad\nheader",
            footerTemplate: "x".repeat(201),
          },
          imageExportScale: 3,
          documentThemeId: "../../escape",
          trustedDocumentCssEnabled: "yes",
        }),
      ),
    ).toEqual({ ...DEFAULT_SETTINGS, lineWrapping: true });
  });

  it("loads valid themes and non-conflicting shortcut overrides", () => {
    const settings = parseAppSettings(
      JSON.stringify({
        theme: "dark",
        shortcuts: {
          toggleMode: "Mod-Alt-m",
          toggleOutline: "Mod-Alt-o",
        },
      }),
    );

    expect(settings.theme).toBe("dark");
    expect(settings.shortcuts.toggleMode).toBe("Mod-Alt-m");
    expect(settings.shortcuts.toggleOutline).toBe("Mod-Alt-o");
  });

  it("rejects persisted conflicts and matches platform Mod shortcuts", () => {
    const settings = parseAppSettings(
      JSON.stringify({ shortcuts: { newDocument: "Mod-s" } }),
    );
    expect(settings.shortcuts.newDocument).toBe("Mod-n");
    expect(
      hasShortcutConflict(settings.shortcuts, "newDocument", "Mod-s"),
    ).toBe(true);
    expect(
      matchShortcut(
        {
          key: "S",
          altKey: false,
          ctrlKey: true,
          metaKey: false,
          shiftKey: true,
        },
        settings.shortcuts,
      ),
    ).toBe("saveDocumentAs");
    expect(formatShortcut("Mod-Shift-s")).toBe("CTRL/⌘+SHIFT+S");
  });
});
