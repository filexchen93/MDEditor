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
import {
  collectMarkdownExtensionRanges,
  defaultMarkdownProfile,
  renderMarkdownToSafeHtml,
  sanitizeRenderedMarkdown,
  type MarkdownExtensionRange,
  type MarkdownProfile,
} from "@mdeditor/markdown";

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
export type ImageSourceResolver = (source: string) => Promise<string | null>;

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
  | "table-preview"
  | "horizontal-rule"
  | "task"
  | "code"
  | "code-info"
  | "syntax"
  | "image"
  | "complex-block"
  | "complex-inline"
  | "extension-preview"
  | "html-preview";

export interface ProgressiveDecorationSpec {
  readonly kind: ProgressiveDecorationKind;
  readonly from: number;
  readonly to: number;
  readonly image?: {
    readonly alt: string;
    readonly source: string | null;
    readonly markdown: string;
  };
  readonly checked?: boolean;
  readonly complex?: {
    readonly kind: ComplexBlockKind;
    readonly source: string;
    readonly markdown: string;
  };
  readonly syntax?: {
    readonly source: string;
    readonly ownerFrom: number;
    readonly ownerTo: number;
    readonly previewText?: string;
  };
  readonly table?: {
    readonly source: string;
  };
  readonly horizontalRule?: {
    readonly source: string;
  };
  readonly extension?: MarkdownExtensionRange;
  readonly html?: { readonly source: string; readonly block: boolean };
}

const previewableHtmlTags = new Set([
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "details",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "kbd",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "section",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);
const inlineHtmlTags = new Set([
  "a",
  "abbr",
  "b",
  "br",
  "code",
  "del",
  "em",
  "i",
  "kbd",
  "s",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
]);
const voidHtmlTags = new Set(["br", "hr"]);

function htmlTag(
  source: string,
): { name: string; closing: boolean; void: boolean } | null {
  const match = /^<\s*(\/?)\s*([a-z][a-z0-9-]*)\b[^>]*>$/iu.exec(source);
  if (match === null) return null;
  const name = match[2]!.toLowerCase();
  return {
    name,
    closing: match[1] === "/",
    void: voidHtmlTags.has(name) || /\/\s*>$/u.test(source),
  };
}

function isPotentiallyPreviewableHtml(source: string): boolean {
  if (source.length > 16_384 || /<\s*(?:!|\?)/u.test(source)) return false;
  if (/\b(?:on[a-z]+|style|src|srcset)\s*=/iu.test(source)) return false;
  const tags = [...source.matchAll(/<\s*\/?\s*[a-z][a-z0-9-]*\b[^>]*>/giu)];
  return (
    tags.length > 0 &&
    tags.every(([tag]) => {
      const parsed = htmlTag(tag);
      return parsed !== null && previewableHtmlTags.has(parsed.name);
    })
  );
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
  "ImageMark",
  "LinkMark",
  "ListMark",
  "QuoteMark",
  "StrikethroughMark",
]);

const syntaxOwnerNames = new Set([
  ...headingNames.keys(),
  "Blockquote",
  "BulletList",
  "OrderedList",
  "ListItem",
  "Emphasis",
  "StrongEmphasis",
  "Strikethrough",
  "Link",
  "Autolink",
  "Image",
  "InlineCode",
  "FencedCode",
]);

function syntaxOwner(node: {
  readonly from: number;
  readonly to: number;
  readonly name: string;
  readonly parent: typeof node | null;
}) {
  let candidate = node.parent;
  while (candidate !== null && !syntaxOwnerNames.has(candidate.name)) {
    candidate = candidate.parent;
  }
  return candidate;
}

