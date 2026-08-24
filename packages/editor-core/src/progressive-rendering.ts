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

export type ProgressiveDecorationKind =
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "heading-4"
  | "heading-5"
  | "heading-6"
  | "emphasis"
  | "strong"
  | "link"
  | "quote-line"
  | "list-line"
  | "code"
  | "code-info"
  | "syntax"
  | "image";

export interface ProgressiveDecorationSpec {
  readonly kind: ProgressiveDecorationKind;
  readonly from: number;
  readonly to: number;
  readonly image?: {
    readonly alt: string;
    readonly source: string | null;
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
]);

function addBlockLines(
  state: EditorState,
  specs: ProgressiveDecorationSpec[],
  seen: Set<string>,
  kind: "quote-line" | "list-line",
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
        case "FencedCode":
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

function buildDecorations(view: EditorView): DecorationSet {
  const ranges = [];
  const visibleSpecs = view.visibleRanges.flatMap(({ from, to }) =>
    collectProgressiveDecorations(view.state, from, to),
  );

  for (const spec of visibleSpecs) {
    if (spec.kind === "quote-line" || spec.kind === "list-line") {
      ranges.push(
        Decoration.line({ class: `cm-md-${spec.kind}` }).range(spec.from),
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

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view);
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
        : buildDecorations(update.view);
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

const progressiveRenderingPlugin = ViewPlugin.fromClass(ProgressiveRenderer, {
  decorations: (renderer) => renderer.decorations,
  eventHandlers: {
    compositionstart() {
      this.startComposition();
    },
    compositionend(_event, view) {
      this.finishComposition(view);
    },
  },
});

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
  "&.cm-md-hybrid .cm-md-link": {
    color: "#8a4e31",
    textDecoration: "underline",
    textDecorationColor: "#c89575",
    textUnderlineOffset: "0.18em",
  },
  "&.cm-md-hybrid .cm-md-syntax": { color: "#a49b8f" },
  "&.cm-md-hybrid .cm-line.cm-md-quote-line": {
    borderLeft: "3px solid #c49370",
    paddingLeft: "14px",
    color: "#625c53",
    backgroundColor: "#8d654808",
  },
  "&.cm-md-hybrid .cm-line.cm-md-list-line": { paddingLeft: "4px" },
  "&.cm-md-hybrid .cm-md-code": {
    borderRadius: "4px",
    color: "#6d3f2a",
    backgroundColor: "#e9dfd0a8",
  },
  "&.cm-md-hybrid .cm-md-code-info": {
    color: "#7c6759",
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
    border: "1px solid #d5ccbe",
    borderRadius: "8px",
    backgroundColor: "#fffaf0",
    objectFit: "contain",
  },
  ".cm-md-image-fallback": {
    padding: "5px 9px",
    border: "1px dashed #c8bbae",
    borderRadius: "5px",
    color: "#82786d",
    backgroundColor: "#fffaf0",
    fontFamily: "Inter, sans-serif",
    fontSize: "12px",
  },
});

export function createEditorModeExtension(mode: EditorMode): Extension {
  if (mode === "source") return [];

  return [
    EditorView.editorAttributes.of({ class: "cm-md-hybrid" }),
    progressiveRenderingPlugin,
    progressiveRenderingTheme,
  ];
}
