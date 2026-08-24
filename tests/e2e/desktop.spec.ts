import { expect, test, type Locator } from "@playwright/test";

async function readEditorSource(editor: Locator) {
  return editor.evaluate((element) =>
    [...element.querySelectorAll(".cm-line")]
      .map((line) => {
        const sourceLine = line.cloneNode(true) as HTMLElement;
        sourceLine
          .querySelectorAll(".cm-widgetBuffer, .cm-md-image-widget")
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
