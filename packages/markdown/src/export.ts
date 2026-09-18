import createDOMPurify from "dompurify";
import { Marked } from "marked";

import { createMarkdownMarkedExtension } from "./extensions.js";
import { compileDocumentCss } from "./document-css.js";
import { defaultMarkdownProfile, type MarkdownProfile } from "./profile.js";

export type ExportTheme = "paper" | "dark";
export type HtmlExportStyle = "styled" | "unstyled";
export type PrintPageSize = "A4" | "Letter";
export type PrintOrientation = "portrait" | "landscape";
export type PrintMargin = "normal" | "narrow" | "wide";

export interface PrintLayoutOptions {
  readonly pageSize: PrintPageSize;
  readonly orientation: PrintOrientation;
  readonly margin: PrintMargin;
  readonly pageBreakBetweenTopLevelHeadings: boolean;
  readonly headerTemplate: string;
  readonly footerTemplate: string;
}

export interface StandaloneHtmlOptions {
  readonly source: string;
  readonly title: string;
  readonly theme: ExportTheme;
  readonly style?: HtmlExportStyle;
  readonly printLayout?: PrintLayoutOptions;
  readonly profile?: MarkdownProfile;
  readonly documentThemeCss?: string;
  readonly trustedDocumentCss?: string;
}

export interface SafeHtmlDocumentOptions {
  readonly body: string;
  readonly title: string;
  readonly theme: ExportTheme;
  readonly style?: HtmlExportStyle;
  readonly printLayout?: PrintLayoutOptions;
  readonly documentThemeCss?: string;
  readonly trustedDocumentCss?: string;
}

export type SafeHtmlImageResolver = (source: string) => Promise<string | null>;
export type SafeHtmlMermaidResolver = (source: string) => Promise<string>;
export type SafeHtmlMathResolver = (
  source: string,
  displayMode: boolean,
) => Promise<string>;

const maximumResolvedImageCount = 512;
const maximumResolvedImageCharacters = 128 * 1024 * 1024;
const maximumResolvedMermaidCount = 64;
const maximumResolvedMermaidCharacters = 64 * 1024 * 1024;
const maximumResolvedMathCount = 512;
const maximumResolvedMathCharacters = 32 * 1024 * 1024;
const mathMlNamespace = "http://www.w3.org/1998/Math/MathML";

const allowedTags = [
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
  "img",
  "input",
  "kbd",
  "li",
  "ol",
  "p",
  "pre",
  "nav",
  "s",
  "strike",
  "strong",
  "sub",
  "section",
  "span",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
] as const;

const allowedAttributes = [
  "align",
  "alt",
  "checked",
  "class",
  "disabled",
  "href",
  "id",
  "rel",
  "src",
  "target",
  "title",
  "type",
] as const;

const defaultPrintLayout: PrintLayoutOptions = {
  pageSize: "A4",
  orientation: "portrait",
  margin: "normal",
  pageBreakBetweenTopLevelHeadings: false,
  headerTemplate: "",
  footerTemplate: "",
};

const printMargins: Readonly<Record<PrintMargin, string>> = {
  narrow: "10mm",
  normal: "20mm",
  wide: "30mm",
};

function escapeCssString(value: string): string {
  return [...value]
    .map((character) => {
      if (character === "\\") return "\\\\";
      if (character === '"') return '\\"';
      if (character === "<") return "\\3c ";
      if (character === ">") return "\\3e ";
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint <= 0x1f || codePoint === 0x7f) return " ";
      return character;
    })
    .join("");
}

function createPrintContent(template: string, title: string): string {
  const content: string[] = [];
  const tokenPattern = /\$\{(title|pageNo|pageCount|totalPages)\}/gu;
  let cursor = 0;

  for (const match of template.matchAll(tokenPattern)) {
    const index = match.index ?? cursor;
    const literal = template.slice(cursor, index);
    if (literal !== "") content.push(`"${escapeCssString(literal)}"`);
    const token = match[1];
    if (token === "title") {
      content.push(`"${escapeCssString(title)}"`);
    } else if (token === "pageNo") {
      content.push("counter(page)");
    } else {
      content.push("counter(pages)");
    }
    cursor = index + match[0].length;
  }

  const remainder = template.slice(cursor);
  if (remainder !== "") content.push(`"${escapeCssString(remainder)}"`);
  return content.join(" ") || '""';
}

