import type { MarkedExtension, Token, Tokens } from "marked";

import { defaultMarkdownProfile, type MarkdownProfile } from "./profile.js";

export type MarkdownExtensionKind =
  | "front-matter"
  | "toc"
  | "alert"
  | "footnote-definition"
  | "footnote-reference"
  | "inline-math"
  | "block-math"
  | "mermaid";

export type MarkdownAlertKind =
  "note" | "tip" | "important" | "warning" | "caution";

export interface MarkdownExtensionRange {
  readonly kind: MarkdownExtensionKind;
  readonly from: number;
  readonly to: number;
  readonly source: string;
  readonly content?: string;
  readonly identifier?: string;
  readonly alertKind?: MarkdownAlertKind;
}

interface SourceLine {
  readonly from: number;
  readonly to: number;
  readonly end: number;
  readonly text: string;
}

interface HeadingEntry {
  readonly depth: number;
  readonly label: string;
  readonly id: string;
}

interface FootnoteDefinition {
  readonly identifier: string;
  readonly number: number;
  html?: string;
  references: number;
}

interface ProfileToken extends Tokens.Generic {
  text?: string;
  identifier?: string;
  alertKind?: MarkdownAlertKind;
}

const alertLabels: Readonly<Record<MarkdownAlertKind, string>> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let from = 0;
  while (from < source.length) {
    const newline = source.indexOf("\n", from);
    const end = newline === -1 ? source.length : newline + 1;
    let to = newline === -1 ? source.length : newline;
    if (to > from && source[to - 1] === "\r") to -= 1;
    lines.push({ from, to, end, text: source.slice(from, to) });
    from = end;
  }
  if (source.length === 0 || /(?:\r\n|\n)$/u.test(source)) {
    lines.push({
      from: source.length,
      to: source.length,
      end: source.length,
      text: "",
    });
  }
  return lines;
}

function stripInlineMarkdown(value: string): string {
  return value
    .replaceAll(/!\[(.*?)\]\([^)]*\)/gu, "$1")
    .replaceAll(/\[(.+?)\]\([^)]*\)/gu, "$1")
    .replaceAll(/[`*_~]/gu, "")
    .replaceAll(/\\([-\\`*{}[\]()#+.!_>])/gu, "$1")
    .trim();
}

export function createMarkdownHeadingSlug(value: string): string {
  const normalized = stripInlineMarkdown(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  return normalized || "section";
}

function collectHeadings(source: string): HeadingEntry[] {
  const headings: HeadingEntry[] = [];
  const counts = new Map<string, number>();
  let fence: { marker: string; length: number } | null = null;
  for (const line of sourceLines(source)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line.text);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1]?.[0] ?? "`";
      const length = fenceMatch[1]?.length ?? 3;
      if (fence === null) fence = { marker, length };
      else if (marker === fence.marker && length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line.text);
    if (match === null) continue;
    const label = stripInlineMarkdown(match[2] ?? "");
    const base = createMarkdownHeadingSlug(label);
    const duplicate = counts.get(base) ?? 0;
    counts.set(base, duplicate + 1);
    headings.push({
      depth: match[1]?.length ?? 1,
      label,
      id: `md-heading-${base}${duplicate === 0 ? "" : `-${duplicate + 1}`}`,
    });
  }
  return headings;
}

function rangeContains(
  ranges: readonly MarkdownExtensionRange[],
  from: number,
  to: number,
): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}

function footnoteKey(identifier: string): string {
  return identifier.normalize("NFKC").toLocaleLowerCase();
}

function safeFootnoteId(identifier: string): string {
  return [...footnoteKey(identifier)]
    .map((character) =>
      /[a-z0-9_-]/u.test(character)
        ? character
        : `u${character.codePointAt(0)?.toString(16) ?? "0"}`,
    )
    .join("-");
}

/**
 * Derives non-standard Markdown constructs without changing the canonical text.
 * The returned offsets always refer to the original source, including CRLF input.
 */
