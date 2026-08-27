import { expect, test, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function readEditorSource(editor: Locator) {
  return editor.evaluate((element) =>
    [...element.querySelectorAll(".cm-line")]
      .map((line) => {
        const sourceLine = line.cloneNode(true) as HTMLElement;
        sourceLine
          .querySelectorAll(
            ".cm-widgetBuffer, .cm-md-image-widget, .cm-md-complex-widget",
          )
          .forEach((widget) => widget.remove());
        return sourceLine.textContent ?? "";
      })
      .join("\n"),
  );
}

test("source editor accepts text and derives dirty state", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("MDEditor");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("欢迎使用 MDEditor");

  await editor.click();
  await page.keyboard.type("M1 ");
  await expect(page.getByText("未命名 · 未保存")).toBeVisible();
  await expect(page.getByText(/^修订 [1-9]\d*$/)).toBeVisible();
});

test("editor settings persist without losing the draft", async ({ page }) => {
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await page.keyboard.type("settings draft ");

  await page.getByText("设置", { exact: true }).click();
  await page.getByRole("slider", { name: "字号" }).fill("20");
  await page.getByRole("checkbox", { name: "自动换行" }).check();

  await expect(editor).toContainText("settings draft");
  await expect(page.getByText("20px")).toBeVisible();
  await expect(
    page.getByText("自动换行", { exact: true }).last(),
  ).toBeVisible();

  await page.reload();
  await page.getByText("设置", { exact: true }).click();
  await expect(page.getByText("20px")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "自动换行" })).toBeChecked();
});

test("hybrid rendering is derived and preserves caret and undo history", async ({
  page,
}) => {
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = [
    "# 标题 *强调* **加粗**",
    "",
    "> 引用 [链接](https://example.com)",
    "",
    "- 列表",
    "",
    "![图片](data:image/png;base64,iVBORw0KGgo=)",
    "",
    "`const value = 1`",
    "",
    "```js",
    "const highlighted = true",
    "```",
  ].join("\n");

  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);

  const hybridButton = page.getByRole("button", { name: "混合" });
  await hybridButton.click();
  await expect(hybridButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".cm-md-heading-1")).toContainText("标题");
  await expect(page.locator(".cm-md-emphasis")).toContainText("强调");
  await expect(page.locator(".cm-md-strong")).toContainText("加粗");
  await expect(page.locator(".cm-md-link")).toContainText("链接");
  await expect(page.locator(".cm-code-keyword")).toContainText("const");
  await expect(page.locator('[data-md-image-widget="true"]')).toHaveCount(1);

  await editor.press("ControlOrMeta+End");
  await editor.press("x");
  await expect.poll(() => readEditorSource(editor)).toBe(`${source}x`);
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  await page.getByRole("button", { name: "源码" }).click();
  await expect(page.locator(".cm-md-heading-1")).toHaveCount(0);
  await expect(page.locator('[data-md-image-widget="true"]')).toHaveCount(0);
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});

test("Chinese IME composition is committed once and remains undoable", async ({
  page,
}) => {
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const sourcePrefix = "![图片](data:image/png;base64,iVBORw0KGgo=)\n\n# ";
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(sourcePrefix);
  await page.getByRole("button", { name: "混合" }).click();
  await editor.focus();
  await editor.press("End");
  const imageWidget = await page
    .locator('[data-md-image-widget="true"]')
    .elementHandle();
  expect(imageWidget).not.toBeNull();

  const devtools = await page.context().newCDPSession(page);
  await devtools.send("Input.imeSetComposition", {
    text: "中",
    selectionStart: 1,
    selectionEnd: 1,
  });
  expect(await imageWidget?.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await devtools.send("Input.imeSetComposition", {
    text: "中文，A🙂",
    selectionStart: 6,
    selectionEnd: 6,
  });
  await devtools.send("Input.insertText", { text: "中文，A🙂" });

  await expect
    .poll(() => readEditorSource(editor))
    .toBe(`${sourcePrefix}中文，A🙂`);
  await expect(page.locator(".cm-md-heading-1")).toContainText("中文，A🙂");
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe(sourcePrefix);
  await editor.press("Control+y");
  await expect
    .poll(() => readEditorSource(editor))
    .toBe(`${sourcePrefix}中文，A🙂`);
});

test("GFM task checkboxes change only their source marker", async ({
  page,
}) => {
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = "- [ ] first\n- [X] second";
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  await page.getByRole("button", { name: "混合" }).click();

  const tasks = page.locator('[data-md-task-checkbox="true"]');
  await expect(tasks).toHaveCount(2);
  await expect(tasks.nth(0)).not.toBeChecked();
  await expect(tasks.nth(1)).toBeChecked();
  await tasks.nth(0).click();
  await expect(tasks.nth(0)).toBeChecked();

  await page.getByRole("button", { name: "源码" }).click();
  await expect
    .poll(() => readEditorSource(editor))
    .toBe("- [x] first\n- [X] second");
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});

test("table insertion and Tab navigation include empty cells and new rows", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新建" }).click();
  await page.getByRole("button", { name: "插入表格" }).click();

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const starter = [
    "| 列 1 | 列 2 | 列 3 |",
    "| --- | --- | --- |",
    "|  |  |  |",
  ].join("\n");
  await expect.poll(() => readEditorSource(editor)).toBe(starter);

  await page.keyboard.insertText("v1");
  await page.keyboard.press("Tab");
  await page.keyboard.insertText("v2");
  await page.keyboard.press("Tab");
  await page.keyboard.insertText("v3");
  await page.keyboard.press("Tab");
  await page.keyboard.insertText("v4");

  await expect
    .poll(() => readEditorSource(editor))
    .toBe(
      [
        "| 列 1 | 列 2 | 列 3 |",
        "| --- | --- | --- |",
        "| v1 | v2 | v3 |",
        "| v4 |  |  |",
      ].join("\n"),
    );
});

