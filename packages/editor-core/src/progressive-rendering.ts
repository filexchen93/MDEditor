import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  StateEffect,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
} from "@codemirror/view";

export type EditorMode = "source" | "hybrid";
export type ComplexBlockKind = "katex" | "mermaid";

export interface ComplexRenderContext {
  readonly container: HTMLElement;
  readonly source: string;
  readonly signal: AbortSignal;
}

export type ComplexBlockRenderer = (
  context: ComplexRenderContext,
) => void | Promise<void>;

export type ComplexBlockRenderers = Readonly<
  Partial<Record<ComplexBlockKind, ComplexBlockRenderer>>
>;

export type ProgressiveDecorationKind =
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "heading-4"
  | "heading-5"
  | "heading-6"
  | "emphasis"
  | "strong"
  | "strikethrough"
  | "link"
  | "quote-line"
  | "list-line"
  | "table-line"
  | "task"
  | "code"
  | "code-info"
  | "syntax"
  | "image"
  | "complex-block";

export interface ProgressiveDecorationSpec {
  readonly kind: ProgressiveDecorationKind;
  readonly from: number;
  readonly to: number;
  readonly image?: {
    readonly alt: string;
    readonly source: string | null;
  };
  readonly checked?: boolean;
  readonly complex?: {
    readonly kind: ComplexBlockKind;
    readonly source: string;
  };
}

const headingNames = new Map<string, ProgressiveDecorationKind>([
  ["ATXHeading1", "heading-1"],
  ["ATXHeading2", "heading-2"],
  ["ATXHeading3", "heading-3"],
  ["ATXHeading4", "heading-4"],
  ["ATXHeading5", "heading-5"],
  ["ATXHeading6", "heading-6"],
  ["SetextHeading1", "heading-1"],
  ["SetextHeading2", "heading-2"],
]);

const syntaxNodeNames = new Set([
  "CodeMark",
  "EmphasisMark",
  "HeaderMark",
  "LinkMark",
  "ListMark",
  "QuoteMark",
  "StrikethroughMark",
]);

function addBlockLines(
  state: EditorState,
  specs: ProgressiveDecorationSpec[],
  seen: Set<string>,
  kind: "quote-line" | "list-line" | "table-line",
  from: number,
  to: number,
) {
  let line = state.doc.lineAt(from);
  const finalLine = state.doc.lineAt(Math.max(from, to - 1)).number;

  while (line.number <= finalLine) {
    const key = `${kind}:${line.from}`;
    if (!seen.has(key)) {
      seen.add(key);
      specs.push({ kind, from: line.from, to: line.from });
    }
    if (line.number === state.doc.lines) break;
    line = state.doc.line(line.number + 1);
  }
}

function imageDetails(
  state: EditorState,
  from: number,
  to: number,
  urlFrom: number | undefined,
  urlTo: number | undefined,
) {
  const markdown = state.sliceDoc(from, to);
  const altEnd = markdown.indexOf("](");
  const alt = altEnd >= 2 ? markdown.slice(2, altEnd) : "";
  const source =
    urlFrom === undefined || urlTo === undefined
      ? null
      : sanitizeImageSource(state.sliceDoc(urlFrom, urlTo));

  return {
    alt: alt.replaceAll(/\\([\\[\]])/gu, "$1"),
    source,
  };
}

function complexBlockDetails(
  state: EditorState,
  node: Parameters<
    Parameters<ReturnType<typeof syntaxTree>["iterate"]>[0]["enter"]
  >[0],
) {
  const info = node.node.getChild("CodeInfo");
  const code = node.node.getChild("CodeText");
  if (info === null || code === null) return null;
  const language = state
    .sliceDoc(info.from, info.to)
    .trim()
    .toLocaleLowerCase();
  const kind: ComplexBlockKind | null =
    language === "mermaid"
      ? "mermaid"
      : language === "katex" || language === "math" || language === "latex"
        ? "katex"
        : null;
  return kind === null
    ? null
    : { kind, source: state.sliceDoc(code.from, code.to) };
}

/**
 * Classifies Markdown syntax directly from Lezer's incrementally maintained
 * tree. The returned ranges are disposable view data and never become a
 * source of document text.
 */
