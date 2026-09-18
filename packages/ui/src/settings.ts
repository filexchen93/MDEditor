export type AppTheme = "paper" | "dark" | "system";
export type AutoSaveDelaySeconds = 2 | 5 | 10 | 30;
export type PrintPageSize = "A4" | "Letter";
export type PrintOrientation = "portrait" | "landscape";
export type PrintMargin = "normal" | "narrow" | "wide";
export type ImageExportScale = 1 | 2;
export type SpellcheckLanguage = "en-US" | "en-GB";

export interface PrintLayoutSettings {
  readonly pageSize: PrintPageSize;
  readonly orientation: PrintOrientation;
  readonly margin: PrintMargin;
  readonly pageBreakBetweenTopLevelHeadings: boolean;
  readonly headerTemplate: string;
  readonly footerTemplate: string;
}

export const MAXIMUM_PRINT_TEMPLATE_CHARACTERS = 200;

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
  readonly focusMode: boolean;
  readonly typewriterMode: boolean;
  readonly markdownAutoPair: boolean;
  readonly spellcheckEnabled: boolean;
  readonly spellcheckLanguage: SpellcheckLanguage;
  readonly autoSaveEnabled: boolean;
  readonly autoSaveDelaySeconds: AutoSaveDelaySeconds;
  readonly printLayout: PrintLayoutSettings;
  readonly imageExportScale: ImageExportScale;
  readonly theme: AppTheme;
  readonly documentThemeId: string | null;
  readonly trustedDocumentCssEnabled: boolean;
  readonly shortcuts: AppShortcuts;
}

export const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 16,
  lineWrapping: true,
  focusMode: false,
  typewriterMode: false,
  markdownAutoPair: true,
  spellcheckEnabled: false,
  spellcheckLanguage: "en-US",
  autoSaveEnabled: false,
  autoSaveDelaySeconds: 5,
  printLayout: {
    pageSize: "A4",
    orientation: "portrait",
    margin: "normal",
    pageBreakBetweenTopLevelHeadings: false,
    headerTemplate: "",
    footerTemplate: "",
  },
  imageExportScale: 2,
  theme: "system",
  documentThemeId: null,
  trustedDocumentCssEnabled: false,
  shortcuts: DEFAULT_SHORTCUTS,
};

const SETTINGS_KEY = "mdeditor.settings.v2";
const LEGACY_SETTINGS_KEY = "mdeditor.settings.v1";

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

function parsePrintTemplate(value: unknown): string {
  return typeof value === "string" &&
    value.length <= MAXIMUM_PRINT_TEMPLATE_CHARACTERS &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
    ? value
    : "";
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
      focusMode:
        typeof value.focusMode === "boolean"
          ? value.focusMode
          : DEFAULT_SETTINGS.focusMode,
      typewriterMode:
        typeof value.typewriterMode === "boolean"
          ? value.typewriterMode
          : DEFAULT_SETTINGS.typewriterMode,
      markdownAutoPair:
        typeof value.markdownAutoPair === "boolean"
          ? value.markdownAutoPair
          : DEFAULT_SETTINGS.markdownAutoPair,
      spellcheckEnabled:
        typeof value.spellcheckEnabled === "boolean"
          ? value.spellcheckEnabled
          : DEFAULT_SETTINGS.spellcheckEnabled,
      spellcheckLanguage:
        value.spellcheckLanguage === "en-GB" ? "en-GB" : "en-US",
      autoSaveEnabled:
        typeof value.autoSaveEnabled === "boolean"
          ? value.autoSaveEnabled
          : DEFAULT_SETTINGS.autoSaveEnabled,
      autoSaveDelaySeconds: ([2, 5, 10, 30] as const).includes(
        value.autoSaveDelaySeconds as AutoSaveDelaySeconds,
      )
        ? (value.autoSaveDelaySeconds as AutoSaveDelaySeconds)
        : DEFAULT_SETTINGS.autoSaveDelaySeconds,
      printLayout: {
        pageSize:
          (value.printLayout as Record<string, unknown> | undefined)
            ?.pageSize === "Letter"
            ? "Letter"
            : "A4",
        orientation:
          (value.printLayout as Record<string, unknown> | undefined)
            ?.orientation === "landscape"
            ? "landscape"
            : "portrait",
        margin: (["normal", "narrow", "wide"] as const).includes(
          (value.printLayout as Record<string, unknown> | undefined)
            ?.margin as PrintMargin,
        )
          ? ((value.printLayout as Record<string, unknown>)
              .margin as PrintMargin)
          : DEFAULT_SETTINGS.printLayout.margin,
        pageBreakBetweenTopLevelHeadings:
          typeof (value.printLayout as Record<string, unknown> | undefined)
            ?.pageBreakBetweenTopLevelHeadings === "boolean"
            ? ((value.printLayout as Record<string, unknown>)
                .pageBreakBetweenTopLevelHeadings as boolean)
            : DEFAULT_SETTINGS.printLayout.pageBreakBetweenTopLevelHeadings,
        headerTemplate: parsePrintTemplate(
          (value.printLayout as Record<string, unknown> | undefined)
            ?.headerTemplate,
        ),
        footerTemplate: parsePrintTemplate(
          (value.printLayout as Record<string, unknown> | undefined)
            ?.footerTemplate,
        ),
      },
      imageExportScale:
        value.imageExportScale === 1 || value.imageExportScale === 2
          ? value.imageExportScale
          : DEFAULT_SETTINGS.imageExportScale,
      theme:
        value.theme === "paper" ||
        value.theme === "dark" ||
        value.theme === "system"
          ? value.theme
          : DEFAULT_SETTINGS.theme,
      documentThemeId:
        typeof value.documentThemeId === "string" &&
        /^theme-[a-f0-9]{8}$/u.test(value.documentThemeId)
          ? value.documentThemeId
          : null,
      trustedDocumentCssEnabled:
        typeof value.trustedDocumentCssEnabled === "boolean"
          ? value.trustedDocumentCssEnabled
          : DEFAULT_SETTINGS.trustedDocumentCssEnabled,
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
    const current = globalThis.localStorage?.getItem(SETTINGS_KEY);
    if (current !== null && current !== undefined) {
      return parseAppSettings(current);
    }
    const legacy = globalThis.localStorage?.getItem(LEGACY_SETTINGS_KEY);
    if (legacy !== null && legacy !== undefined) {
      return { ...parseAppSettings(legacy), lineWrapping: true };
    }
    return DEFAULT_SETTINGS;
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
