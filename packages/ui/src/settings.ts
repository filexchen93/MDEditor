export interface AppSettings {
  readonly fontSize: number;
  readonly lineWrapping: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 16,
  lineWrapping: false,
};

const SETTINGS_KEY = "mdeditor.settings.v1";

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
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
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