export function collectProgressiveDecorations(
  state: EditorState,
  from = 0,
  to = state.doc.length,
): readonly ProgressiveDecorationSpec[] {
  const specs: ProgressiveDecorationSpec[] = [];
  const seenBlockLines = new Set<string>();
  const addVisibleMark = (
    kind: ProgressiveDecorationKind,
    nodeFrom: number,
    nodeTo: number,
  ) => {
    const visibleFrom = Math.max(from, nodeFrom);
    const visibleTo = Math.min(to, nodeTo);
    if (visibleFrom < visibleTo) {
      specs.push({ kind, from: visibleFrom, to: visibleTo });
    }
  };

  const tree = ensureSyntaxTree(state, to, 50) ?? syntaxTree(state);
  tree.iterate({
    from,
    to,
    enter(node) {
      const headingKind = headingNames.get(node.name);
      if (headingKind !== undefined) {
        addVisibleMark(headingKind, node.from, node.to);
        return;
      }

      switch (node.name) {
        case "Emphasis":
          addVisibleMark("emphasis", node.from, node.to);
          break;
        case "StrongEmphasis":
          addVisibleMark("strong", node.from, node.to);
          break;
        case "Strikethrough":
          addVisibleMark("strikethrough", node.from, node.to);
          break;
        case "Link":
        case "Autolink":
          addVisibleMark("link", node.from, node.to);
          break;
        case "Blockquote":
          addBlockLines(
            state,
            specs,
            seenBlockLines,
            "quote-line",
            Math.max(from, node.from),
            Math.min(to, node.to),
          );
          break;
        case "BulletList":
        case "OrderedList":
          addBlockLines(
            state,
            specs,
            seenBlockLines,
            "list-line",
            Math.max(from, node.from),
            Math.min(to, node.to),
          );
          break;
        case "Table":
          addBlockLines(
            state,
            specs,
            seenBlockLines,
            "table-line",
            Math.max(from, node.from),
            Math.min(to, node.to),
          );
          break;
        case "TaskMarker":
          if (node.from >= from && node.to <= to) {
            specs.push({
              kind: "task",
              from: node.from,
              to: node.to,
              checked: /[xX]/u.test(state.sliceDoc(node.from, node.to)),
            });
          }
          break;
        case "FencedCode": {
          const complex = complexBlockDetails(state, node);
          if (complex !== null && node.to <= to) {
            specs.push({
              kind: "complex-block",
              from: node.from,
              to: node.to,
              complex,
            });
          }
          addVisibleMark("code", node.from, node.to);
          break;
        }
        case "CodeBlock":
        case "InlineCode":
        case "CodeText":
          addVisibleMark("code", node.from, node.to);
          break;
        case "CodeInfo":
          addVisibleMark("code-info", node.from, node.to);
          break;
        case "Image": {
          if (node.to < from || node.to > to) break;
          const url = node.node.getChild("URL");
          specs.push({
            kind: "image",
            from: node.from,
            to: node.to,
            image: imageDetails(state, node.from, node.to, url?.from, url?.to),
          });
          break;
        }
        default:
          if (syntaxNodeNames.has(node.name)) {
            addVisibleMark("syntax", node.from, node.to);
          }
      }
    },
  });

  return specs;
}

export function sanitizeImageSource(source: string): string | null {
  const candidate = source.trim();
  if (
    candidate === "" ||
    [...candidate].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    return null;
  }

  if (/^data:/iu.test(candidate)) {
    return /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/]+=*$/iu.test(
      candidate,
    )
      ? candidate
      : null;
  }

  const protocol = /^([a-z][a-z0-9+.-]*):/iu.exec(candidate)?.[1];
  if (protocol !== undefined && protocol !== "http" && protocol !== "https") {
    return null;
  }

  return candidate;
}

class ImagePreviewWidget extends WidgetType {
  constructor(
    private readonly source: string | null,
    private readonly alt: string,
  ) {
    super();
  }

