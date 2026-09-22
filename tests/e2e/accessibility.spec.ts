import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    nodes: nodes.map(({ target, failureSummary }) => ({
      target: target.join(" "),
      failureSummary,
    })),
  }));
  expect(violations).toEqual([]);
}

test("workspace and document controls pass automated accessibility audit", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("main.app-shell")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expectAccessible(page);
  const scroller = page.getByRole("region", { name: "文档滚动区域" });
  await scroller.focus();
  await expect(scroller).toBeFocused();
  await scroller.press("Tab");
  await expect(
    page.getByRole("textbox", { name: "Markdown 源码编辑器" }),
  ).toBeFocused();
});

test("file, settings and export disclosures pass automated accessibility audit", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("main.app-shell")).toHaveAttribute(
    "aria-busy",
    "false",
  );

  const fileMenu = page.locator("details.file-menu");
  await fileMenu.locator("summary").click();
  await expectAccessible(page);
  await fileMenu.locator("summary").click();

  const settings = page.locator("details.settings-menu").first();
  await settings.locator("summary").click();
  await expectAccessible(page);
  await settings.locator("summary").click();

  const exportMenu = page.locator("details.export-menu");
  await exportMenu.locator("summary").click();
  await expectAccessible(page);
});

test("hybrid preview controls pass automated accessibility audit", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await page.keyboard.insertText(
    [
      "# 检查",
      "",
      "- [ ] 任务",
      "",
      "| 名称 | 值 |",
      "| --- | --- |",
      "| A | B |",
      "",
      "<details><summary>说明</summary>安全内容</details>",
      "",
      "结束。",
    ].join("\n"),
  );
  await editor.press("ControlOrMeta+End");
  await page.getByRole("radio", { name: "混合" }).click();
  await expect(page.locator("[data-md-table-preview]")).toBeVisible();
  await expect(page.locator('[data-md-html-preview="block"]')).toBeVisible();
  await expectAccessible(page);
});

test("outline and search panels pass automated accessibility audit", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Markdown 源码编辑器" });
  await editor.click();
  await page.keyboard.insertText("# 第一章\n\n正文\n\n## 第二节\n");
  await editor.press("ControlOrMeta+End");
  await page
    .getByRole("toolbar", { name: "Markdown 格式与插入工具" })
    .getByRole("button", { name: "大纲" })
    .click();
  await page.getByRole("button", { name: "查找 / 替换" }).click();
  await expect(page.locator(".outline-panel")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "文档查找替换" }),
  ).toBeVisible();
  await expectAccessible(page);
});

test("dark document theme passes automated accessibility audit", async ({
  page,
}) => {
  await page.goto("/");
  const settings = page.locator("details.settings-menu").first();
  await settings.locator("summary").click();
  await page
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("dark");
  await settings.locator("summary").click();
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-theme",
    "dark",
  );
  await expectAccessible(page);
});
