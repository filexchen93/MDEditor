export const coreDialect = {
  base: "commonmark",
  extensions: [
    "gfm-autolink",
    "gfm-strikethrough",
    "gfm-table",
    "gfm-task-list",
  ],
} as const;

export type MarkdownDialect = typeof coreDialect;

export function isCoreExtension(extension: string): boolean {
  return coreDialect.extensions.some((candidate) => candidate === extension);
}