  override eq(other: ImagePreviewWidget): boolean {
    return other.source === this.source && other.alt === this.alt;
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-image-widget";
    wrapper.dataset.mdImageWidget = "true";

    const fallback = document.createElement("span");
    fallback.className = "cm-md-image-fallback";
    fallback.textContent =
      this.source === null
        ? `图片预览已阻止${this.alt ? `：${this.alt}` : ""}`
        : `图片无法加载${this.alt ? `：${this.alt}` : ""}`;

    if (this.source === null) {
      wrapper.append(fallback);
      return wrapper;
    }

    const image = document.createElement("img");
    image.src = this.source;
    image.alt = this.alt;
    image.loading = "lazy";
    image.decoding = "async";
    image.draggable = false;
    fallback.hidden = true;
    image.addEventListener("error", () => {
      image.hidden = true;
      fallback.hidden = false;
    });
    wrapper.append(image, fallback);
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class TaskCheckboxWidget extends WidgetType {
  constructor(
    private readonly from: number,
    private readonly checked: boolean,
    private readonly readOnly: boolean,
  ) {
    super();
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return (
      other.from === this.from &&
      other.checked === this.checked &&
      other.readOnly === this.readOnly
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-md-task-checkbox";
    input.dataset.mdTaskCheckbox = "true";
    input.checked = this.checked;
    input.disabled = this.readOnly;
    input.setAttribute(
      "aria-label",
      this.checked ? "将任务标记为未完成" : "将任务标记为已完成",
    );
    input.addEventListener("change", () => {
      if (view.state.readOnly) return;
      const marker = view.state.sliceDoc(this.from, this.from + 3);
      if (!/^\[[ xX]\]$/u.test(marker)) return;
      view.dispatch({
        changes: {
          from: this.from + 1,
          to: this.from + 2,
          insert: input.checked ? "x" : " ",
        },
        userEvent: "input.task-toggle",
      });
      view.focus();
    });
    return input;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class ComplexBlockWidget extends WidgetType {
  private readonly controllers = new WeakMap<HTMLElement, AbortController>();

  constructor(
    private readonly kind: ComplexBlockKind,
    private readonly source: string,
    private readonly renderer: ComplexBlockRenderer | undefined,
  ) {
    super();
  }

  override eq(other: ComplexBlockWidget): boolean {
    return (
      other.kind === this.kind &&
      other.source === this.source &&
      other.renderer === this.renderer
    );
  }

  override get estimatedHeight(): number {
    return this.kind === "mermaid" ? 260 : 120;
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-complex-widget";
    wrapper.dataset.mdComplexWidget = this.kind;
    wrapper.dataset.mdRenderState = "loading";
    wrapper.setAttribute(
      "aria-label",
      this.kind === "katex" ? "KaTeX 数学预览" : "Mermaid 图表预览",
    );

    const content = document.createElement("span");
    content.className = "cm-md-complex-content";
    const status = document.createElement("span");
    status.className = "cm-md-complex-status";
    status.setAttribute("role", "status");
    status.textContent = `正在渲染 ${this.kind === "katex" ? "KaTeX" : "Mermaid"}…`;
    wrapper.append(content, status);

    const controller = new AbortController();
    this.controllers.set(wrapper, controller);
    void this.render(wrapper, content, status, controller.signal);
    return wrapper;
  }

  override destroy(dom: HTMLElement): void {
    this.controllers.get(dom)?.abort();
    this.controllers.delete(dom);
  }

  override ignoreEvent(): boolean {
    return true;
  }

  private async render(
    wrapper: HTMLElement,
    content: HTMLElement,
    status: HTMLElement,
    signal: AbortSignal,
  ) {
    try {
      if (this.renderer === undefined) throw new Error("渲染器不可用");
      await this.renderer({ container: content, source: this.source, signal });
      if (signal.aborted) return;
      if (!content.hasChildNodes()) throw new Error("渲染器未生成内容");
      wrapper.dataset.mdRenderState = "ready";
      status.remove();
    } catch (error) {
      if (signal.aborted) return;
      content.replaceChildren();
      wrapper.dataset.mdRenderState = "error";
      status.className = "cm-md-complex-status cm-md-complex-error";
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = `${this.kind === "katex" ? "公式" : "图表"}预览失败：${message.slice(0, 240)}。源码仍可编辑和保存。`;
    }
  }
}

function buildDecorations(
  view: EditorView,
  complexRenderers: ComplexBlockRenderers,
): DecorationSet {
  const ranges = [];
  const visibleSpecs = view.visibleRanges.flatMap(({ from, to }) =>
    collectProgressiveDecorations(view.state, from, to),
  );

  for (const spec of visibleSpecs) {
    if (
      spec.kind === "quote-line" ||
      spec.kind === "list-line" ||
      spec.kind === "table-line"
    ) {
      ranges.push(
        Decoration.line({ class: `cm-md-${spec.kind}` }).range(spec.from),
      );
      continue;
    }

    if (spec.kind === "task") {
      ranges.push(
        Decoration.replace({
          widget: new TaskCheckboxWidget(
            spec.from,
            spec.checked ?? false,
            view.state.readOnly,
          ),
        }).range(spec.from, spec.to),
      );
      continue;
    }

    if (spec.kind === "image" && spec.image !== undefined) {
      ranges.push(
        Decoration.widget({
          widget: new ImagePreviewWidget(spec.image.source, spec.image.alt),
          side: 1,
        }).range(spec.to),
      );
      continue;
    }

    if (spec.kind === "complex-block" && spec.complex !== undefined) {
      ranges.push(
        Decoration.widget({
          widget: new ComplexBlockWidget(
            spec.complex.kind,
            spec.complex.source,
            complexRenderers[spec.complex.kind],
          ),
          side: 1,
        }).range(spec.to),
      );
      continue;
    }

    if (spec.from < spec.to) {
      ranges.push(
        Decoration.mark({ class: `cm-md-${spec.kind}` }).range(
          spec.from,
          spec.to,
        ),
      );
    }
  }

  return Decoration.set(ranges, true);
}

const refreshProgressiveRendering = StateEffect.define<void>();

class ProgressiveRenderer {
  decorations: DecorationSet;
  private composing = false;

  constructor(
    view: EditorView,
    private readonly complexRenderers: ComplexBlockRenderers,
  ) {
    this.decorations = buildDecorations(view, complexRenderers);
  }

  update(update: ViewUpdate) {
    if (this.composing || update.view.composing) {
      if (update.docChanged) {
        this.decorations = this.decorations.map(update.changes);
      }
      return;
    }

    if (
      update.docChanged ||
      update.viewportChanged ||
      update.selectionSet ||
      update.geometryChanged ||
      update.transactions.some((transaction) =>
        transaction.effects.some((effect) =>
          effect.is(refreshProgressiveRendering),
        ),
      )
    ) {
      this.decorations = this.composing
        ? Decoration.none
        : buildDecorations(update.view, this.complexRenderers);
    }
  }

  startComposition() {
    this.composing = true;
    // Keep the existing decoration set mapped through composition changes.
    // Rebuilding widgets here can interrupt the platform IME's DOM range.
  }

  finishComposition(view: EditorView) {
    this.composing = false;
    view.dispatch({ effects: refreshProgressiveRendering.of() });
  }
}

function createProgressiveRenderingPlugin(
  complexRenderers: ComplexBlockRenderers,
) {
  return ViewPlugin.fromClass(
    class extends ProgressiveRenderer {
      constructor(view: EditorView) {
        super(view, complexRenderers);
      }
    },
    {
      decorations: (renderer) => renderer.decorations,
      eventHandlers: {
        compositionstart() {
          this.startComposition();
        },
        compositionend(_event, view) {
          this.finishComposition(view);
        },
      },
    },
  );
}

const progressiveRenderingTheme = EditorView.theme({
  "&.cm-md-hybrid .cm-md-heading-1": {
    fontSize: "1.8em",
    fontWeight: "750",
    letterSpacing: "-0.025em",
  },
  "&.cm-md-hybrid .cm-md-heading-2": {
    fontSize: "1.5em",
    fontWeight: "720",
    letterSpacing: "-0.018em",
  },
  "&.cm-md-hybrid .cm-md-heading-3": {
    fontSize: "1.28em",
    fontWeight: "700",
  },
  "&.cm-md-hybrid .cm-md-heading-4, &.cm-md-hybrid .cm-md-heading-5, &.cm-md-hybrid .cm-md-heading-6":
    {
      fontWeight: "700",
    },
  "&.cm-md-hybrid .cm-md-emphasis": { fontStyle: "italic" },
  "&.cm-md-hybrid .cm-md-strong": { fontWeight: "750" },
  "&.cm-md-hybrid .cm-md-strikethrough": {
    color: "var(--text-soft, #82786d)",
    textDecoration: "line-through",
  },
  "&.cm-md-hybrid .cm-md-link": {
    color: "var(--accent, #8a4e31)",
    textDecoration: "underline",
    textDecorationColor: "var(--accent-strong, #c89575)",
    textUnderlineOffset: "0.18em",
  },
  "&.cm-md-hybrid .cm-md-syntax": {
    color: "var(--text-faint, #a49b8f)",
  },
  "&.cm-md-hybrid .cm-line.cm-md-quote-line": {
    borderLeft: "3px solid var(--accent-strong, #c49370)",
    paddingLeft: "14px",
    color: "var(--text-muted, #625c53)",
    backgroundColor: "var(--active-line, #8d654808)",
  },
  "&.cm-md-hybrid .cm-line.cm-md-list-line": { paddingLeft: "4px" },
  "&.cm-md-hybrid .cm-line.cm-md-table-line": {
    borderLeft: "1px solid var(--border, #d8ccbc)",
    borderRight: "1px solid var(--border, #d8ccbc)",
    padding: "1px 10px",
    backgroundColor: "var(--surface-translucent, #fffaf080)",
  },
  ".cm-md-task-checkbox": {
    width: "1em",
    height: "1em",
    margin: "0 0.45em 0 0",
    accentColor: "var(--accent-strong, #9b5c39)",
    verticalAlign: "-0.1em",
    cursor: "pointer",
  },
  "&.cm-md-hybrid .cm-md-code": {
    borderRadius: "4px",
    color: "var(--accent, #6d3f2a)",
    backgroundColor: "var(--accent-surface, #e9dfd0a8)",
  },
  "&.cm-md-hybrid .cm-md-code-info": {
    color: "var(--text-muted, #7c6759)",
    fontSize: "0.82em",
    fontWeight: "650",
  },
  ".cm-md-image-widget": {
    display: "inline-flex",
    maxWidth: "min(100%, 680px)",
    margin: "10px 0 10px 12px",
    verticalAlign: "middle",
  },
  ".cm-md-image-widget img": {
    display: "block",
    maxWidth: "100%",
    maxHeight: "360px",
    border: "1px solid var(--border, #d5ccbe)",
    borderRadius: "8px",
    backgroundColor: "var(--surface, #fffaf0)",
    objectFit: "contain",
  },
  ".cm-md-image-fallback": {
    padding: "5px 9px",
    border: "1px dashed var(--border-control, #c8bbae)",
    borderRadius: "5px",
    color: "var(--text-soft, #82786d)",
    backgroundColor: "var(--surface, #fffaf0)",
    fontFamily: "Inter, sans-serif",
    fontSize: "12px",
  },
  ".cm-md-complex-widget": {
    display: "inline-flex",
    flexDirection: "column",
    width: "min(calc(100% - 16px), 760px)",
    maxWidth: "760px",
    maxHeight: "520px",
    margin: "10px auto 18px",
    overflow: "auto",
    border: "1px solid var(--border, #d5ccbe)",
    borderRadius: "8px",
    backgroundColor: "var(--surface, #fffaf0)",
    fontFamily: 'Inter, "Noto Sans SC", sans-serif',
    verticalAlign: "top",
  },
  ".cm-md-complex-content": {
    display: "block",
    minHeight: "48px",
    padding: "14px 16px",
    textAlign: "center",
  },
  ".cm-md-complex-content svg": {
    display: "block",
    maxWidth: "100%",
    height: "auto",
    margin: "0 auto",
  },
  ".cm-md-complex-status": {
    display: "block",
    padding: "8px 12px",
    color: "var(--text-soft, #82786d)",
    borderTop: "1px solid var(--border, #d5ccbe)",
    fontSize: "12px",
  },
  ".cm-md-complex-error": {
    color: "var(--notice-fg, #69492f)",
    backgroundColor: "var(--notice-bg, #fff4dd)",
  },
});

export function createEditorModeExtension(
  mode: EditorMode,
  complexRenderers: ComplexBlockRenderers = {},
): Extension {
  if (mode === "source") return [];

  return [
    EditorView.editorAttributes.of({ class: "cm-md-hybrid" }),
    createProgressiveRenderingPlugin(complexRenderers),
    progressiveRenderingTheme,
  ];
}
