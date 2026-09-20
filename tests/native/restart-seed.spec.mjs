/* global describe, it, window */

import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";
import { Key } from "webdriverio";
import { restartRecoverySource } from "./restart-fixture.mjs";

async function recoveryText() {
  return browser.executeAsync((done) => {
    void window.__TAURI_INTERNALS__
      .invoke("load_recovery_snapshot")
      .then((bytes) => {
        if (bytes === null) {
          done(null);
          return;
        }
        const snapshot = JSON.parse(
          new TextDecoder().decode(new Uint8Array(bytes)),
        );
        done(
          snapshot.documents.find(
            ({ session }) => session.id === snapshot.activeId,
          )?.text ?? null,
        );
      });
  });
}

describe("native process-restart recovery seed", () => {
  it("persists the exact latest source before the first process exits", async () => {
    await browser.switchToWindow("main");
    const editor = await $(
      '[role="textbox"][aria-label="Markdown 源码编辑器"]',
    );
    await editor.waitForDisplayed();
    await editor.click();
    await editor.keys([
      process.platform === "darwin" ? Key.Command : Key.Ctrl,
      "a",
    ]);
    await editor.addValue(restartRecoverySource);
    await browser.waitUntil(
      async () => (await recoveryText()) === restartRecoverySource,
      {
        timeout: 5_000,
        interval: 100,
        timeoutMsg: "The first process did not persist its latest exact source",
      },
    );
    assert.equal(await recoveryText(), restartRecoverySource);
  });
});