test("outline derives headings, jumps to source, and updates after edits", async ({
  page,
}) => {
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = [
    "# 总览",
    "",
    "正文",
    "",
    "## 细节",
    "",
    "```md",
    "# 代码中的标题",
    "```",
    "",
    "附录",
    "====",
  ].join("\n");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  await page.getByRole("button", { name: "大纲" }).click();

  const outline = page.getByRole("navigation", { name: "文档大纲" });
  await expect(outline.getByRole("button")).toHaveCount(3);
  await expect(outline).not.toContainText("代码中的标题");
  await outline.getByRole("button", { name: "细节" }).click();
  await page.keyboard.insertText("已定位 ");

  await expect
    .poll(() => readEditorSource(editor))
    .toBe(source.replace("## 细节", "## 已定位 细节"));
  await expect(
    outline.getByRole("button", { name: "已定位 细节" }),
  ).toBeVisible();
});

test("theme and editor preferences persist without replacing history", async ({
  page,
}) => {
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("draft");
  await page.waitForTimeout(600);
  await page.keyboard.insertText(" change");
  const editorElement = await editor.elementHandle();
  expect(editorElement).not.toBeNull();

  await page.getByText("设置", { exact: true }).click();
  await page.getByRole("combobox", { name: "主题" }).selectOption("dark");
  await page.getByRole("slider", { name: "字号" }).fill("21");
  await page.getByRole("checkbox", { name: "自动换行" }).check();

  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-theme",
    "dark",
  );
  expect(
    await page
      .locator(".app-shell")
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--app-bg").trim(),
      ),
  ).toBe("#1d1c1a");
  expect(await editorElement?.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await expect.poll(() => readEditorSource(editor)).toBe("draft change");
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe("draft");

  await page.reload();
  await page.getByText("设置", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "主题" })).toHaveValue(
    "dark",
  );
  await expect(page.getByRole("slider", { name: "字号" })).toHaveValue("21");
  await expect(page.getByRole("checkbox", { name: "自动换行" })).toBeChecked();
});

test("custom shortcuts execute actions and reject conflicts", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByText("设置", { exact: true }).click();
  const modeShortcut = page.getByRole("combobox", {
    name: "切换模式快捷键",
  });
  const outlineShortcut = page.getByRole("combobox", {
    name: "切换大纲快捷键",
  });
  await modeShortcut.selectOption("Mod-Alt-m");
  await outlineShortcut.selectOption("Mod-Alt-m");
  await expect(page.locator(".document-notice")).toContainText(
    "已被其他操作使用",
  );
  await expect(outlineShortcut).toHaveValue("Mod-Shift-o");

  const hybridButton = page.getByRole("button", { name: "混合" });
  await page.keyboard.press("Control+Shift+M");
  await expect(hybridButton).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Control+Alt+M");
  await expect(hybridButton).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+Shift+O");
  await expect(
    page.getByRole("navigation", { name: "文档大纲" }),
  ).toBeVisible();

  await page.reload();
  const reloadedHybridButton = page.getByRole("button", { name: "混合" });
  await expect(reloadedHybridButton).toBeVisible();
  await page.keyboard.press("Control+Alt+M");
  await expect(reloadedHybridButton).toHaveAttribute("aria-pressed", "true");
});

test("workspace tabs preserve source, selection, history, and dirty close guards", async ({
  page,
}) => {
  await page.goto("/");

  const activeEditor = () =>
    page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const firstTab = page.getByRole("tab", { name: /未命名 1/u });
  await activeEditor().click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("first tab");
  await activeEditor().press("ControlOrMeta+Home");
  for (let index = 0; index < 5; index += 1) {
    await activeEditor().press("ArrowRight");
  }

  await page.getByRole("button", { name: "新建", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  const secondTab = page.getByRole("tab", { name: /未命名 2/u });
  await expect(secondTab).toHaveAttribute("aria-selected", "true");
  await activeEditor().click();
  await page.keyboard.insertText("second tab");

  await firstTab.click();
  await expect.poll(() => readEditorSource(activeEditor())).toBe("first tab");
  await page.keyboard.insertText("X");
  await expect.poll(() => readEditorSource(activeEditor())).toBe("firstX tab");
  await activeEditor().press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(activeEditor())).toBe("first tab");

  await secondTab.click();
  await expect.poll(() => readEditorSource(activeEditor())).toBe("second tab");
  await secondTab.press("ArrowLeft");
  await expect(firstTab).toHaveAttribute("aria-selected", "true");
  await firstTab.press("ArrowRight");
  await expect(secondTab).toHaveAttribute("aria-selected", "true");

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "关闭 未命名 2" }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "关闭 未命名 2" }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(firstTab).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => readEditorSource(activeEditor())).toBe("first tab");
});

