import {
  generate,
  parse,
  walk,
  type Atrule,
  type CssNode,
  type Declaration,
  type Rule,
  type Selector,
  type WalkOptions,
} from "css-tree";

export type DocumentCssKind = "theme" | "trusted";
export type DocumentCssSurface = "editor" | "export";

const maximumThemeCharacters = 128 * 1024;
const maximumTrustedCharacters = 256 * 1024;
const maximumThemeRules = 512;
const maximumTrustedRules = 2_048;
const maximumSelectorCharacters = 512;

const themeProperties = new Set([
  "accent-color",
  "background",
  "background-color",
  "background-image",
  "background-position",
  "background-repeat",
  "background-size",
  "border",
  "border-block",
  "border-block-color",
  "border-block-end",
  "border-block-start",
  "border-bottom",
  "border-color",
  "border-inline",
  "border-inline-color",
  "border-inline-end",
  "border-inline-start",
  "border-left",
  "border-radius",
  "border-right",
  "border-style",
  "border-top",
  "border-width",
  "box-shadow",
  "color",
  "column-gap",
  "font",
  "font-family",
  "font-feature-settings",
  "font-kerning",
  "font-size",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-variation-settings",
  "font-weight",
  "gap",
  "hyphens",
  "letter-spacing",
  "line-height",
  "list-style",
  "list-style-position",
  "list-style-type",
  "margin",
  "margin-block",
  "margin-block-end",
  "margin-block-start",
  "margin-bottom",
  "margin-inline",
  "margin-inline-end",
  "margin-inline-start",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-width",
  "min-width",
  "opacity",
  "outline",
  "outline-color",
  "outline-offset",
  "outline-style",
  "outline-width",
  "overflow-wrap",
  "padding",
  "padding-block",
  "padding-block-end",
  "padding-block-start",
  "padding-bottom",
  "padding-inline",
  "padding-inline-end",
  "padding-inline-start",
  "padding-left",
  "padding-right",
  "padding-top",
  "tab-size",
  "text-align",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-style",
  "text-decoration-thickness",
  "text-emphasis",
  "text-indent",
  "text-shadow",
  "text-transform",
  "text-underline-offset",
  "white-space",
  "width",
  "word-break",
  "word-spacing",
]);

const allowedContainerAtRules = new Set([
  "container",
  "layer",
  "media",
  "supports",
]);

function documentScope(surface: DocumentCssSurface): string {
  return surface === "editor"
    ? '.editor-host[data-md-document-style="true"]'
    : 'body[data-md-document-style="true"]';
}

function rejectUnsafeSource(source: string, kind: DocumentCssKind): void {
  const limit =
    kind === "theme" ? maximumThemeCharacters : maximumTrustedCharacters;
  if (source.length === 0) throw new Error("CSS 文件为空");
  if (source.length > limit) {
    throw new Error(`CSS 超过 ${kind === "theme" ? "128" : "256"} KiB 限制`);
  }
  if (source.includes("<")) {
    throw new Error("CSS 不能包含 HTML 起始字符");
  }
  if (
    [...source].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        (codePoint <= 0x08 ||
          (codePoint >= 0x0b && codePoint <= 0x0c) ||
          (codePoint >= 0x0e && codePoint <= 0x1f) ||
          codePoint === 0x7f) &&
        character !== "\t"
      );
    })
  ) {
    throw new Error("CSS 包含控制字符");
  }
}

