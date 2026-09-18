import { syntaxTree } from "@codemirror/language";
import { EditorState, StateEffect, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  hoverTooltip,
  logException,
  ViewPlugin,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import type NSpell from "nspell";

export type SpellcheckLanguage = "en-US" | "en-GB";

export interface SpellcheckWord {
  readonly from: number;
  readonly to: number;
  readonly word: string;
}

export interface Spellchecker {
  readonly correct: (word: string) => boolean;
  readonly suggest: (word: string) => readonly string[];
}

interface DictionaryFiles {
  readonly aff: URL;
  readonly dic: URL;
}

const dictionaryFiles: Readonly<Record<SpellcheckLanguage, DictionaryFiles>> = {
  "en-US": {
    aff: new URL("./dictionaries/en-US.aff", import.meta.url),
    dic: new URL("./dictionaries/en-US.dic", import.meta.url),
  },
  "en-GB": {
    aff: new URL("./dictionaries/en-GB.aff", import.meta.url),
    dic: new URL("./dictionaries/en-GB.dic", import.meta.url),
  },
};

const checkerPromises = new Map<SpellcheckLanguage, Promise<NSpell>>();
const refreshSpellcheck = StateEffect.define<void>();
const wordPattern = /[A-Za-z]+(?:['’][A-Za-z]+)?/gu;
const ignoredSyntaxNodes = new Set([
  "Autolink",
  "CodeInfo",
  "CodeMark",
  "CodeText",
  "Comment",
  "Entity",
  "Escape",
  "FencedCode",
  "HTMLBlock",
  "HTMLTag",
  "InlineCode",
  "URL",
]);
const maximumVisibleWords = 2_500;

function normalizedWord(word: string): string {
  return word.replaceAll("’", "'");
}

function shouldSkipWord(word: string): boolean {
  const lettersOnly = word.replaceAll(/[’']/gu, "");
  if (lettersOnly.length < 3) return true;
  if (lettersOnly.length > 1 && lettersOnly === lettersOnly.toUpperCase()) {
    return true;
  }
  return /[A-Z]/u.test(lettersOnly.slice(1));
}

function hasIgnoredSyntaxAncestor(
  state: EditorState,
  position: number,
): boolean {
  let node = syntaxTree(state).resolveInner(position, 1);
  for (;;) {
    if (ignoredSyntaxNodes.has(node.name)) return true;
    if (node.parent === null) return false;
    node = node.parent;
  }
}

function hasWordCharacterAt(state: EditorState, position: number): boolean {
  if (position < 0 || position >= state.doc.length) return false;
  return /[A-Za-z0-9_]/u.test(state.sliceDoc(position, position + 1));
}

function isLikelyPathOrAddress(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  const line = state.doc.lineAt(from);
  const lineText = state.sliceDoc(line.from, line.to);
  const localFrom = from - line.from;
  const localTo = to - line.from;
  let tokenFrom = localFrom;
  let tokenTo = localTo;
  while (tokenFrom > 0 && !/\s/u.test(lineText[tokenFrom - 1] ?? "")) {
    tokenFrom -= 1;
  }
  while (tokenTo < lineText.length && !/\s/u.test(lineText[tokenTo] ?? "")) {
    tokenTo += 1;
  }
  const token = lineText.slice(tokenFrom, tokenTo);
  const markdownLinkBoundary = token.indexOf("](");
  if (
    markdownLinkBoundary >= 0 &&
    localFrom - tokenFrom < markdownLinkBoundary
  ) {
    return false;
  }
  return (
    token.includes("://") ||
    token.includes("@") ||
    token.includes("\\") ||
    token.includes("/")
  );
}

export function collectSpellcheckWords(
  state: EditorState,
  ranges: readonly { readonly from: number; readonly to: number }[],
  limit = maximumVisibleWords,
): SpellcheckWord[] {
  const words: SpellcheckWord[] = [];
  for (const range of ranges) {
    const source = state.sliceDoc(range.from, range.to);
    wordPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = wordPattern.exec(source)) !== null) {
      const word = match[0];
      const from = range.from + match.index;
      const to = from + word.length;
      if (
        shouldSkipWord(word) ||
        hasWordCharacterAt(state, from - 1) ||
        hasWordCharacterAt(state, to) ||
        hasIgnoredSyntaxAncestor(state, from) ||
        isLikelyPathOrAddress(state, from, to)
      ) {
        continue;
      }
      words.push({ from, to, word });
      if (words.length >= limit) return words;
    }
  }
  return words;
}

export function findMisspelledWords(
  state: EditorState,
  ranges: readonly { readonly from: number; readonly to: number }[],
  checker: Pick<Spellchecker, "correct">,
): SpellcheckWord[] {
  return collectSpellcheckWords(state, ranges).filter(
    ({ word }) => !checker.correct(normalizedWord(word)),
  );
}

async function fetchDictionaryFile(url: URL): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to load spelling dictionary (${response.status})`);
  }
  return response.text();
}

function loadSpellchecker(language: SpellcheckLanguage): Promise<NSpell> {
  const cached = checkerPromises.get(language);
  if (cached !== undefined) return cached;
  const files = dictionaryFiles[language];
  const pending = Promise.all([
    import("nspell"),
    fetchDictionaryFile(files.aff),
    fetchDictionaryFile(files.dic),
  ]).then(([module, aff, dic]) => module.default(aff, dic));
  checkerPromises.set(language, pending);
  return pending;
}

function preserveCapitalization(source: string, suggestion: string): string {
  return /^[A-Z]/u.test(source)
    ? `${suggestion.slice(0, 1).toUpperCase()}${suggestion.slice(1)}`
    : suggestion;
}

function uniqueSuggestions(checker: Spellchecker, word: string): string[] {
  const suggestions = checker
    .suggest(normalizedWord(word))
    .map((suggestion) => preserveCapitalization(word, suggestion));
  return [...new Set(suggestions)].slice(0, 3);
}

function createCorrectionTooltip(
  view: EditorView,
  word: SpellcheckWord,
  checker: Spellchecker,
): Tooltip {
  const suggestions = uniqueSuggestions(checker, word.word);
  return {
    pos: word.from,
    end: word.to,
    above: true,
    arrow: true,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-spelling-tooltip";
      const heading = document.createElement("div");
      heading.className = "cm-spelling-tooltip-heading";
      heading.textContent = `可能的拼写错误：${word.word}`;
      dom.append(heading);
      if (suggestions.length === 0) {
        const empty = document.createElement("span");
        empty.textContent = "没有可用的替换建议";
        dom.append(empty);
      } else {
        const actions = document.createElement("div");
        actions.className = "cm-spelling-tooltip-actions";
        for (const suggestion of suggestions) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = suggestion;
          button.setAttribute(
            "aria-label",
            `将 ${word.word} 改为 ${suggestion}`,
          );
          button.addEventListener("mousedown", (event) => {
            event.preventDefault();
          });
          button.addEventListener("click", () => {
            if (view.state.sliceDoc(word.from, word.to) !== word.word) return;
            view.dispatch({
              changes: { from: word.from, to: word.to, insert: suggestion },
              selection: { anchor: word.from + suggestion.length },
              userEvent: "input.spellcheck",
            });
            view.focus();
          });
          actions.append(button);
        }
        dom.append(actions);
      }
      return { dom };
    },
  };
}

function spellcheckTheme(): Extension {
  return EditorView.theme({
    ".cm-spelling-error": {
      textDecoration: "underline wavy var(--spellcheck-error, #c33d45)",
      textDecorationSkipInk: "none",
      textUnderlineOffset: "3px",
    },
    ".cm-spelling-tooltip": {
      display: "grid",
      gap: "8px",
      maxWidth: "340px",
      padding: "9px 10px",
      color: "var(--app-fg, #292722)",
      background: "var(--surface, #fffaf0)",
    },
    ".cm-spelling-tooltip-heading": {
      fontWeight: "650",
    },
    ".cm-spelling-tooltip-actions": {
      display: "flex",
      flexWrap: "wrap",
      gap: "6px",
    },
    ".cm-spelling-tooltip-actions button": {
      padding: "3px 7px",
      border: "1px solid var(--border-control, #d2c9bb)",
      borderRadius: "4px",
      color: "inherit",
      background: "var(--surface-soft, #f8eadc)",
      cursor: "pointer",
    },
  });
}

export function createSpellcheckExtension(
  language: SpellcheckLanguage,
): Extension {
  const spellingMark = Decoration.mark({
    class: "cm-spelling-error",
    attributes: { "data-spelling-error": "true" },
  });

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      checker: NSpell | null = null;
      disposed = false;

      constructor(readonly view: EditorView) {
        view.contentDOM.dataset.spellcheckState = "loading";
        void loadSpellchecker(language).then(
          (checker) => {
            if (this.disposed) return;
            this.checker = checker;
            view.contentDOM.dataset.spellcheckState = "ready";
            view.dispatch({ effects: refreshSpellcheck.of(undefined) });
          },
          (error: unknown) => {
            if (this.disposed) return;
            view.contentDOM.dataset.spellcheckState = "error";
            logException(view.state, error, "Unable to load spellchecker");
          },
        );
      }

      update(update: ViewUpdate): void {
        if (
          this.checker !== null &&
          (update.docChanged ||
            update.viewportChanged ||
            update.transactions.some((transaction) =>
              transaction.effects.some((effect) =>
                effect.is(refreshSpellcheck),
              ),
            ))
        ) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        if (this.checker === null) return Decoration.none;
        return Decoration.set(
          findMisspelledWords(view.state, view.visibleRanges, this.checker).map(
            ({ from, to }) => spellingMark.range(from, to),
          ),
          true,
        );
      }

      tooltip(position: number): Tooltip | null {
        if (this.checker === null) return null;
        const line = this.view.state.doc.lineAt(position);
        const word = collectSpellcheckWords(this.view.state, [line]).find(
          ({ from, to }) => position >= from && position <= to,
        );
        if (
          word === undefined ||
          this.checker.correct(normalizedWord(word.word))
        ) {
          return null;
        }
        return createCorrectionTooltip(this.view, word, this.checker);
      }

      destroy(): void {
        this.disposed = true;
      }
    },
    { decorations: (value) => value.decorations },
  );

  return [
    EditorView.contentAttributes.of({
      spellcheck: "false",
      lang: language,
      "data-spellcheck-language": language,
      "data-spellcheck-state": "loading",
    }),
    plugin,
    hoverTooltip(
      (view, position) => view.plugin(plugin)?.tooltip(position) ?? null,
      { hideOnChange: true, hoverTime: 250 },
    ),
    spellcheckTheme(),
  ];
}

export const spellcheckDisabledExtension = EditorView.contentAttributes.of({
  spellcheck: "false",
  "data-spellcheck-state": "disabled",
});
