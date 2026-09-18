export const coreDialect = {
  base: "commonmark",
  extensions: [
    "gfm-autolink",
    "gfm-strikethrough",
    "gfm-table",
    "gfm-task-list",
  ],
} as const;

export { compileDocumentCss } from "./document-css.js";
export type { DocumentCssKind, DocumentCssSurface } from "./document-css.js";

export type MarkdownDialect = typeof coreDialect;

export function isCoreExtension(extension: string): boolean {
  return coreDialect.extensions.some((candidate) => candidate === extension);
}

export {
  createDocxExportName,
  createHtmlExportName,
  createImageExportName,
  createSafeHtmlDocument,
  createStandaloneHtml,
  renderMarkdownToSafeHtml,
  resolveSafeHtmlImageSources,
  resolveSafeHtmlMathExpressions,
  resolveSafeHtmlMermaidDiagrams,
  sanitizeRenderedMarkdown,
} from "./export.js";
export type {
  ExportTheme,
  HtmlExportStyle,
  PrintLayoutOptions,
  PrintMargin,
  PrintOrientation,
  PrintPageSize,
  SafeHtmlDocumentOptions,
  SafeHtmlImageResolver,
  SafeHtmlMathResolver,
  SafeHtmlMermaidResolver,
  StandaloneHtmlOptions,
} from "./export.js";
export {
  collectMarkdownExtensionRanges,
  createMarkdownHeadingSlug,
  createMarkdownMarkedExtension,
} from "./extensions.js";
export type {
  MarkdownAlertKind,
  MarkdownExtensionKind,
  MarkdownExtensionRange,
} from "./extensions.js";
export {
  createMarkdownProfile,
  defaultMarkdownProfile,
  markdownFeatureNames,
  supportsMarkdownFeature,
} from "./profile.js";
export type {
  MarkdownFeature,
  MarkdownFeatureOverrides,
  MarkdownProfile,
} from "./profile.js";
