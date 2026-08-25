import katex from "katex";
import "katex/dist/katex.min.css";

import type { ComplexRenderContext } from "@mdeditor/editor-core";

export function renderKatex({
  container,
  source,
  signal,
}: ComplexRenderContext): void {
  if (signal.aborted) return;
  katex.render(source, container, {
    displayMode: true,
    maxExpand: 1000,
    maxSize: 20,
    output: "htmlAndMathml",
    strict: "error",
    throwOnError: true,
    trust: false,
  });
}
