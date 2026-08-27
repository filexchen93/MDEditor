import createDOMPurify from "dompurify";
import { Marked } from "marked";

export type ExportTheme = "paper" | "dark";

export interface StandaloneHtmlOptions {
  readonly source: string;
  readonly title: string;
  readonly theme: ExportTheme;
}

const allowedTags = [
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "details",
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
  "s",
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
] as const;

const allowedAttributes = [
  "alt",
  "checked",
  "class",
  "disabled",
  "href",
  "rel",
  "src",
  "target",
  "title",
  "type",
] as const;

const exportStyles = `
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
code, pre { font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace; }
code { padding: .12em .3em; border-radius: 4px; background: #eee5d9; }
pre { overflow: auto; padding: 1em; border: 1px solid #d9d2c5; border-radius: 6px; background: #f7efe4; }
pre code { padding: 0; background: transparent; }
body[data-theme="dark"] code { background: #38312c; }
body[data-theme="dark"] pre { border-color: #514a43; background: #211f1d; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: .5em .7em; border: 1px solid #d9d2c5; text-align: left; }
body[data-theme="dark"] th, body[data-theme="dark"] td { border-color: #514a43; }
img { max-width: 100%; height: auto; }
input[type="checkbox"] { margin-right: .45em; }
@media print {
  :root { color-scheme: light; }
  html, body, body[data-theme="dark"] { color: #111; background: #fff; }
  body { max-width: none; margin: 0; padding: 0; }
  a, body[data-theme="dark"] a { color: inherit; text-decoration: underline; }
  pre, code, body[data-theme="dark"] pre, body[data-theme="dark"] code { color: #111; background: #f5f5f5; }
  h1, h2, h3, h4, h5, h6, img, pre, blockquote, table { break-inside: avoid; }
}
`;

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

  return template.innerHTML;
}

export function renderMarkdownToSafeHtml(
  source: string,
  browserWindow: Window & typeof globalThis = window,
): string {
  const parser = new Marked({
    async: false,
    breaks: false,
    gfm: true,
    pedantic: false,
  });
  const rendered = parser.parse(source);
  if (typeof rendered !== "string") {
    throw new Error("Markdown 导出渲染器返回了无效结果");
  }
  return sanitizeRenderedMarkdown(rendered, browserWindow);
}

export function createStandaloneHtml({
  source,
  title,
  theme,
}: StandaloneHtmlOptions): string {
  const body = renderMarkdownToSafeHtml(source);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https: http:; font-src 'self' data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(title)}</title>
  <style>${exportStyles}</style>
</head>
<body data-theme="${theme}">
${body}
</body>
</html>
`;
}

export function createHtmlExportName(documentName: string): string {
  const base = documentName
    .replace(/\.(?:md|markdown|mdown|mkd)$/iu, "")
    .trim();
  return `${base || "未命名"}.html`;
}
