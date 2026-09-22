/* global describe, it */
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";

describe("native startup file argument", () => {
  it("opens the path directly as an editable document", async () => {
    await browser.switchToWindow("main");
    await browser.waitUntil(
      async () =>
        (
          await $(
            '[role="tablist"][aria-label="文档标签页"] [role="tab"][aria-selected="true"]',
          ).getText()
        ).includes("字节保真.md"),
      { timeout: 15_000, interval: 100 },
    );
    const editor = await $(
      '.editor-document-host:not([hidden]) [role="textbox"][aria-label="Markdown 源码编辑器"]',
    );
    await editor.waitForDisplayed();
    const visibleText = await editor.getText();
    assert.ok(visibleText.includes("中文与 emoji 🙂。"));
    assert.equal(await editor.getAttribute("contenteditable"), "true");
  });
});