function createPrintMarginBox(
  position: "top-center" | "bottom-center",
  template: string,
  title: string,
): string {
  if (template === "") return "";
  return `
  @${position} {
    content: ${createPrintContent(template, title)};
    color: #555;
    font: 9pt/1.2 Inter, "Noto Sans SC", "Microsoft YaHei UI", system-ui, sans-serif;
  }`;
}

function createExportStyles(
  printLayout: PrintLayoutOptions,
  title: string,
): string {
  const automaticPageBreakRule = printLayout.pageBreakBetweenTopLevelHeadings
    ? `
  body > h1 ~ h1, body > .md-footnotes { break-before: page; page-break-before: always; }`
    : "";
  const headerRule = createPrintMarginBox(
    "top-center",
    printLayout.headerTemplate,
    title,
  );
  const footerRule = createPrintMarginBox(
    "bottom-center",
    printLayout.footerTemplate,
    title,
  );
  const pageRule =
    headerRule === "" && footerRule === ""
      ? `@page { size: ${printLayout.pageSize} ${printLayout.orientation}; margin: ${printMargins[printLayout.margin]}; }`
      : `@page {
  size: ${printLayout.pageSize} ${printLayout.orientation};
  margin: ${printMargins[printLayout.margin]};${headerRule}${footerRule}
}`;
  return `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html { background: #f4f0e7; }
body {
  max-width: 860px;
  margin: 0 auto;
  padding: 56px 48px 96px;
  color: #292722;
  background: #fffaf0;
  font: 16px/1.72 Inter, "Noto Sans SC", "Microsoft YaHei UI", system-ui, sans-serif;
  overflow-wrap: anywhere;
}
body[data-theme="dark"] { color: #e4ddd3; background: #292724; }
h1, h2, h3, h4, h5, h6 { margin: 1.6em 0 .6em; line-height: 1.25; }
h1, h2 { padding-bottom: .28em; border-bottom: 1px solid #d9d2c5; }
a { color: #825034; }
body[data-theme="dark"] a { color: #e0a47d; }
blockquote { margin-inline: 0; padding: .1em 1em; color: #6d675d; border-left: 4px solid #c5aa91; }
body[data-theme="dark"] blockquote { color: #b8aea2; }
.md-alert-title { margin: 0 0 .35em; font-weight: 700; }
.md-alert-note { border-left-color: #3b82f6; }
.md-alert-tip { border-left-color: #16a34a; }
.md-alert-important { border-left-color: #8b5cf6; }
.md-alert-warning { border-left-color: #d97706; }
.md-alert-caution { border-left-color: #dc2626; }
.md-front-matter { border-style: dashed; }
.md-toc { margin: 1.25em 0; padding: .8em 1em; border: 1px solid #d9d2c5; border-radius: 6px; }
.md-toc ol { margin: 0; padding-left: 1.4em; }
.md-toc-level-2 { margin-left: 1em; }
.md-toc-level-3, .md-toc-level-4, .md-toc-level-5, .md-toc-level-6 { margin-left: 2em; }
.md-math { overflow-x: auto; }
.md-math-inline { display: inline; }
.md-math-inline code { background: transparent; }
.md-math-block { margin: 1em 0; padding: .8em 1em; text-align: center; }
.md-diagram-mermaid { margin: 1.25em 0; overflow-x: auto; text-align: center; }
.md-diagram-mermaid img { display: inline-block; max-width: 100%; height: auto; }
.md-footnotes { margin-top: 2.5em; font-size: .92em; }
.md-footnote-ref { line-height: 0; }
.md-footnote-backref { margin-left: .4em; }
code, pre { font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace; }
code { padding: .12em .3em; border-radius: 4px; background: #eee5d9; }
pre { overflow: auto; padding: 1em; border: 1px solid #d9d2c5; border-radius: 6px; background: #f7efe4; }
pre code { padding: 0; background: transparent; }
body[data-theme="dark"] code { background: #38312c; }
body[data-theme="dark"] pre { border-color: #514a43; background: #211f1d; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: .5em .7em; border: 1px solid #d9d2c5; text-align: left; }
th[align="center"], td[align="center"] { text-align: center; }
th[align="right"], td[align="right"] { text-align: right; }
body[data-theme="dark"] th, body[data-theme="dark"] td { border-color: #514a43; }
img { max-width: 100%; height: auto; }
input[type="checkbox"] { margin-right: .45em; }
.page-break { display: none; }
${pageRule}
@media print {
  :root { color-scheme: light; }
  html, body, body[data-theme="dark"] { color: #111; background: #fff; }
  body { max-width: none; margin: 0; padding: 0; }
  a, body[data-theme="dark"] a { color: inherit; text-decoration: underline; }
  pre, code, body[data-theme="dark"] pre, body[data-theme="dark"] code { color: #111; background: #f5f5f5; }
  h1, h2, h3, h4, h5, h6, img, pre, blockquote, table { break-inside: avoid; }
  .page-break { display: block; break-after: page; page-break-after: always; }${automaticPageBreakRule}
}
`;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function sanitizeLink(value: string): string | null {
  const candidate = value.trim();
  if (candidate === "" || hasControlCharacters(candidate)) return null;
  const protocol = /^([a-z][a-z0-9+.-]*):/iu.exec(candidate)?.[1];
  return protocol === undefined ||
    ["http", "https", "mailto"].includes(protocol)
    ? candidate
    : null;
}

function sanitizeImage(value: string): string | null {
  const candidate = value.trim();
  if (candidate === "" || hasControlCharacters(candidate)) return null;
  if (/^data:/iu.test(candidate)) {
    return /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/]+=*$/iu.test(
      candidate,
    )
      ? candidate
      : null;
  }
  const protocol = /^([a-z][a-z0-9+.-]*):/iu.exec(candidate)?.[1];
  return protocol === undefined || protocol === "http" || protocol === "https"
    ? candidate
    : null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function sanitizeRenderedMarkdown(
  dirtyHtml: string,
  browserWindow: Window & typeof globalThis = window,
): string {
  const purifier = createDOMPurify(browserWindow);
  const clean = purifier.sanitize(dirtyHtml, {
    ALLOWED_ATTR: [...allowedAttributes],
    ALLOWED_TAGS: [...allowedTags],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: ["style", "srcset"],
    SANITIZE_NAMED_PROPS: true,
  });
  const template = browserWindow.document.createElement("template");
  template.innerHTML = clean;

  template.content
    .querySelectorAll<HTMLAnchorElement>("a[href]")
    .forEach((link) => {
      const href = sanitizeLink(link.getAttribute("href") ?? "");
      if (href === null) {
        link.removeAttribute("href");
        link.removeAttribute("target");
        link.removeAttribute("rel");
        return;
      }
      if (href.startsWith("#")) {
        const fragment = href.slice(1);
        const target = [
          ...template.content.querySelectorAll<HTMLElement>("[id]"),
        ].find(
          (element) =>
            element.id === fragment ||
            element.id === `user-content-${fragment}`,
        );
        link.setAttribute("href", `#${target?.id ?? fragment}`);
        link.removeAttribute("target");
        link.removeAttribute("rel");
        return;
      }
      link.setAttribute("href", href);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    });

  template.content
    .querySelectorAll<HTMLImageElement>("img[src]")
    .forEach((image) => {
      const source = sanitizeImage(image.getAttribute("src") ?? "");
      if (source === null) image.removeAttribute("src");
      else image.setAttribute("src", source);
    });

  template.content
    .querySelectorAll<HTMLInputElement>("input")
    .forEach((input) => {
      if (input.type !== "checkbox") {
        input.remove();
        return;
      }
      input.disabled = true;
    });

  template.content
    .querySelectorAll<HTMLTableCellElement>("th[align], td[align]")
    .forEach((cell) => {
      const alignment = cell.getAttribute("align")?.toLocaleLowerCase();
      if (
        alignment === "left" ||
        alignment === "center" ||
        alignment === "right"
      ) {
        cell.setAttribute("align", alignment);
      } else {
        cell.removeAttribute("align");
      }
    });

  return template.innerHTML;
}

export function renderMarkdownToSafeHtml(
  source: string,
  browserWindow: Window & typeof globalThis = window,
  profile: MarkdownProfile = defaultMarkdownProfile,
): string {
  const parser = new Marked({
    async: false,
    breaks: false,
    gfm: true,
    pedantic: false,
  });
  parser.use(createMarkdownMarkedExtension(source, profile));
  const rendered = parser.parse(source);
  if (typeof rendered !== "string") {
    throw new Error("Markdown 导出渲染器返回了无效结果");
  }
  return sanitizeRenderedMarkdown(rendered, browserWindow);
}

export async function resolveSafeHtmlImageSources(
  safeHtml: string,
  resolveSource: SafeHtmlImageResolver,
  browserWindow: Window & typeof globalThis = window,
): Promise<string> {
  const template = browserWindow.document.createElement("template");
  template.innerHTML = safeHtml;
  const images = [
    ...template.content.querySelectorAll<HTMLImageElement>("img[src]"),
  ];

  const resolvedBySource = new Map<string, Promise<string | null>>();
  let resolvedImageCount = 0;
  let resolvedCharacters = 0;
  for (const image of images) {
    const source = image.getAttribute("src") ?? "";
    let pending = resolvedBySource.get(source);
    if (pending === undefined) {
      pending = resolveSource(source);
      resolvedBySource.set(source, pending);
    }
    const resolved = await pending;
    if (resolved === null) continue;
    resolvedImageCount += 1;
    if (resolvedImageCount > maximumResolvedImageCount) {
      throw new Error(`导出内嵌图片超过 ${maximumResolvedImageCount} 张限制`);
    }
    const safeResolved = sanitizeImage(resolved);
    if (safeResolved === null) {
      throw new Error("导出图片解析器返回了不安全地址");
    }
    resolvedCharacters += safeResolved.length;
    if (resolvedCharacters > maximumResolvedImageCharacters) {
      throw new Error("导出图片内嵌数据超过 128 MiB 限制");
    }
    image.setAttribute("src", safeResolved);
  }
  return template.innerHTML;
}

export async function resolveSafeHtmlMermaidDiagrams(
  safeHtml: string,
  resolveDiagram: SafeHtmlMermaidResolver,
  browserWindow: Window & typeof globalThis = window,
): Promise<string> {
  const template = browserWindow.document.createElement("template");
  template.innerHTML = safeHtml;
  const diagrams = [
    ...template.content.querySelectorAll<HTMLElement>(
      "pre.md-diagram-mermaid > code.language-mermaid",
    ),
  ];
  if (diagrams.length > maximumResolvedMermaidCount) {
    throw new Error(`Mermaid 图表超过 ${maximumResolvedMermaidCount} 个限制`);
  }

  let resolvedCharacters = 0;
  for (const code of diagrams) {
    const dataUrl = await resolveDiagram(code.textContent ?? "");
    if (!/^data:image\/svg\+xml;base64,[a-z0-9+/]+=*$/iu.test(dataUrl)) {
      throw new Error("Mermaid 导出渲染器返回了不安全图片地址");
    }
    resolvedCharacters += dataUrl.length;
    if (resolvedCharacters > maximumResolvedMermaidCharacters) {
      throw new Error("Mermaid 导出数据超过 64 MiB 限制");
    }
    const image = browserWindow.document.createElement("img");
    image.className = "md-diagram-image";
    image.alt = "Mermaid 图表";
    image.src = dataUrl;
    const container = browserWindow.document.createElement("div");
    container.className = "md-diagram md-diagram-mermaid";
    container.append(image);
    code.parentElement?.replaceWith(container);
  }
  return template.innerHTML;
}

function parseSafeMathMarkup(
  markup: string,
  browserWindow: Window & typeof globalThis,
): HTMLElement {
  const fragment = browserWindow.document.createElement("template");
  fragment.innerHTML = markup;
  const root = fragment.content.firstElementChild;
  if (
    fragment.content.childElementCount !== 1 ||
    !(root instanceof browserWindow.HTMLElement) ||
    root.localName !== "span" ||
    root.getAttribute("class") !== "katex" ||
    root.attributes.length !== 1
  ) {
    throw new Error("KaTeX 导出渲染器返回了无效根节点");
  }
  const math = root.firstElementChild;
  if (
    root.childElementCount !== 1 ||
    math?.namespaceURI !== mathMlNamespace ||
    math.localName !== "math"
  ) {
    throw new Error("KaTeX 导出渲染器未返回 MathML");
  }

  for (const element of [math, ...math.querySelectorAll("*")]) {
    if (
      element.namespaceURI !== mathMlNamespace ||
      element.localName === "annotation-xml" ||
      element.localName === "mglyph"
    ) {
      throw new Error("KaTeX 导出 MathML 包含不安全节点");
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLocaleLowerCase();
      if (
        name.startsWith("on") ||
        ["href", "xlink:href", "src", "style"].includes(name)
      ) {
        throw new Error("KaTeX 导出 MathML 包含不安全属性");
      }
    }
  }
  return root;
}

export async function resolveSafeHtmlMathExpressions(
  safeHtml: string,
  resolveMath: SafeHtmlMathResolver,
  browserWindow: Window & typeof globalThis = window,
): Promise<string> {
  const template = browserWindow.document.createElement("template");
  template.innerHTML = safeHtml;
  const expressions = [
    ...template.content.querySelectorAll<HTMLElement>(".md-math > code"),
  ];
  if (expressions.length > maximumResolvedMathCount) {
    throw new Error(`数学公式超过 ${maximumResolvedMathCount} 个限制`);
  }

  let resolvedCharacters = 0;
  for (const code of expressions) {
    const displayMode =
      code.parentElement?.classList.contains("md-math-block") ?? false;
    const markup = await resolveMath(code.textContent ?? "", displayMode);
    resolvedCharacters += markup.length;
    if (resolvedCharacters > maximumResolvedMathCharacters) {
      throw new Error("KaTeX 导出数据超过 32 MiB 限制");
    }
    code.replaceWith(parseSafeMathMarkup(markup, browserWindow));
  }
  return template.innerHTML;
}

export function createSafeHtmlDocument({
  body,
  documentThemeCss,
  printLayout = defaultPrintLayout,
  title,
  theme,
  style = "styled",
  trustedDocumentCss,
}: SafeHtmlDocumentOptions): string {
  const styled = style === "styled";
  const stylePolicy = styled ? "'unsafe-inline'" : "'none'";
  const customStyles = styled
    ? [
        documentThemeCss === undefined
          ? ""
          : compileDocumentCss(documentThemeCss, "export", "theme"),
        trustedDocumentCss === undefined
          ? ""
          : compileDocumentCss(trustedDocumentCss, "export", "trusted"),
      ]
        .filter((css) => css !== "")
        .join("\n")
    : "";
  const styleElement = styled
    ? `\n  <style>${createExportStyles(printLayout, title)}${customStyles === "" ? "" : `\n${customStyles}`}</style>`
    : "";
  const themeAttribute = styled ? ` data-theme="${theme}"` : "";
  const documentStyleAttribute =
    styled && customStyles !== "" ? ' data-md-document-style="true"' : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${stylePolicy}; img-src 'self' data: https: http:; font-src 'self' data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(title)}</title>${styleElement}
</head>
<body${themeAttribute}${documentStyleAttribute}>
${body}
</body>
</html>
`;
}

export function createStandaloneHtml({
  documentThemeCss,
  printLayout = defaultPrintLayout,
  source,
  title,
  theme,
  style = "styled",
  trustedDocumentCss,
  profile = defaultMarkdownProfile,
}: StandaloneHtmlOptions): string {
  return createSafeHtmlDocument({
    body: renderMarkdownToSafeHtml(source, window, profile),
    documentThemeCss,
    printLayout,
    style,
    theme,
    title,
    trustedDocumentCss,
  });
}

export function createHtmlExportName(
  documentName: string,
  style: HtmlExportStyle = "styled",
): string {
  const base = documentName
    .replace(/\.(?:md|markdown|mdown|mkd)$/iu, "")
    .trim();
  return `${base || "未命名"}${style === "unstyled" ? ".unstyled" : ""}.html`;
}

export function createImageExportName(documentName: string): string {
  const base = documentName
    .replace(/\.(?:md|markdown|mdown|mkd)$/iu, "")
    .trim();
  return `${base || "未命名"}.png`;
}

export function createDocxExportName(documentName: string): string {
  const base = documentName
    .replace(/\.(?:md|markdown|mdown|mkd)$/iu, "")
    .trim();
  return `${base || "未命名"}.docx`;
}
