/* global describe, it */

import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";
import { restartRecoverySource } from "./restart-fixture.mjs";

async function sourceText(editor) {
  return browser.execute((element) => {
    const content = element.classList.contains("cm-content")
      ? element
      : element.querySelector(".cm-content");
    return [...content.children]
      .filter((row) => row.classList.contains("cm-line"))
      .map((row) => row.textContent ?? "")
      .join("\n");
  }, editor);
}

describe("native process-restart recovery restore", () => {
  it("restores the first process source in a newly launched application", async () => {
    await browser.switchToWindow("main");
    await browser.waitUntil(async () =>
      (await $(".document-notice").getText()).includes("已恢复"),
    );
    const editor = await $(
      '[role="textbox"][aria-label="Markdown 源码编辑器"]',
    );
    await editor.waitForDisplayed();
    await $('//button[normalize-space(.)="源码"]').click();
    await browser.waitUntil(
      async () => (await sourceText(editor)) === restartRecoverySource,
    );
    assert.equal(await sourceText(editor), restartRecoverySource);
  });
});
