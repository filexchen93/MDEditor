import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  formatShortcut,
  hasShortcutConflict,
  matchShortcut,
  parseAppSettings,
} from "./settings.js";

describe("application settings", () => {
  it("loads supported settings", () => {
    expect(
      parseAppSettings(JSON.stringify({ fontSize: 20, lineWrapping: true })),
    ).toEqual({ ...DEFAULT_SETTINGS, fontSize: 20, lineWrapping: true });
  });

  it("falls back per field for corrupt or out-of-range values", () => {
    expect(parseAppSettings("not json")).toEqual(DEFAULT_SETTINGS);
    expect(
      parseAppSettings(JSON.stringify({ fontSize: 99, lineWrapping: true })),
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
