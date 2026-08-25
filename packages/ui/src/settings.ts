export type AppTheme = "paper" | "dark" | "system";

export const SHORTCUT_ACTIONS = [
  "newDocument",
  "openDocument",
  "saveDocument",
  "saveDocumentAs",
  "toggleMode",
  "toggleOutline",
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];
export type AppShortcuts = Readonly<Record<ShortcutAction, string>>;

export const SUPPORTED_SHORTCUTS = [
  "Mod-n",
  "Mod-o",
  "Mod-s",
  "Mod-m",
  "Mod-Shift-n",
  "Mod-Shift-o",
  "Mod-Shift-s",
  "Mod-Shift-m",
  "Mod-Alt-n",
  "Mod-Alt-o",
  "Mod-Alt-s",
  "Mod-Alt-m",
] as const;

export const DEFAULT_SHORTCUTS: AppShortcuts = {
  newDocument: "Mod-n",
  openDocument: "Mod-o",
  saveDocument: "Mod-s",
  saveDocumentAs: "Mod-Shift-s",
  toggleMode: "Mod-Shift-m",
  toggleOutline: "Mod-Shift-o",
};

export interface AppSettings {
  readonly fontSize: number;
  readonly lineWrapping: boolean;
  readonly theme: AppTheme;
  readonly shortcuts: AppShortcuts;
}

export const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 16,
  lineWrapping: false,
  theme: "system",
  shortcuts: DEFAULT_SHORTCUTS,
};

const SETTINGS_KEY = "mdeditor.settings.v1";

function isSupportedShortcut(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (SUPPORTED_SHORTCUTS as readonly string[]).includes(value)
  );
}

function parseShortcuts(value: unknown): AppShortcuts {
  if (typeof value !== "object" || value === null) return DEFAULT_SHORTCUTS;
  const candidate = value as Record<string, unknown>;
  const result: Record<ShortcutAction, string> = { ...DEFAULT_SHORTCUTS };

  for (const action of SHORTCUT_ACTIONS) {
    const shortcut = candidate[action];
    if (!isSupportedShortcut(shortcut)) continue;
    const conflicts = SHORTCUT_ACTIONS.some(
      (other) => other !== action && result[other] === shortcut,
    );
    if (!conflicts) result[action] = shortcut;
  }
  return result;
}

export function parseAppSettings(serialized: string | null): AppSettings {
  if (serialized === null) return DEFAULT_SETTINGS;

  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    return {
      fontSize:
        Number.isInteger(value.fontSize) &&
        Number(value.fontSize) >= 12 &&
        Number(value.fontSize) <= 24
          ? Number(value.fontSize)
          : DEFAULT_SETTINGS.fontSize,
      lineWrapping:
        typeof value.lineWrapping === "boolean"
          ? value.lineWrapping
          : DEFAULT_SETTINGS.lineWrapping,
      theme:
        value.theme === "paper" ||
        value.theme === "dark" ||
        value.theme === "system"
          ? value.theme
          : DEFAULT_SETTINGS.theme,
      shortcuts: parseShortcuts(value.shortcuts),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function hasShortcutConflict(
  shortcuts: AppShortcuts,
  action: ShortcutAction,
  shortcut: string,
): boolean {
  return SHORTCUT_ACTIONS.some(
    (candidate) => candidate !== action && shortcuts[candidate] === shortcut,
  );
}

export interface ShortcutKeyboardEvent {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export function matchShortcut(
  event: ShortcutKeyboardEvent,
  shortcuts: AppShortcuts,
): ShortcutAction | null {
  const key = event.key.toLocaleLowerCase("en-US");
  return (
    SHORTCUT_ACTIONS.find((action) => {
      const parts = shortcuts[action].split("-");
      const expectedKey = parts.at(-1)?.toLocaleLowerCase("en-US");
      return (
        expectedKey === key &&
        (event.ctrlKey || event.metaKey) === parts.includes("Mod") &&
        event.shiftKey === parts.includes("Shift") &&
        event.altKey === parts.includes("Alt")
      );
    }) ?? null
  );
}

export function formatShortcut(shortcut: string): string {
  return shortcut.replace("Mod", "Ctrl/⌘").replaceAll("-", "+").toUpperCase();
}

export function loadAppSettings(): AppSettings {
  try {
    return parseAppSettings(globalThis.localStorage?.getItem(SETTINGS_KEY));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveAppSettings(settings: AppSettings): void {
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings persistence is best effort; editing must remain available.
  }
}