function syntaxPreviewText(nodeName: string, source: string) {
  if (nodeName !== "ListMark") return undefined;
  return /^[-+*]$/u.test(source) ? "•" : source;
}

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
    markdown,
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
    : {
        kind,
        source: state.sliceDoc(code.from, code.to),
        markdown: state.sliceDoc(node.from, node.to),
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
  profile: MarkdownProfile = defaultMarkdownProfile,
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
        case "Paragraph": {
          const openings: { name: string; from: number }[] = [];
          for (const tagNode of node.node.getChildren("HTMLTag")) {
            const tag = htmlTag(state.sliceDoc(tagNode.from, tagNode.to));
            if (tag === null || !inlineHtmlTags.has(tag.name)) {
              openings.length = 0;
              continue;
            }
            if (tag.void && !tag.closing) {
              const source = state.sliceDoc(tagNode.from, tagNode.to);
              if (isPotentiallyPreviewableHtml(source)) {
                specs.push({
                  kind: "html-preview",
                  from: tagNode.from,
                  to: tagNode.to,
                  html: { source, block: false },
                });
              }
            } else if (!tag.closing) {
              openings.push({ name: tag.name, from: tagNode.from });
            } else {
              const opening = openings.pop();
              if (opening?.name !== tag.name) {
                openings.length = 0;
                continue;
              }
              if (
                openings.length === 0 &&
                opening.from >= from &&
                tagNode.to <= to
              ) {
                const source = state.sliceDoc(opening.from, tagNode.to);
                if (isPotentiallyPreviewableHtml(source)) {
                  specs.push({
                    kind: "html-preview",
                    from: opening.from,
                    to: tagNode.to,
                    html: { source, block: false },
                  });
                }
              }
            }
          }
          break;
        }
        case "HTMLBlock": {
          if (node.from >= from && node.to <= to) {
            const source = state.sliceDoc(node.from, node.to);
            if (
              !/\bpage-break\b/u.test(source) &&
              isPotentiallyPreviewableHtml(source)
            ) {
              specs.push({
                kind: "html-preview",
                from: node.from,
                to: node.to,
                html: { source, block: true },
              });
            }
          }
          break;
        }
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
          if (node.from >= from && node.to <= to) {
            specs.push({
              kind: "table-preview",
              from: node.from,
              to: node.to,
              table: { source: state.sliceDoc(node.from, node.to) },
            });
          }
          addBlockLines(
            state,
            specs,
            seenBlockLines,
            "table-line",
            Math.max(from, node.from),
            Math.min(to, node.to),
          );
          break;
        case "HorizontalRule":
          if (node.from >= from && node.to <= to) {
            specs.push({
              kind: "horizontal-rule",
              from: node.from,
              to: node.to,
              horizontalRule: { source: state.sliceDoc(node.from, node.to) },
            });
          }
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
        case "URL": {
          const owner = syntaxOwner(node.node);
          if (owner?.name !== "Link" && owner?.name !== "Image") break;
          const visibleFrom = Math.max(from, node.from);
          const visibleTo = Math.min(to, node.to);
          if (visibleFrom < visibleTo) {
            specs.push({
              kind: "syntax",
              from: visibleFrom,
              to: visibleTo,
              syntax: {
                source: state.doc.sliceString(visibleFrom, visibleTo),
                ownerFrom: owner.from,
                ownerTo: owner.to,
              },
            });
          }
          break;
        }
        default:
          if (syntaxNodeNames.has(node.name)) {
            const visibleFrom = Math.max(from, node.from);
            const visibleTo = Math.min(to, node.to);
            const owner = syntaxOwner(node.node);
            if (visibleFrom < visibleTo && owner !== null) {
              const source = state.doc.sliceString(visibleFrom, visibleTo);
              specs.push({
                kind: "syntax",
                from: visibleFrom,
                to: visibleTo,
                syntax: {
                  source,
                  ownerFrom: owner.from,
                  ownerTo: owner.to,
                  previewText: syntaxPreviewText(node.name, source),
                },
              });
            }
          }
      }
    },
  });

  const firstLine = state.doc.lineAt(from).number;
  const lastLine = state.doc.lineAt(Math.max(from, to - 1)).number;
  const scanFrom = state.doc.line(Math.max(1, firstLine - 80)).from;
  const scanTo = state.doc.line(Math.min(state.doc.lines, lastLine + 80)).to;
  const extensionRanges = collectMarkdownExtensionRanges(
    state.sliceDoc(scanFrom, scanTo),
    profile,
  ).map((range) => ({
    ...range,
    from: range.from + scanFrom,
    to: range.to + scanFrom,
  }));

  for (const range of extensionRanges) {
    if (range.to < from || range.from > to) continue;
    if (/^ {0,3}(?:`{3,}|~{3,})/u.test(range.source)) continue;
    if (range.kind === "inline-math") {
      specs.push({
        kind: "complex-inline",
        from: range.from,
        to: range.to,
        complex: {
          kind: "katex",
          source: range.content ?? "",
          markdown: range.source,
        },
      });
    } else if (range.kind === "block-math") {
      specs.push({
        kind: "complex-block",
        from: range.from,
        to: range.to,
        complex: {
          kind: "katex",
          source: range.content ?? "",
          markdown: range.source,
        },
      });
    } else if (range.kind !== "mermaid") {
      specs.push({
        kind: "extension-preview",
        from: range.from,
        to: range.to,
        extension: range,
      });
    }
  }

  return specs;
}

export function sanitizeImageSource(source: string): string | null {
  const trimmed = source.trim();
  const candidate =
    trimmed.startsWith("<") && trimmed.endsWith(">")
      ? trimmed.slice(1, -1)
      : trimmed;
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

  // The desktop resolver checks the opened document's directory before it
  // reads an absolute Windows path. Keep other protocols blocked here.
  if (/^[a-z]:[\\/]/iu.test(candidate)) return candidate;

  const protocol = /^([a-z][a-z0-9+.-]*):/iu
    .exec(candidate)?.[1]
    ?.toLowerCase();
  if (protocol !== undefined && protocol !== "http" && protocol !== "https") {
    return null;
  }

  return candidate;
}

function activateSource(
  view: EditorView,
  from: number,
  to: number,
  event?: Event,
) {
  event?.preventDefault();
  event?.stopPropagation();
  view.dispatch({
    selection: { anchor: Math.min(from + 1, to) },
    scrollIntoView: true,
    userEvent: "select.preview-source",
  });
  view.focus();
}

function installSourceActivation(
  element: HTMLElement,
  view: EditorView,
  from: number,
  to: number,
  label: string,
) {
  element.tabIndex = 0;
  element.setAttribute("role", "button");
  element.setAttribute("aria-label", label);
  element.title = label;
  element.addEventListener("click", (event) => {
    activateSource(view, from, to, event);
  });
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      activateSource(view, from, to, event);
    }
  });
}

class ImagePreviewWidget extends WidgetType {
  private readonly liveElements = new WeakSet<HTMLElement>();

  constructor(
    private readonly from: number,
    private readonly to: number,
    private readonly source: string | null,
    private readonly alt: string,
    private readonly markdown: string,
    private readonly replacesSource: boolean,
    private readonly resolveImageSource: ImageSourceResolver | undefined,
  ) {
    super();
  }

  override eq(other: ImagePreviewWidget): boolean {
    return (
      other.from === this.from &&
      other.to === this.to &&
      other.source === this.source &&
      other.alt === this.alt &&
      other.markdown === this.markdown &&
      other.replacesSource === this.replacesSource &&
      other.resolveImageSource === this.resolveImageSource
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-image-widget";
    wrapper.dataset.mdImageWidget = "true";
    if (this.replacesSource) wrapper.dataset.mdSourceInline = this.markdown;
    installSourceActivation(wrapper, view, this.from, this.to, "编辑图片源码");

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

    const showImage = (source: string) => {
      if (!this.liveElements.has(wrapper)) return;
      const image = document.createElement("img");
      image.src = source;
      image.alt = this.alt;
      image.loading = "lazy";
      image.decoding = "async";
      image.draggable = false;
      fallback.hidden = true;
      image.addEventListener("error", () => {
        image.hidden = true;
        fallback.hidden = false;
      });
      wrapper.prepend(image);
    };
    this.liveElements.add(wrapper);
    wrapper.append(fallback);
    const external = /^(?:data:|https?:)/iu.test(this.source);
    if (
      external ||
      (this.resolveImageSource === undefined &&
        !/^[a-z]:[\\/]/iu.test(this.source))
    ) {
      showImage(this.source);
    } else if (this.resolveImageSource === undefined) {
      fallback.textContent = `图片预览已阻止${this.alt ? `：${this.alt}` : ""}`;
    } else {
      fallback.textContent = `正在加载图片${this.alt ? `：${this.alt}` : ""}`;
      void this.resolveImageSource(this.source)
        .then((resolved) => {
          if (!this.liveElements.has(wrapper)) return;
          if (resolved === null) {
            fallback.textContent = `图片预览已阻止${this.alt ? `：${this.alt}` : ""}`;
            return;
          }
          showImage(resolved);
        })
        .catch(() => {
          if (!this.liveElements.has(wrapper)) return;
          fallback.textContent = `图片无法加载${this.alt ? `：${this.alt}` : ""}`;
        });
    }
    return wrapper;
  }

  override destroy(dom: HTMLElement): void {
    this.liveElements.delete(dom);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class TablePreviewWidget extends WidgetType {
  constructor(
    private readonly from: number,
    private readonly to: number,
    private readonly source: string,
  ) {
    super();
  }

  override eq(other: TablePreviewWidget): boolean {
    return (
      other.from === this.from &&
      other.to === this.to &&
      other.source === this.source
    );
  }

  override get estimatedHeight(): number {
    return 120;
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-table-preview";
    wrapper.dataset.mdTablePreview = "true";
    wrapper.dataset.mdSourceBlock = this.source;
    installSourceActivation(wrapper, view, this.from, this.to, "编辑表格源码");
    try {
      wrapper.innerHTML = renderMarkdownToSafeHtml(this.source);
    } catch {
      const fallback = document.createElement("pre");
      fallback.textContent = this.source;
      wrapper.append(fallback);
    }
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class HorizontalRuleWidget extends WidgetType {
  constructor(
    private readonly from: number,
    private readonly to: number,
    private readonly source: string,
  ) {
    super();
  }

  override eq(other: HorizontalRuleWidget): boolean {
    return (
      other.from === this.from &&
      other.to === this.to &&
      other.source === this.source
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-horizontal-rule-preview";
    wrapper.dataset.mdHorizontalRulePreview = "true";
    wrapper.dataset.mdSourceInline = this.source;
    installSourceActivation(
      wrapper,
      view,
      this.from,
      this.to,
      "编辑水平线源码",
    );
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class ExtensionPreviewWidget extends WidgetType {
  constructor(
    private readonly from: number,
    private readonly to: number,
    private readonly extension: MarkdownExtensionRange,
    private readonly profile: MarkdownProfile,
    private readonly documentSource: string,
  ) {
    super();
  }

  override eq(other: ExtensionPreviewWidget): boolean {
    return (
      other.from === this.from &&
      other.to === this.to &&
      other.extension.source === this.extension.source &&
      other.extension.kind === this.extension.kind &&
      other.profile === this.profile &&
      other.documentSource === this.documentSource
    );
  }

  override get estimatedHeight(): number {
    return this.extension.kind === "footnote-reference" ? -1 : 72;
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = `cm-md-extension-preview cm-md-extension-${this.extension.kind}`;
    wrapper.dataset.mdExtensionPreview = this.extension.kind;
    if (this.extension.kind === "footnote-reference") {
      wrapper.dataset.mdSourceInline = this.extension.source;
    } else {
      wrapper.dataset.mdSourceBlock = this.extension.source;
    }
    const labels: Readonly<Record<MarkdownExtensionRange["kind"], string>> = {
      "front-matter": "Front Matter",
      toc: "目录",
      alert: "提示块",
      "footnote-definition": "脚注定义",
      "footnote-reference": "脚注引用",
      "inline-math": "行内公式",
      "block-math": "块级公式",
      mermaid: "Mermaid 图表",
    };
    installSourceActivation(
      wrapper,
      view,
      this.from,
      this.to,
      `编辑${labels[this.extension.kind]}源码`,
    );

    if (this.extension.kind === "footnote-reference") {
      const superscript = document.createElement("sup");
      superscript.textContent = this.extension.identifier ?? "脚注";
      wrapper.append(superscript);
      return wrapper;
    }

    const renderSource =
      this.extension.kind === "toc"
        ? this.documentSource
        : this.extension.kind === "footnote-definition"
          ? (this.extension.content ?? "")
          : this.extension.source;
    try {
      const html = renderMarkdownToSafeHtml(renderSource, window, this.profile);
      if (this.extension.kind === "toc") {
        const container = document.createElement("span");
        container.innerHTML = html;
        const toc = container.querySelector(".md-toc");
        if (toc !== null) wrapper.append(toc.cloneNode(true));
        else wrapper.textContent = "暂无标题";
      } else {
        wrapper.innerHTML = html;
      }
    } catch {
      wrapper.textContent = renderSource;
    }
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function safeHtmlPreview(source: string): string | null {
  if (!isPotentiallyPreviewableHtml(source)) return null;
  const template = document.createElement("template");
  template.innerHTML = source;
  const elements = [...template.content.querySelectorAll("*")];
  if (
    elements.length === 0 ||
    elements.some(
      (element) =>
        !previewableHtmlTags.has(element.localName) ||
        [...element.attributes].some(
          ({ name }) =>
            !["align", "class", "href", "id", "title"].includes(name),
        ),
    )
  ) {
    return null;
  }
  const sanitized = sanitizeRenderedMarkdown(source);
  const clean = document.createElement("template");
  clean.innerHTML = sanitized;
  const originalLinks = elements.filter((element) => element.localName === "a");
  if (
    [...clean.content.querySelectorAll("a")].some(
      (link, index) =>
        originalLinks[index]?.hasAttribute("href") &&
        !link.hasAttribute("href"),
    )
  ) {
    return null;
  }
  clean.content.querySelectorAll("a[href]").forEach((link) => {
    link.removeAttribute("href");
    link.removeAttribute("target");
    link.removeAttribute("rel");
  });
  return clean.innerHTML.trim() === "" ? null : clean.innerHTML;
}

class HtmlPreviewWidget extends WidgetType {
  constructor(
    private readonly from: number,
    private readonly to: number,
    private readonly source: string,
    private readonly block: boolean,
  ) {
    super();
  }

  override eq(other: HtmlPreviewWidget): boolean {
    return (
      other.from === this.from &&
      other.to === this.to &&
      other.source === this.source &&
      other.block === this.block
    );
  }

  override get estimatedHeight(): number {
    return this.block ? 72 : -1;
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = `cm-md-html-preview ${this.block ? "cm-md-html-block" : "cm-md-html-inline"}`;
    wrapper.dataset.mdHtmlPreview = this.block ? "block" : "inline";
    if (this.block) wrapper.dataset.mdSourceBlock = this.source;
    else wrapper.dataset.mdSourceInline = this.source;
    installSourceActivation(
      wrapper,
      view,
      this.from,
      this.to,
      "编辑 HTML 源码",
    );
    const safe = safeHtmlPreview(this.source);
    if (safe === null) {
      wrapper.classList.add("cm-md-html-rejected");
      wrapper.textContent = this.source;
    } else {
      wrapper.innerHTML = safe;
      const previewText = wrapper.textContent
        ?.trim()
        .replace(/\s+/gu, " ")
        .slice(0, 80);
      if (previewText) {
        wrapper.setAttribute("aria-label", `编辑 HTML 源码：${previewText}`);
      }
      for (const child of wrapper.children) {
        (child as HTMLElement).inert = true;
      }
    }
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class HiddenPreviewLineWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const placeholder = document.createElement("span");
    placeholder.className = "cm-md-hidden-preview-line";
    placeholder.dataset.mdSourceContinuation = "true";
    placeholder.setAttribute("aria-hidden", "true");
    return placeholder;
  }
}

class HiddenSyntaxWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly previewText: string | undefined,
  ) {
    super();
  }

  override eq(other: HiddenSyntaxWidget): boolean {
    return (
      other.source === this.source && other.previewText === this.previewText
    );
  }

  override toDOM(): HTMLElement {
    const placeholder = document.createElement("span");
    placeholder.className = "cm-md-hidden-syntax";
    placeholder.dataset.mdSourceMark = this.source;
    placeholder.setAttribute("aria-hidden", "true");
    if (this.previewText !== undefined) {
      placeholder.classList.add("cm-md-list-marker-preview");
      placeholder.textContent = this.previewText;
    }
    return placeholder;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Whether a syntax delimiter belongs to the current cursor or selection. */
export function isProgressiveSyntaxActive(
  state: EditorState,
  spec: ProgressiveDecorationSpec,
): boolean {
  if (spec.syntax === undefined) return true;
  const { ownerFrom, ownerTo } = spec.syntax;
  return state.selection.ranges.some((range) =>
    range.empty
      ? range.head >= ownerFrom && range.head <= ownerTo
      : range.from < ownerTo && range.to > ownerFrom,
  );
}

function isPreviewRangeActive(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  return state.selection.ranges.some((range) =>
    range.empty
      ? range.head >= from && range.head <= to
      : range.from < to && range.to > from,
  );
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
    private readonly from: number,
    private readonly to: number,
    private readonly kind: ComplexBlockKind,
    private readonly source: string,
    private readonly markdown: string,
    private readonly replacesSource: boolean,
    private readonly renderer: ComplexBlockRenderer | undefined,
    private readonly inline = false,
  ) {
    super();
  }

  override eq(other: ComplexBlockWidget): boolean {
    return (
      other.from === this.from &&
      other.to === this.to &&
      other.kind === this.kind &&
      other.source === this.source &&
      other.markdown === this.markdown &&
      other.replacesSource === this.replacesSource &&
      other.renderer === this.renderer &&
      other.inline === this.inline
    );
  }

  override get estimatedHeight(): number {
    if (this.inline) return -1;
    return this.kind === "mermaid" ? 260 : 120;
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-complex-widget";
    wrapper.dataset.mdComplexWidget = this.kind;
    wrapper.dataset.mdRenderState = "loading";
    if (this.replacesSource) {
      if (this.inline) wrapper.dataset.mdSourceInline = this.markdown;
      else wrapper.dataset.mdSourceBlock = this.markdown;
    }
    if (this.inline) wrapper.classList.add("cm-md-complex-inline");
    installSourceActivation(
      wrapper,
      view,
      this.from,
      this.to,
      this.kind === "katex" ? "编辑 KaTeX 数学源码" : "编辑 Mermaid 图表源码",
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
  profile: MarkdownProfile,
  resolveImageSource: ImageSourceResolver | undefined,
): DecorationSet {
  const ranges = [];
  const visibleSpecs = view.visibleRanges.flatMap(({ from, to }) =>
    collectProgressiveDecorations(view.state, from, to, profile),
  );
  const inactivePreviews = visibleSpecs.filter(
    (spec) =>
      (spec.kind === "image" ||
        spec.kind === "complex-block" ||
        spec.kind === "complex-inline" ||
        spec.kind === "extension-preview" ||
        spec.kind === "html-preview" ||
        spec.kind === "table-preview" ||
        spec.kind === "horizontal-rule") &&
      !isPreviewRangeActive(view.state, spec.from, spec.to),
  );
  const replaceLinesWithPreview = (
    from: number,
    to: number,
    widget: WidgetType,
  ) => {
    let line = view.state.doc.lineAt(from);
    const finalLine = view.state.doc.lineAt(Math.max(from, to - 1)).number;
    let first = true;
    while (line.number <= finalLine) {
      const lineWidget = first ? widget : new HiddenPreviewLineWidget();
      ranges.push(
        line.from < line.to
          ? Decoration.replace({ widget: lineWidget }).range(line.from, line.to)
          : Decoration.widget({ widget: lineWidget }).range(line.from),
      );
      first = false;
      if (line.number === view.state.doc.lines) break;
      line = view.state.doc.line(line.number + 1);
    }
  };

  for (const spec of visibleSpecs) {
    if (
      inactivePreviews.some(
        (preview) =>
          preview !== spec &&
          spec.from >= preview.from &&
          spec.to <= preview.to,
      )
    ) {
      continue;
    }

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

    if (spec.kind === "syntax" && spec.syntax !== undefined) {
      if (isProgressiveSyntaxActive(view.state, spec)) {
        ranges.push(
          Decoration.mark({ class: "cm-md-syntax cm-md-syntax-active" }).range(
            spec.from,
            spec.to,
          ),
        );
      } else {
        ranges.push(
          Decoration.replace({
            widget: new HiddenSyntaxWidget(
              spec.syntax.source,
              spec.syntax.previewText,
            ),
          }).range(spec.from, spec.to),
        );
      }
      continue;
    }

    if (spec.kind === "image" && spec.image !== undefined) {
      const active = isPreviewRangeActive(view.state, spec.from, spec.to);
      const widget = new ImagePreviewWidget(
        spec.from,
        spec.to,
        spec.image.source,
        spec.image.alt,
        spec.image.markdown,
        !active,
        resolveImageSource,
      );
      ranges.push(
        active
          ? Decoration.widget({ widget, side: 1 }).range(spec.to)
          : Decoration.replace({ widget }).range(spec.from, spec.to),
      );
      continue;
    }

    if (spec.kind === "table-preview" && spec.table !== undefined) {
      if (!isPreviewRangeActive(view.state, spec.from, spec.to)) {
        replaceLinesWithPreview(
          spec.from,
          spec.to,
          new TablePreviewWidget(spec.from, spec.to, spec.table.source),
        );
      }
      continue;
    }

    if (spec.kind === "horizontal-rule" && spec.horizontalRule !== undefined) {
      if (!isPreviewRangeActive(view.state, spec.from, spec.to)) {
        ranges.push(
          Decoration.replace({
            widget: new HorizontalRuleWidget(
              spec.from,
              spec.to,
              spec.horizontalRule.source,
            ),
          }).range(spec.from, spec.to),
        );
      } else {
        ranges.push(
          Decoration.mark({ class: "cm-md-syntax cm-md-syntax-active" }).range(
            spec.from,
            spec.to,
          ),
        );
      }
      continue;
    }

    if (spec.kind === "extension-preview" && spec.extension !== undefined) {
      const active = isPreviewRangeActive(view.state, spec.from, spec.to);
      if (active) {
        ranges.push(
          Decoration.mark({ class: "cm-md-syntax cm-md-syntax-active" }).range(
            spec.from,
            spec.to,
          ),
        );
        continue;
      }
      const widget = new ExtensionPreviewWidget(
        spec.from,
        spec.to,
        spec.extension,
        profile,
        spec.extension.kind === "toc" ? view.state.sliceDoc() : "",
      );
      if (spec.extension.kind === "footnote-reference") {
        ranges.push(Decoration.replace({ widget }).range(spec.from, spec.to));
      } else {
        replaceLinesWithPreview(spec.from, spec.to, widget);
      }
      continue;
    }

    if (spec.kind === "html-preview" && spec.html !== undefined) {
      if (!isPreviewRangeActive(view.state, spec.from, spec.to)) {
        const widget = new HtmlPreviewWidget(
          spec.from,
          spec.to,
          spec.html.source,
          spec.html.block,
        );
        if (spec.html.block)
          replaceLinesWithPreview(spec.from, spec.to, widget);
        else
          ranges.push(Decoration.replace({ widget }).range(spec.from, spec.to));
      } else {
        ranges.push(
          Decoration.mark({ class: "cm-md-syntax cm-md-syntax-active" }).range(
            spec.from,
            spec.to,
          ),
        );
      }
      continue;
    }

    if (spec.kind === "complex-inline" && spec.complex !== undefined) {
      const active = isPreviewRangeActive(view.state, spec.from, spec.to);
      const widget = new ComplexBlockWidget(
        spec.from,
        spec.to,
        spec.complex.kind,
        spec.complex.source,
        spec.complex.markdown,
        !active,
        complexRenderers[spec.complex.kind],
        true,
      );
      ranges.push(
        active
          ? Decoration.widget({ widget, side: 1 }).range(spec.to)
          : Decoration.replace({ widget }).range(spec.from, spec.to),
      );
      continue;
    }

    if (spec.kind === "complex-block" && spec.complex !== undefined) {
      const active = isPreviewRangeActive(view.state, spec.from, spec.to);
      const widget = new ComplexBlockWidget(
        spec.from,
        spec.to,
        spec.complex.kind,
        spec.complex.source,
        spec.complex.markdown,
        !active,
        complexRenderers[spec.complex.kind],
      );
      if (active) {
        ranges.push(Decoration.widget({ widget, side: 1 }).range(spec.to));
      } else {
        replaceLinesWithPreview(spec.from, spec.to, widget);
      }
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
    private readonly profile: MarkdownProfile,
    private readonly resolveImageSource: ImageSourceResolver | undefined,
  ) {
    this.decorations = buildDecorations(
      view,
      complexRenderers,
      profile,
      resolveImageSource,
    );
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
        : buildDecorations(
            update.view,
            this.complexRenderers,
            this.profile,
            this.resolveImageSource,
          );
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
  profile: MarkdownProfile,
  resolveImageSource: ImageSourceResolver | undefined,
) {
  return ViewPlugin.fromClass(
    class extends ProgressiveRenderer {
      constructor(view: EditorView) {
        super(view, complexRenderers, profile, resolveImageSource);
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
  "&.cm-md-hybrid .cm-md-hidden-syntax": {
    display: "inline-block",
    width: "0",
    overflow: "hidden",
  },
  "&.cm-md-hybrid .cm-md-list-marker-preview": {
    width: "auto",
    minWidth: "1.15em",
    overflow: "visible",
    color: "var(--text-muted, #625c53)",
    textAlign: "center",
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
    cursor: "pointer",
  },
  ".cm-md-image-widget:focus-visible, .cm-md-complex-widget:focus-visible, .cm-md-table-preview:focus-visible":
    {
      outline: "2px solid var(--accent-strong, #9b5c39)",
      outlineOffset: "3px",
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
    cursor: "pointer",
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
  ".cm-md-complex-widget.cm-md-complex-inline": {
    display: "inline-flex",
    width: "auto",
    maxWidth: "min(100%, 36em)",
    maxHeight: "none",
    margin: "0 .15em",
    border: "0",
    borderRadius: "3px",
    verticalAlign: "middle",
  },
  ".cm-md-complex-inline .cm-md-complex-content": {
    minHeight: "0",
    padding: "0 .18em",
  },
  ".cm-md-complex-inline .cm-md-complex-status": { padding: "2px 4px" },
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
  ".cm-md-table-preview": {
    display: "inline-block",
    width: "min(100%, 760px)",
    margin: "10px auto 16px",
    overflowX: "auto",
    borderRadius: "6px",
    backgroundColor: "var(--surface, #fffaf0)",
    cursor: "pointer",
    verticalAlign: "top",
  },
  ".cm-md-hidden-preview-line": {
    display: "inline-block",
    width: "0",
    overflow: "hidden",
  },
  ".cm-md-horizontal-rule-preview": {
    display: "inline-block",
    width: "100%",
    height: "1px",
    margin: "0.85em 0",
    borderTop: "1px solid var(--border-control, #c8bbae)",
    verticalAlign: "middle",
    cursor: "pointer",
  },
  ".cm-md-horizontal-rule-preview:focus-visible": {
    height: "3px",
    outline: "2px solid var(--accent-strong, #9b5c39)",
    outlineOffset: "3px",
  },
  ".cm-md-table-preview table": {
    width: "100%",
    borderCollapse: "collapse",
    fontFamily: 'Inter, "Noto Sans SC", sans-serif',
  },
  ".cm-md-table-preview th, .cm-md-table-preview td": {
    padding: "8px 11px",
    border: "1px solid var(--border, #d5ccbe)",
    textAlign: "left",
  },
  '.cm-md-table-preview [align="center"]': { textAlign: "center" },
  '.cm-md-table-preview [align="right"]': { textAlign: "right" },
  ".cm-md-table-preview th": {
    backgroundColor: "var(--surface-soft, #f5eee3)",
    fontWeight: "700",
  },
  ".cm-md-table-preview p": { margin: "0" },
  ".cm-md-extension-preview": {
    display: "inline-block",
    maxWidth: "100%",
    color: "var(--text, #292722)",
    cursor: "pointer",
    verticalAlign: "middle",
  },
  ".cm-md-html-preview": {
    maxWidth: "100%",
    cursor: "pointer",
    color: "var(--text, #292722)",
  },
  ".cm-md-html-block": {
    display: "inline-block",
    width: "min(100%, 760px)",
    margin: "8px 0",
    verticalAlign: "top",
  },
  ".cm-md-html-block > :first-child": { marginTop: "0" },
  ".cm-md-html-block > :last-child": { marginBottom: "0" },
  ".cm-md-html-preview:focus-visible": {
    outline: "2px solid var(--accent-strong, #9b5c39)",
    outlineOffset: "3px",
  },
  ".cm-md-html-rejected": {
    fontFamily: "monospace",
    color: "var(--text-soft, #82786d)",
  },
  ".cm-md-extension-preview:focus-visible": {
    outline: "2px solid var(--accent-strong, #9b5c39)",
    outlineOffset: "3px",
  },
  ".cm-md-extension-front-matter, .cm-md-extension-alert, .cm-md-extension-footnote-definition, .cm-md-extension-toc":
    {
      width: "min(100%, 760px)",
      margin: "8px 0",
    },
  ".cm-md-extension-front-matter pre": {
    margin: "0",
    borderStyle: "dashed",
  },
  ".cm-md-extension-alert blockquote": { margin: "0" },
  ".cm-md-extension-toc nav": {
    padding: "10px 14px",
    border: "1px solid var(--border, #d5ccbe)",
    borderRadius: "6px",
  },
  ".cm-md-extension-footnote-reference": {
    color: "var(--accent, #8a4e31)",
    fontSize: ".78em",
  },
});

export function createEditorModeExtension(
  mode: EditorMode,
  complexRenderers: ComplexBlockRenderers = {},
  profile: MarkdownProfile = defaultMarkdownProfile,
  resolveImageSource?: ImageSourceResolver,
): Extension {
  if (mode === "source") return [];

  return [
    EditorView.editorAttributes.of({ class: "cm-md-hybrid" }),
    createProgressiveRenderingPlugin(
      complexRenderers,
      profile,
      resolveImageSource,
    ),
    progressiveRenderingTheme,
  ];
}
