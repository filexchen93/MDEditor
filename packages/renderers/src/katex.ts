import katex from "katex";
import "katex/dist/katex.min.css";

import type { ComplexRenderContext } from "@mdeditor/editor-core";

const katexSafetyOptions = {
  maxExpand: 1000,
  maxSize: 20,
  strict: "error",
  throwOnError: true,
  trust: false,
} as const;

export function renderKatexMathMl(
  source: string,
  displayMode: boolean,
): string {
  return katex.renderToString(source, {
    ...katexSafetyOptions,
    displayMode,
    output: "mathml",
  });
}

export function renderKatexHtml(source: string, displayMode: boolean): string {
  return katex.renderToString(source, {
    ...katexSafetyOptions,
    displayMode,
    output: "html",
  });
}

export function renderKatex({
  container,
  source,
  signal,
}: ComplexRenderContext): void {
  if (signal.aborted) return;
  katex.render(source, container, {
    ...katexSafetyOptions,
    displayMode: true,
    output: "htmlAndMathml",
  });
}