test("KaTeX and Mermaid previews fail independently and preserve source", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto("/");

  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = [
    "```katex",
    "\\frac{a}{b}",
    "```",
    "",
    "```katex",
    "\\notARealCommand{",
    "```",
    "",
    "```mermaid",
    "flowchart LR",
    "A --> B",
    "```",
    "",
    "```mermaid",
    "not a diagram",
    "```",
    "",
    "```mermaid",
    "flowchart LR",
    'click A "https://example.com"',
    "```",
  ].join("\n");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  await page.getByRole("button", { name: "混合" }).click();
  await page.waitForTimeout(250);
  expect(pageErrors).toEqual([]);

  const widgets = page.locator(".cm-md-complex-widget");
  await expect(widgets).toHaveCount(5);
  await expect(
    page.locator('.cm-md-complex-widget[data-md-render-state="ready"]'),
  ).toHaveCount(3, { timeout: 15_000 });
  await expect(
    page.locator('.cm-md-complex-widget[data-md-render-state="error"]'),
  ).toHaveCount(2);
  await expect(
    page.locator('[data-md-complex-widget="katex"] .katex'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-md-complex-widget="mermaid"] svg'),
  ).toHaveCount(2);
  const unsafeMermaidOutput = await page
    .locator('[data-md-complex-widget="mermaid"] svg')
    .evaluateAll((svgs) =>
      svgs.flatMap((svg) => {
        const elements = [svg, ...svg.querySelectorAll("*")];
        return elements.flatMap((element) =>
          [...element.attributes]
            .filter((attribute) => {
              const name = attribute.name.toLocaleLowerCase();
              const value = attribute.value.trim().toLocaleLowerCase();
              return (
                name.startsWith("on") ||
                ((name === "href" || name === "xlink:href") &&
                  value !== "" &&
                  !value.startsWith("#"))
              );
            })
            .map((attribute) => `${element.tagName}:${attribute.name}`),
        );
      }),
    );
  expect(unsafeMermaidOutput).toEqual([]);
  await expect(
    page.locator('[data-md-complex-widget="mermaid"] script'),
  ).toHaveCount(0);
  await expect(page.locator(".cm-md-complex-error").first()).toContainText(
    "源码仍可编辑和保存",
  );
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  await editor.press("ControlOrMeta+End");
  await editor.press("x");
  await expect.poll(() => readEditorSource(editor)).toBe(`${source}x`);
  await editor.press("ControlOrMeta+z");
  await expect.poll(() => readEditorSource(editor)).toBe(source);

  await page.getByRole("button", { name: "源码" }).click();
  await expect(widgets).toHaveCount(0);
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});

test("HTML and print exports are sanitized derivatives and preserve editor state", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    const root = window as typeof window & {
      __mdeditorPrintSandbox?: string;
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof HTMLIFrameElement &&
            node.classList.contains("document-print-frame")
          ) {
            root.__mdeditorPrintSandbox = node.getAttribute("sandbox") ?? "";
          }
        }
      }
    });
    observer.observe(document.body, { childList: true });
  });
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  const source = [
    "# 安全导出",
    "",
    "| 名称 | 值 |",
    "| --- | --- |",
    "| 中文 | **正常** |",
    "",
    "- [x] 已完成",
    "",
    '[危险链接](javascript:alert(1)) <img src="x" onerror="alert(2)"> <input type="text" value="伪造控件">',
    '<script>alert(3)</script><iframe src="https://example.com"></iframe>',
  ].join("\n");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source);
  const revision = await page.getByText(/^修订 \d+$/u).textContent();

  await page.getByText("导出", { exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 HTML" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (downloadPath === null) throw new Error("HTML download has no local path");
  const html = await readFile(downloadPath, "utf8");

  expect(html).toContain("<!doctype html>");
  expect(html).toContain("Content-Security-Policy");
  expect(html).toContain("@media print");
  expect(html).toContain("<table>");
  expect(html).toContain('type="checkbox"');
  expect(html).toContain("disabled");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<iframe");
  expect(html).not.toContain("onerror");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('type="text"');
  await expect.poll(() => readEditorSource(editor)).toBe(source);
  await expect(
    page.getByText(revision ?? "missing revision", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "打印 / PDF" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __mdeditorPrintSandbox?: string;
            }
          ).__mdeditorPrintSandbox,
      ),
    )
    .toBe("allow-modals allow-same-origin");
  await expect(
    page.getByText("已打开系统打印，可选择另存为 PDF"),
  ).toBeVisible();
  await expect.poll(() => readEditorSource(editor)).toBe(source);
});