function scopeSelector(selector: Selector, scope: string): Selector {
  const source = generate(selector);
  if (source === "" || source.length > maximumSelectorCharacters) {
    throw new Error("CSS 选择器为空或过长");
  }
  if (/\\|&|:host\b|::part\b|::slotted\b/iu.test(source)) {
    throw new Error("CSS 选择器不能使用嵌套或组件越界语法");
  }

  const selectorNodes = selector.children.toArray();
  let remainder = source;
  let replacedDocumentRoot = false;
  let nextIndex = 0;
  while (nextIndex < selectorNodes.length) {
    const node = selectorNodes[nextIndex];
    if (
      node?.type !== "TypeSelector" &&
      (node?.type !== "PseudoClassSelector" || node.name !== "root")
    ) {
      break;
    }
    if (
      node.type === "TypeSelector" &&
      !["html", "body"].includes(node.name.toLocaleLowerCase("en-US"))
    ) {
      break;
    }
    replacedDocumentRoot = true;
    nextIndex += 1;
    if (selectorNodes[nextIndex]?.type !== "Combinator") break;
    nextIndex += 1;
  }
  if (replacedDocumentRoot) {
    remainder = selectorNodes
      .slice(nextIndex)
      .map((node) => generate(node))
      .join("");
  }
  const scoped = replacedDocumentRoot
    ? remainder === "" || /^[.#[:]/u.test(remainder)
      ? `${scope}${remainder}`
      : `${scope} ${remainder}`
    : `${scope} ${source}`;
  const parsed = parse(scoped, {
    context: "selector",
    onParseError: () => {
      throw new Error("CSS 选择器无效");
    },
  });
  if (parsed.type !== "Selector") {
    throw new Error("CSS 选择器无效");
  }
  return parsed;
}

function validateAtRule(atRule: Atrule): void {
  const name = atRule.name.toLocaleLowerCase("en-US");
  if (!allowedContainerAtRules.has(name) || atRule.block === null) {
    throw new Error(`不允许使用 @${atRule.name}`);
  }
  if (
    atRule.prelude !== null &&
    /url\s*\(|(?:https?|file|data):|\/\//iu.test(generate(atRule.prelude))
  ) {
    throw new Error(`@${atRule.name} 包含外部资源`);
  }
}

function validateDeclaration(
  declaration: Declaration,
  kind: DocumentCssKind,
): void {
  const property = declaration.property.toLocaleLowerCase("en-US");
  const value = generate(declaration.value);
  if (
    property === "behavior" ||
    property === "-moz-binding" ||
    /(?:^|-)src$/u.test(property)
  ) {
    throw new Error(`不允许使用 CSS 属性 ${declaration.property}`);
  }
  if (
    /url\s*\(|image-set\s*\(|cross-fade\s*\(|element\s*\(|expression\s*\(|(?:https?|file|data|javascript):|\/\//iu.test(
      value,
    )
  ) {
    throw new Error(`CSS 属性 ${declaration.property} 包含外部或活动资源`);
  }
  if (property === "position" && /^(?:fixed|sticky)$/iu.test(value.trim())) {
    throw new Error("文档 CSS 不能使用 fixed 或 sticky 定位");
  }
  if (
    kind === "theme" &&
    !property.startsWith("--") &&
    !themeProperties.has(property)
  ) {
    throw new Error(`安装主题不允许使用 CSS 属性 ${declaration.property}`);
  }
}

function scopeRule(rule: Rule, scope: string): void {
  if (rule.prelude.type !== "SelectorList") {
    throw new Error("CSS 选择器无效");
  }
  rule.prelude.children.forEach((selector, item, list) => {
    if (selector.type !== "Selector") throw new Error("CSS 选择器无效");
    list.replace(item, list.createItem(scopeSelector(selector, scope)));
  });
}

export function compileDocumentCss(
  source: string,
  surface: DocumentCssSurface,
  kind: DocumentCssKind,
): string {
  rejectUnsafeSource(source, kind);
  let root: CssNode;
  try {
    root = parse(source, {
      onParseError: () => {
        throw new Error("CSS 语法无效");
      },
    });
  } catch {
    throw new Error("CSS 语法无效");
  }
  if (root.type !== "StyleSheet") throw new Error("CSS 语法无效");

  let rules = 0;
  const scope = documentScope(surface);
  const visitor: WalkOptions = {
    enter(node, item, list) {
      if (
        node.type === "Raw" &&
        this.declaration?.property.startsWith("--") !== true
      ) {
        throw new Error("CSS 语法无效");
      }
      if (node.type === "Comment") {
        list.remove(item);
        return walk.skip;
      }
      if (node.type === "Atrule") validateAtRule(node);
      if (node.type === "Rule") {
        if (this.rule !== null) throw new Error("文档 CSS 不支持嵌套规则");
        rules += 1;
        scopeRule(node, scope);
      }
      if (node.type === "Declaration") validateDeclaration(node, kind);
    },
  };
  walk(root, visitor);

  const maximumRules =
    kind === "theme" ? maximumThemeRules : maximumTrustedRules;
  if (rules === 0) throw new Error("CSS 不包含样式规则");
  if (rules > maximumRules) throw new Error("CSS 样式规则过多");
  return generate(root);
}
