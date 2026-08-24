import { coreDialect, type MarkdownDialect } from "@mdeditor/markdown";
import type { EditorMode } from "./progressive-rendering.js";

export {
  createSourceEditor,
  createSourceEditorState,
} from "./source-editor.js";
export {
  collectProgressiveDecorations,
  createEditorModeExtension,
  sanitizeImageSource,
} from "./progressive-rendering.js";
export type {
  EditorLineSeparator,
  SourceEditor,
  SourceEditorChange,
  SourceEditorOptions,
  SourceEditorStateOptions,
} from "./source-editor.js";
export type {
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
