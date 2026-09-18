import { compileDocumentCss } from "@mdeditor/markdown";

export interface InstalledDocumentTheme {
  readonly id: string;
  readonly name: string;
  readonly sourceName: string;
  readonly css: string;
}

export interface TrustedDocumentCss {
  readonly name: string;
  readonly sourceName: string;
  readonly css: string;
}

export interface DocumentStyleLibrary {
  readonly themes: readonly InstalledDocumentTheme[];
  readonly trustedCss: TrustedDocumentCss | null;
}

export const EMPTY_DOCUMENT_STYLE_LIBRARY: DocumentStyleLibrary = {
  themes: [],
  trustedCss: null,
};

const documentStyleLibraryKey = "mdeditor.document-styles.v1";
const maximumInstalledThemes = 12;
const maximumStoredCssCharacters = 1024 * 1024;

function safeDisplayName(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized === "" ||
    normalized.length > 64 ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error("主题名称为空、过长或包含控制字符");
  }
  return normalized;
}

function nameFromSource(sourceName: string): string {
  const leaf = sourceName.split(/[\\/]/u).at(-1) ?? "";
  return safeDisplayName(leaf.replace(/\.css$/iu, "") || "文档样式");
}

function themeName(sourceName: string, css: string): string {
  const declared =
    /^\s*\/\*\s*@mdeditor-theme\s+([^*\r\n]{1,64})\s*\*\//iu.exec(css)?.[1];
  return safeDisplayName(declared ?? nameFromSource(sourceName));
}

function stableThemeId(sourceName: string): string {
  let hash = 0x811c9dc5;
  for (const character of sourceName.normalize("NFKC").toLocaleLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `theme-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function validateSourceName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 260) {
    throw new Error("CSS 文件名无效");
  }
  return value;
}

function validateStoredTheme(value: unknown): InstalledDocumentTheme {
  if (typeof value !== "object" || value === null) {
    throw new Error("主题记录无效");
  }
  const candidate = value as Record<string, unknown>;
  const sourceName = validateSourceName(candidate.sourceName);
  const css = candidate.css;
  if (typeof css !== "string") throw new Error("主题 CSS 无效");
  compileDocumentCss(css, "editor", "theme");
  return {
    id: stableThemeId(sourceName),
    name: safeDisplayName(
      typeof candidate.name === "string" ? candidate.name : "",
    ),
    sourceName,
    css,
  };
}

function validateStoredTrustedCss(value: unknown): TrustedDocumentCss | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new Error("受信 CSS 记录无效");
  const candidate = value as Record<string, unknown>;
  const sourceName = validateSourceName(candidate.sourceName);
  const css = candidate.css;
  if (typeof css !== "string") throw new Error("受信 CSS 无效");
  compileDocumentCss(css, "editor", "trusted");
  return {
    name: safeDisplayName(
      typeof candidate.name === "string" ? candidate.name : "",
    ),
    sourceName,
    css,
  };
}

function validateLibrarySize(library: DocumentStyleLibrary): void {
  const total =
    library.themes.reduce((sum, theme) => sum + theme.css.length, 0) +
    (library.trustedCss?.css.length ?? 0);
  if (total > maximumStoredCssCharacters) {
    throw new Error("已安装文档样式总量超过 1 MiB 限制");
  }
}

export function parseDocumentStyleLibrary(
  serialized: string | null,
): DocumentStyleLibrary {
  if (serialized === null) return EMPTY_DOCUMENT_STYLE_LIBRARY;
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    const themes = Array.isArray(value.themes)
      ? value.themes
          .slice(0, maximumInstalledThemes)
          .flatMap((theme): InstalledDocumentTheme[] => {
            try {
              return [validateStoredTheme(theme)];
            } catch {
              return [];
            }
          })
      : [];
    let trustedCss: TrustedDocumentCss | null = null;
    try {
      trustedCss = validateStoredTrustedCss(value.trustedCss);
    } catch {
      trustedCss = null;
    }
    const library = { themes, trustedCss };
    validateLibrarySize(library);
    return library;
  } catch {
    return EMPTY_DOCUMENT_STYLE_LIBRARY;
  }
}

export function loadDocumentStyleLibrary(): DocumentStyleLibrary {
  try {
    return parseDocumentStyleLibrary(
      globalThis.localStorage?.getItem(documentStyleLibraryKey) ?? null,
    );
  } catch {
    return EMPTY_DOCUMENT_STYLE_LIBRARY;
  }
}

export function saveDocumentStyleLibrary(library: DocumentStyleLibrary): void {
  validateLibrarySize(library);
  try {
    globalThis.localStorage?.setItem(
      documentStyleLibraryKey,
      JSON.stringify(library),
    );
  } catch {
    throw new Error("无法保存文档样式；浏览器存储空间可能不足");
  }
}

export function installDocumentTheme(
  library: DocumentStyleLibrary,
  sourceName: string,
  css: string,
): {
  readonly library: DocumentStyleLibrary;
  readonly theme: InstalledDocumentTheme;
} {
  const validSourceName = validateSourceName(sourceName);
  compileDocumentCss(css, "editor", "theme");
  const theme: InstalledDocumentTheme = {
    id: stableThemeId(validSourceName),
    name: themeName(validSourceName, css),
    sourceName: validSourceName,
    css,
  };
  const existingIndex = library.themes.findIndex(({ id }) => id === theme.id);
  if (existingIndex < 0 && library.themes.length >= maximumInstalledThemes) {
    throw new Error(`最多安装 ${maximumInstalledThemes} 个文档主题`);
  }
  const themes = [...library.themes];
  if (existingIndex < 0) themes.push(theme);
  else themes.splice(existingIndex, 1, theme);
  const next = { ...library, themes };
  validateLibrarySize(next);
  return { library: next, theme };
}

export function removeDocumentTheme(
  library: DocumentStyleLibrary,
  id: string,
): DocumentStyleLibrary {
  return {
    ...library,
    themes: library.themes.filter((theme) => theme.id !== id),
  };
}

export function installTrustedDocumentCss(
  library: DocumentStyleLibrary,
  sourceName: string,
  css: string,
): DocumentStyleLibrary {
  const validSourceName = validateSourceName(sourceName);
  compileDocumentCss(css, "editor", "trusted");
  const next = {
    ...library,
    trustedCss: {
      name: nameFromSource(validSourceName),
      sourceName: validSourceName,
      css,
    },
  };
  validateLibrarySize(next);
  return next;
}
