import {
  coreDialect,
  defaultMarkdownProfile,
  type MarkdownDialect,
  type MarkdownProfile,
} from "@mdeditor/markdown";
import type { EditorMode } from "./progressive-rendering.js";

export {
  createMarkdownFormattingTransaction,
  runMarkdownFormat,
} from "./formatting.js";
export {
  collectDocumentOutline,
  createMarkdownAutoPairTransaction,
  createMarkdownImageInsertionTransaction,
  createEditorPreferencesExtension,
  createSourceEditor,
  createSourceEditorState,
  getFocusBlockRange,
  getTableCellTarget,
  headingPositionForFragment,
  linkTargetAtPosition,
} from "./source-editor.js";
export {
  calculateEditorStatistics,
  calculateTextStatistics,
} from "./statistics.js";
export { deriveOutlineView } from "./outline.js";
export {
  createTableEditTransaction,
  parseGfmTable,
  runTableEdit,
  serializeGfmTable,
} from "./table.js";
export {
  collectProgressiveDecorations,
  createEditorModeExtension,
  isProgressiveSyntaxActive,
  sanitizeImageSource,
} from "./progressive-rendering.js";
export {
  collectSpellcheckWords,
  createSpellcheckExtension,
  findMisspelledWords,
} from "./spellcheck.js";
export type { MarkdownFormatCommand } from "./formatting.js";
export type {
  EditorLineSeparator,
  EditorPreferences,
  FocusBlockRange,
  OutlineItem,
  OutlineListener,
  SourceEditor,
  SourceEditorChange,
  SourceEditorOptions,
  SourceEditorStateOptions,
  StatisticsListener,
} from "./source-editor.js";
export type { DocumentStatistics, TextStatistics } from "./statistics.js";
export type {
  Spellchecker,
  SpellcheckLanguage,
  SpellcheckWord,
} from "./spellcheck.js";
export type { OutlineViewItem } from "./outline.js";
export type {
  GfmTableModel,
  TableAlignment,
  TableEditCommand,
} from "./table.js";
export type {
  ComplexBlockKind,
  ComplexBlockRenderer,
  ComplexBlockRenderers,
  ComplexRenderContext,
  EditorMode,
  ImageSourceResolver,
  ProgressiveDecorationKind,
  ProgressiveDecorationSpec,
} from "./progressive-rendering.js";

export interface EditorCoreConfig {
  readonly mode: EditorMode;
  readonly dialect: MarkdownDialect;
  readonly profile: MarkdownProfile;
}

export function createEditorCoreConfig(
  mode: EditorMode = "source",
): EditorCoreConfig {
  return { mode, dialect: coreDialect, profile: defaultMarkdownProfile };
}