export function collectMarkdownExtensionRanges(
  source: string,
  profile: MarkdownProfile = defaultMarkdownProfile,
): MarkdownExtensionRange[] {
  const lines = sourceLines(source);
  const ranges: MarkdownExtensionRange[] = [];
  const fencedRanges: MarkdownExtensionRange[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const opening = /^ {0,3}(`{3,}|~{3,})[ \t]*([^ \t]*)[^\r\n]*$/u.exec(
      line.text,
    );
    if (opening === null) continue;
    const marker = opening[1]?.[0] ?? "`";
    const markerLength = opening[1]?.length ?? 3;
    let closingIndex = index + 1;
    while (closingIndex < lines.length) {
      const closing = lines[closingIndex];
      if (
        closing !== undefined &&
        new RegExp(
          `^ {0,3}${marker === "`" ? "`" : "~"}{${markerLength},}[ \\t]*$`,
          "u",
        ).test(closing.text)
      ) {
        break;
      }
      closingIndex += 1;
    }
    const finalLine = lines[Math.min(closingIndex, lines.length - 1)] ?? line;
    const to = closingIndex < lines.length ? finalLine.to : source.length;
    const contentFrom = line.end;
    const contentTo =
      closingIndex < lines.length ? finalLine.from : source.length;
    const language = (opening[2] ?? "").toLocaleLowerCase();
    const kind =
      profile.features.mermaid && language === "mermaid"
        ? "mermaid"
        : profile.features.blockMath &&
            (language === "math" || language === "katex")
          ? "block-math"
          : null;
    fencedRanges.push({
      kind: kind ?? "mermaid",
      from: line.from,
      to,
      source: source.slice(line.from, to),
      content: source.slice(contentFrom, contentTo).replace(/\r?\n$/u, ""),
    });
    if (kind !== null) ranges.push(fencedRanges.at(-1)!);
    index = closingIndex;
  }

  if (profile.features.frontMatter && lines[0]?.text === "---") {
    const closingIndex = lines.findIndex(
      (line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/u.test(line.text),
    );
    if (closingIndex > 0) {
      const closing = lines[closingIndex]!;
      ranges.push({
        kind: "front-matter",
        from: 0,
        to: closing.to,
        source: source.slice(0, closing.to),
        content: source.slice(lines[0].end, closing.from),
      });
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      line === undefined ||
      rangeContains(fencedRanges, line.from, line.to) ||
      rangeContains(ranges, line.from, line.to)
    ) {
      continue;
    }

    if (profile.features.blockMath) {
      const singleMath = /^ {0,3}\$\$[ \t]*(.+?)[ \t]*\$\$[ \t]*$/u.exec(
        line.text,
      );
      if (singleMath !== null) {
        ranges.push({
          kind: "block-math",
          from: line.from,
          to: line.to,
          source: source.slice(line.from, line.to),
          content: singleMath[1] ?? "",
        });
        continue;
      }
      if (/^ {0,3}\$\$[ \t]*$/u.test(line.text)) {
        const closingIndex = lines.findIndex(
          (candidate, candidateIndex) =>
            candidateIndex > index &&
            /^ {0,3}\$\$[ \t]*$/u.test(candidate.text),
        );
        if (closingIndex > index) {
          const closing = lines[closingIndex]!;
          ranges.push({
            kind: "block-math",
            from: line.from,
            to: closing.to,
            source: source.slice(line.from, closing.to),
            content: source
              .slice(line.end, closing.from)
              .replace(/\r?\n$/u, ""),
          });
          index = closingIndex;
          continue;
        }
      }
    }

    if (
      profile.features.tableOfContents &&
      /^ {0,3}\[toc\][ \t]*$/iu.test(line.text)
    ) {
      ranges.push({
        kind: "toc",
        from: line.from,
        to: line.to,
        source: source.slice(line.from, line.to),
      });
      continue;
    }

    if (profile.features.alerts) {
      const alert =
        /^ {0,3}>[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n)?$/iu.exec(
          line.text,
        );
      if (alert !== null) {
        let finalIndex = index;
        while (
          finalIndex + 1 < lines.length &&
          /^ {0,3}>/u.test(lines[finalIndex + 1]?.text ?? "")
        ) {
          finalIndex += 1;
        }
        const finalLine = lines[finalIndex]!;
        const alertKind = (
          alert[1] ?? "note"
        ).toLocaleLowerCase() as MarkdownAlertKind;
        const body = lines
          .slice(index + 1, finalIndex + 1)
          .map((candidate) => candidate.text.replace(/^ {0,3}>[ \t]?/u, ""))
          .join("\n");
        ranges.push({
          kind: "alert",
          alertKind,
          from: line.from,
          to: finalLine.to,
          source: source.slice(line.from, finalLine.to),
          content: body,
        });
        index = finalIndex;
        continue;
      }
    }

    if (profile.features.footnotes) {
      const definition = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/u.exec(line.text);
      if (definition !== null) {
        let finalIndex = index;
        while (
          finalIndex + 1 < lines.length &&
          /^(?: {2,}|\t)/u.test(lines[finalIndex + 1]?.text ?? "")
        ) {
          finalIndex += 1;
        }
        const finalLine = lines[finalIndex]!;
        const continuation = lines
          .slice(index + 1, finalIndex + 1)
          .map((candidate) => candidate.text.replace(/^(?: {2,4}|\t)/u, ""));
        ranges.push({
          kind: "footnote-definition",
          identifier: definition[1],
          from: line.from,
          to: finalLine.to,
          source: source.slice(line.from, finalLine.to),
          content: [definition[2] ?? "", ...continuation].join("\n"),
        });
        index = finalIndex;
      }
    }
  }

  for (const line of lines) {
    if (
      rangeContains(fencedRanges, line.from, line.to) ||
      rangeContains(ranges, line.from, line.to)
    ) {
      continue;
    }
    let codeMarkerLength = 0;
    for (let offset = 0; offset < line.text.length; offset += 1) {
      const character = line.text[offset];
      if (character === "\\") {
        offset += 1;
        continue;
      }
      if (character === "`") {
        let length = 1;
        while (line.text[offset + length] === "`") length += 1;
        codeMarkerLength = codeMarkerLength === length ? 0 : length;
        offset += length - 1;
        continue;
      }
      if (codeMarkerLength !== 0) continue;

      if (profile.features.footnotes && line.text.startsWith("[^", offset)) {
        const reference = /^\[\^([^\]\s]+)\]/u.exec(line.text.slice(offset));
        if (reference !== null) {
          const raw = reference[0];
          ranges.push({
            kind: "footnote-reference",
            identifier: reference[1],
            from: line.from + offset,
            to: line.from + offset + raw.length,
            source: raw,
          });
          offset += raw.length - 1;
          continue;
        }
      }

      if (
        profile.features.inlineMath &&
        character === "$" &&
        line.text[offset + 1] !== "$"
      ) {
        const math = /^\$(?!\$)(?!\s)((?:\\.|[^\\$])+?)(?<!\s)\$(?!\$)/u.exec(
          line.text.slice(offset),
        );
        if (math !== null) {
          ranges.push({
            kind: "inline-math",
            from: line.from + offset,
            to: line.from + offset + math[0].length,
            source: math[0],
            content: math[1] ?? "",
          });
          offset += math[0].length - 1;
        }
      }
    }
  }

  return ranges.sort(
    (left, right) => left.from - right.from || left.to - right.to,
  );
}

function tocHtml(headings: readonly HeadingEntry[]): string {
  if (headings.length === 0) {
    return '<nav class="md-toc"><p>暂无标题</p></nav>';
  }
  return `<nav class="md-toc"><ol>${headings
    .map(
      (heading) =>
        `<li class="md-toc-level-${heading.depth}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.label)}</a></li>`,
    )
    .join("")}</ol></nav>`;
}

/** Creates a fresh, render-scoped Marked extension for the selected profile. */
export function createMarkdownMarkedExtension(
  source: string,
  profile: MarkdownProfile = defaultMarkdownProfile,
): MarkedExtension {
  const extensions: NonNullable<MarkedExtension["extensions"]> = [];
  const headings = collectHeadings(source);
  const headingIds = [...headings];
  const footnotes = new Map<string, FootnoteDefinition>();
  const footnoteOrder: FootnoteDefinition[] = [];

  if (profile.features.frontMatter) {
    extensions.push({
      name: "mdFrontMatter",
      level: "block",
      tokenizer(src, tokens) {
        if (tokens.length !== 0) return undefined;
        const match =
          /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u.exec(
            src,
          );
        if (match === null) return undefined;
        return { type: "mdFrontMatter", raw: match[0], text: match[1] ?? "" };
      },
      renderer(token) {
        const profileToken = token as ProfileToken;
        return `<pre class="md-front-matter"><code class="language-yaml">${escapeHtml(profileToken.text ?? "")}</code></pre>`;
      },
    });
  }

  if (profile.features.tableOfContents) {
    extensions.push({
      name: "mdTableOfContents",
      level: "block",
      start(src) {
        const match = /\n {0,3}\[toc\][ \t]*(?:\r?\n|$)/iu.exec(src);
        return match?.index === undefined ? undefined : match.index + 1;
      },
      tokenizer(src) {
        const match = /^ {0,3}\[toc\][ \t]*(?:\r?\n|$)/iu.exec(src);
        return match === null
          ? undefined
          : { type: "mdTableOfContents", raw: match[0] };
      },
      renderer() {
        return tocHtml(headings);
      },
    });
  }

  if (profile.features.alerts) {
    extensions.push({
      name: "mdAlert",
      level: "block",
      start(src) {
        const match =
          /\n {0,3}>[ \t]*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/iu.exec(
            src,
          );
        return match?.index === undefined ? undefined : match.index + 1;
      },
      tokenizer(src) {
        const match =
          /^( {0,3}>[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$))((?: {0,3}>[^\r\n]*(?:\r?\n|$))*)/iu.exec(
            src,
          );
        if (match === null) return undefined;
        const text = (match[3] ?? "")
          .split(/\r?\n/u)
          .map((line) => line.replace(/^ {0,3}>[ \t]?/u, ""))
          .join("\n")
          .replace(/\n$/u, "");
        const tokens: Token[] = [];
        this.lexer.blockTokens(text, tokens);
        return {
          type: "mdAlert",
          raw: match[0],
          alertKind: (match[2] ?? "note").toLocaleLowerCase(),
          tokens,
        };
      },
      renderer(token) {
        const profileToken = token as ProfileToken;
        const kind = profileToken.alertKind ?? "note";
        return `<blockquote class="md-alert md-alert-${kind}"><p class="md-alert-title">${alertLabels[kind]}</p>${this.parser.parse(profileToken.tokens ?? [])}</blockquote>`;
      },
      childTokens: ["tokens"],
    });
  }

  if (profile.features.footnotes) {
    extensions.push(
      {
        name: "mdFootnoteDefinition",
        level: "block",
        start(src) {
          const match = /\n {0,3}\[\^[^\]\s]+\]:/u.exec(src);
          return match?.index === undefined ? undefined : match.index + 1;
        },
        tokenizer(src) {
          const match =
            /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*([^\r\n]*(?:\r?\n(?:(?: {2,4}|\t)[^\r\n]*|[ \t]*$))*)?(?:\r?\n|$)/u.exec(
              src,
            );
          if (match === null) return undefined;
          const identifier = match[1] ?? "";
          const text = (match[2] ?? "")
            .split(/\r?\n/u)
            .map((line, index) =>
              index === 0 ? line : line.replace(/^(?: {2,4}|\t)/u, ""),
            )
            .join("\n");
          const tokens: Token[] = [];
          this.lexer.blockTokens(text, tokens);
          const key = footnoteKey(identifier);
          if (!footnotes.has(key)) {
            const definition: FootnoteDefinition = {
              identifier,
              number: footnoteOrder.length + 1,
              references: 0,
            };
            footnotes.set(key, definition);
            footnoteOrder.push(definition);
          }
          return {
            type: "mdFootnoteDefinition",
            raw: match[0],
            identifier,
            tokens,
          };
        },
        renderer(token) {
          const profileToken = token as ProfileToken;
          const definition = footnotes.get(
            footnoteKey(profileToken.identifier ?? ""),
          );
          if (definition !== undefined && definition.html === undefined) {
            definition.html = this.parser.parse(profileToken.tokens ?? []);
          }
          return "";
        },
        childTokens: ["tokens"],
      },
      {
        name: "mdFootnoteReference",
        level: "inline",
        start(src) {
          const index = src.indexOf("[^");
          return index < 0 ? undefined : index;
        },
        tokenizer(src) {
          const match = /^\[\^([^\]\s]+)\]/u.exec(src);
          return match === null
            ? undefined
            : {
                type: "mdFootnoteReference",
                raw: match[0],
                identifier: match[1] ?? "",
              };
        },
        renderer(token) {
          const profileToken = token as ProfileToken;
          const identifier = profileToken.identifier ?? "";
          const definition = footnotes.get(footnoteKey(identifier));
          if (definition === undefined) return escapeHtml(profileToken.raw);
          definition.references += 1;
          const suffix =
            definition.references === 1 ? "" : `-${definition.references}`;
          const id = safeFootnoteId(definition.identifier);
          return `<sup class="md-footnote-ref" id="md-footnote-ref-${id}${suffix}"><a href="#md-footnote-${id}">${definition.number}</a></sup>`;
        },
      },
    );
  }

  if (profile.features.blockMath) {
    extensions.push({
      name: "mdBlockMath",
      level: "block",
      start(src) {
        const match = /\n {0,3}\$\$/u.exec(src);
        return match?.index === undefined ? undefined : match.index + 1;
      },
      tokenizer(src) {
        const multiline =
          /^ {0,3}\$\$[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}\$\$[ \t]*(?:\r?\n|$)/u.exec(
            src,
          );
        const single =
          /^ {0,3}\$\$[ \t]*(.+?)[ \t]*\$\$[ \t]*(?:\r?\n|$)/u.exec(src);
        const match = multiline ?? single;
        return match === null
          ? undefined
          : { type: "mdBlockMath", raw: match[0], text: match[1] ?? "" };
      },
      renderer(token) {
        const profileToken = token as ProfileToken;
        return `<div class="md-math md-math-block"><code>${escapeHtml(profileToken.text ?? "")}</code></div>`;
      },
    });
  }

  if (profile.features.inlineMath) {
    extensions.push({
      name: "mdInlineMath",
      level: "inline",
      start(src) {
        const index = src.indexOf("$");
        return index < 0 ? undefined : index;
      },
      tokenizer(src) {
        const match =
          /^\$(?!\$)(?!\s)((?:\\.|[^\\$\r\n])+?)(?<!\s)\$(?!\$)/u.exec(src);
        return match === null
          ? undefined
          : { type: "mdInlineMath", raw: match[0], text: match[1] ?? "" };
      },
      renderer(token) {
        const profileToken = token as ProfileToken;
        return `<span class="md-math md-math-inline"><code>${escapeHtml(profileToken.text ?? "")}</code></span>`;
      },
    });
  }

  return {
    extensions,
    renderer: {
      heading(token: Tokens.Heading) {
        const rendered = this.parser.parseInline(token.tokens);
        const expected = headingIds.shift();
        const id =
          expected?.id ?? `md-heading-${createMarkdownHeadingSlug(token.text)}`;
        return `<h${token.depth} id="${escapeHtml(id)}">${rendered}</h${token.depth}>`;
      },
      code(token: Tokens.Code) {
        const language = token.lang
          ?.trim()
          .split(/\s+/u)[0]
          ?.toLocaleLowerCase();
        if (profile.features.mermaid && language === "mermaid") {
          return `<pre class="md-diagram md-diagram-mermaid"><code class="language-mermaid">${escapeHtml(token.text)}</code></pre>`;
        }
        if (
          profile.features.blockMath &&
          (language === "math" || language === "katex")
        ) {
          return `<div class="md-math md-math-block"><code>${escapeHtml(token.text)}</code></div>`;
        }
        return false;
      },
    },
    hooks: {
      postprocess(html) {
        if (!profile.features.footnotes || footnoteOrder.length === 0) {
          return html;
        }
        const items = footnoteOrder
          .filter((definition) => definition.references > 0)
          .map((definition) => {
            const id = safeFootnoteId(definition.identifier);
            const backlinks = Array.from(
              { length: definition.references },
              (_, index) => {
                const suffix = index === 0 ? "" : `-${index + 1}`;
                return `<a class="md-footnote-backref" href="#md-footnote-ref-${id}${suffix}" title="返回正文">↩</a>`;
              },
            ).join(" ");
            return `<li id="md-footnote-${id}">${definition.html ?? ""}${backlinks}</li>`;
          })
          .join("");
        return items === ""
          ? html
          : `${html}<section class="md-footnotes"><hr><ol>${items}</ol></section>`;
      },
    },
  };
}
