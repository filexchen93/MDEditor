import { coreDialect, type MarkdownDialect } from "@mdeditor/markdown";
import type { EditorMode } from "./progressive-rendering.js";

export {
  collectDocumentOutline,
  createEditorPreferencesExtension,
  createSourceEditor,
  createSourceEditorState,
  getTableCellTarget,
} from "./source-editor.js";
export {
  collectProgressiveDecorations,
  createEditorModeExtension,
  sanitizeImageSource,
} from "./progressive-rendering.js";
export type {
  EditorLineSeparator,
  EditorPreferences,
  OutlineItem,
  OutlineListener,
  SourceEditor,
  SourceEditorChange,
  SourceEditorOptions,
  SourceEditorStateOptions,
} from "./source-editor.js";
export type {
  ComplexBlockKind,
  ComplexBlockRenderer,
  ComplexBlockRenderers,
  ComplexRenderContext,
  EditorMode,
  ProgressiveDecorationKind,
  ProgressiveDecorationSpec,
} from "./progressive-rendering.js";

export interface EditorCoreConfig {
  readonly mode: EditorMode;
  readonly dialect: MarkdownDialect;
}

export function createEditorCoreConfig(
  mode: EditorMode = "source",
): EditorCoreConfig {
  return { mode, dialect: coreDialect };
}
