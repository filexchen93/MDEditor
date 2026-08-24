# IME test matrix

Automated composition-event coverage begins with the M2 decoration layer. Manual release checks must cover:

| Platform | Input method        | Required behavior                                       |
| -------- | ------------------- | ------------------------------------------------------- |
| Windows  | Microsoft Pinyin    | Composition is not committed twice or interrupted       |
| macOS    | Pinyin - Simplified | Selection and candidate confirmation remain stable      |
| Linux    | Fcitx5 Pinyin       | Composition updates do not rebuild intersecting widgets |

Every regression fixture should include Chinese punctuation, mixed Latin text, emoji and undo/redo after composition.

## Automated coverage

`tests/e2e/desktop.spec.ts` drives Chromium's IME composition protocol with
`中文，A🙂`, verifies that the text is committed exactly once, and proves that
undo and redo remain intact. The same test keeps an image widget mounted across
the composition update so that decoration rebuilds cannot silently invalidate
the active DOM range.

Windows release candidates must still receive one manual Microsoft Pinyin pass.
The macOS and Linux rows remain required on those release platforms because a
Chromium protocol test cannot reproduce each operating system's candidate UI.
