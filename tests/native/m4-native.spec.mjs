/* global afterEach, describe, document, it, KeyboardEvent, MutationObserver, window */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import axe from "axe-core";
import { browser, $ } from "@wdio/globals";
import { Key } from "webdriverio";
import {
  encodeNativeFixture,
  nativeFileSource,
  nativeFixturePath,
  nativeWorkspaceNextPath,
  nativeWorkspaceNextSource,
} from "./fixtures.mjs";

const primaryModifier = process.platform === "darwin" ? Key.Command : Key.Ctrl;

function exactButton(label) {
  return $(`//button[normalize-space(.)=${JSON.stringify(label)}]`);
}

async function openFileMenu() {
  await $("details.file-menu > summary").click();
}

async function dispatchEditorShortcut(editor, key, shiftKey = false) {
  await editor.click();
  await browser.execute(
    (element, shortcutKey, useMetaKey, useShiftKey) => {
      const options = {
        key: useShiftKey ? shortcutKey.toUpperCase() : shortcutKey,
        code: `Key${shortcutKey.toUpperCase()}`,
        bubbles: true,
        cancelable: true,
        ctrlKey: !useMetaKey,
        metaKey: useMetaKey,
        shiftKey: useShiftKey,
      };
      for (const type of ["keydown", "keyup"]) {
        const event = new KeyboardEvent(type, options);
        Object.defineProperties(event, {
          keyCode: { value: shortcutKey.toUpperCase().charCodeAt(0) },
          which: { value: shortcutKey.toUpperCase().charCodeAt(0) },
        });
        element.dispatchEvent(event);
      }
    },
    editor,
    key,
    process.platform === "darwin",
    shiftKey,
  );
}

async function waitForSource(editor, expected) {
  try {
    await browser.waitUntil(
      async () => (await readEditorSource(editor)) === expected,
      { timeout: 10_000, interval: 100 },
    );
  } catch {
    throw new Error(
      `Editor source did not become ${JSON.stringify(expected)}; received ${JSON.stringify(await readEditorSource(editor))}`,
    );
  }
}

async function readEditorSource(editor) {
  return browser.execute((element) => {
    const content = element.classList.contains("cm-content")
      ? element
      : element.querySelector(".cm-content");
    const rows = content === null ? [] : [...content.children];
    return rows
      .map((row) => {
        const block = row.querySelector("[data-md-source-block]");
        if (block !== null) return block.dataset.mdSourceBlock ?? "";
        if (row.querySelector("[data-md-source-continuation]") !== null) {
          return null;
        }
        if (!row.classList.contains("cm-line")) return null;

        const sourceLine = row.cloneNode(true);
        sourceLine
          .querySelectorAll("[data-md-task-checkbox]")
          .forEach((checkbox) => {
            checkbox.replaceWith(
              document.createTextNode(checkbox.checked ? "[x]" : "[ ]"),
            );
          });
        sourceLine.querySelectorAll("[data-md-source-mark]").forEach((mark) => {
          mark.textContent = mark.dataset.mdSourceMark ?? "";
        });
        sourceLine
          .querySelectorAll("[data-md-source-inline]")
          .forEach((preview) => {
            preview.textContent = preview.dataset.mdSourceInline ?? "";
          });
        sourceLine
          .querySelectorAll(
            ".cm-widgetBuffer, .cm-md-image-widget:not([data-md-source-inline]), .cm-md-complex-widget:not([data-md-source-inline])",
          )
          .forEach((widget) => widget.remove());
        return sourceLine.textContent ?? "";
      })
      .filter((row) => row !== null)
      .join("\n");
  }, editor);
}

async function replaceEditorSource(editor, source) {
  await editor.click();
  await browser.keys([primaryModifier, "a"]);
  // Element Send Keys preserves supplementary Unicode characters such as emoji.
  await editor.addValue(source);
  await waitForSource(editor, source);
}

async function readRecoverySnapshot() {
  return browser.executeAsync((done) => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (invoke === undefined) {
      done(null);
      return;
    }
    void invoke("load_recovery_snapshot")
      .then((bytes) => {
        done(
          bytes === null
            ? null
            : JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))),
        );
      })
      .catch(() => done(null));
  });
}

async function waitForRecoverySource(expected) {
  await browser.waitUntil(
    async () => {
      const snapshot = await readRecoverySnapshot();
      return (
        snapshot?.documents.find(
          ({ session }) => session.id === snapshot.activeId,
        )?.text === expected
      );
    },
    {
      timeout: 5_000,
      interval: 100,
      timeoutMsg:
        "The native recovery snapshot did not contain the exact source",
    },
  );
}

async function expectNativeAccessible(surface) {
  await browser.execute(axe.source);
  const violations = await browser.executeAsync((done) => {
    void window.axe
      .run(document)
      .then((results) => {
        done(
          results.violations.map(({ id, impact, nodes }) => ({
            id,
            impact,
            targets: nodes.map(({ target }) => target.join(" ")),
          })),
        );
      })
      .catch((error) => done([{ id: String(error), targets: [] }]));
  });
  assert.deepEqual(violations, [], `${surface} has accessibility violations`);
}

describe("M4 native Tauri acceptance", () => {
  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    const directory = process.env.MDEDITOR_NATIVE_RUN_DIR;
    await browser.saveScreenshot(path.join(directory, "failure.png"));
    await writeFile(
      path.join(directory, "failure.html"),
      await browser.getPageSource(),
    );
  });

  it("keeps the native writing layout within its window", async () => {
    await browser.switchToWindow("main");
    const editor = await $(
      '.editor-document-host:not([hidden]) [role="textbox"][aria-label="Markdown 源码编辑器"]',
    );
    await editor.waitForDisplayed();
    const directory = process.env.MDEDITOR_NATIVE_RUN_DIR;
    await browser.saveScreenshot(path.join(directory, "layout-default.png"));

    await editor.click();
    await browser.keys([primaryModifier, "a"]);
    await editor.addValue("a".repeat(500));
    const measureLayout = () =>
      browser.execute(() => {
        const widthOf = (selector) => {
          const element = document.querySelector(selector);
          if (element === null) throw new Error(`Missing ${selector}`);
          return {
            client: element.clientWidth,
            scroll: element.scrollWidth,
          };
        };
        return {
          viewport: document.documentElement.clientWidth,
          mode: document.querySelector(".app-shell")?.dataset.editorMode,
          page: widthOf("html"),
          titlebar: widthOf(".titlebar"),
          toolbar: widthOf(".editor-toolbar"),
          editor: widthOf(".cm-scroller"),
        };
      });
    const measurements = await measureLayout();
    assert.equal(measurements.mode, "hybrid");
    assert.ok(measurements.viewport >= 360);
    for (const name of ["page", "titlebar", "toolbar", "editor"]) {
      const area = measurements[name];
      assert.ok(
        area.scroll <= area.client + 1,
        `${name} horizontally overflows in the native window: ${JSON.stringify(area)}`,
      );
    }
    await browser.saveScreenshot(
      path.join(directory, "layout-wrapped-line.png"),
    );

    if (process.platform === "win32") {
      const originalWindow = await browser.getWindowRect();
      const pixelRatio = await browser.execute(() => window.devicePixelRatio);
      try {
        await browser.setWindowRect(
          originalWindow.x,
          originalWindow.y,
          Math.round(360 * pixelRatio),
          Math.round(640 * pixelRatio),
        );
        await browser.waitUntil(
          async () =>
            (await browser.execute(
              () => document.documentElement.clientWidth,
            )) <= 600,
        );
        await browser.waitUntil(
          async () => {
            const layout = await measureLayout();
            return layout.editor.scroll <= layout.editor.client + 1;
          },
          {
            timeout: 5_000,
            interval: 100,
            timeoutMsg: "The native editor did not reflow after window resize",
          },
        );
        const narrow = await measureLayout();
        await writeFile(
          path.join(directory, "layout-narrow-measurements.json"),
          JSON.stringify(
            { requestedCssWidth: 360, pixelRatio, ...narrow },
            null,
            2,
          ),
        );
        assert.ok(
          narrow.viewport > 0 && narrow.viewport <= 600,
          `Unexpected native narrow viewport: ${narrow.viewport}px`,
        );
        for (const name of ["page", "titlebar", "toolbar", "editor"]) {
          const area = narrow[name];
          assert.ok(
            area.scroll <= area.client + 1,
            `${name} horizontally overflows at ${narrow.viewport}px: ${JSON.stringify(area)}`,
          );
        }
        await browser.saveScreenshot(path.join(directory, "layout-narrow.png"));
        await $("details.file-menu > summary").click();
        const filePanel = await browser.execute(() => {
          const panel = document.querySelector(".file-panel");
          if (panel === null) throw new Error("Missing file panel");
          const rect = panel.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            viewport: document.documentElement.clientWidth,
          };
        });
        assert.ok(
          filePanel.left >= -1 && filePanel.right <= filePanel.viewport + 1,
        );
        await browser.saveScreenshot(
          path.join(directory, "layout-narrow-file-menu.png"),
        );
        await $("details.file-menu > summary").click();
      } finally {
        await browser.setWindowRect(
          originalWindow.x,
          originalWindow.y,
          originalWindow.width,
          originalWindow.height,
        );
      }
    }
  });

  it("keeps a continuous editing flow recoverable in the real WebView", async () => {
    // The embedded provider names the initial Tauri window by its label. An
    // explicit switch also tells the service that this single-window test does
    // not need its optional frontend-plugin-based focus recovery.
    await browser.switchToWindow("main");
    let editor = await $('[role="textbox"][aria-label="Markdown 源码编辑器"]');
    await editor.waitForDisplayed();

    const seededSource = [
      "# 原生验收",
      "",
      "草稿包含中文与 emoji 🙂。",
      "",
      "## 清单",
      "",
      "- [ ] 校验恢复稿",
      "- [x] 校验混合模式",
      "",
      "尾段",
    ].join("\n");
    await replaceEditorSource(editor, seededSource);

    const hybrid = await exactButton("混合");
    await hybrid.click();
    await browser.waitUntil(
      async () => (await hybrid.getAttribute("aria-checked")) === "true",
    );
    assert.match(await $(".cm-md-heading-1").getText(), /原生验收/u);

    const task = await $('[data-md-task-checkbox="true"]');
    await task.click();
    let expectedSource = seededSource.replace(
      "- [ ] 校验恢复稿",
      "- [x] 校验恢复稿",
    );
    await waitForSource(editor, expectedSource);

    await exactButton("查找 / 替换").then((button) => button.click());
    const find = await $('[aria-label="查找"]');
    const replace = await $('[aria-label="替换"]');
    await find.setValue("草稿");
    await replace.setValue("终稿");
    await exactButton("全部替换").then((button) => button.click());
    expectedSource = expectedSource.replace("草稿", "终稿");
    await waitForSource(editor, expectedSource);

    await editor.click();
    await browser.keys([primaryModifier, Key.End]);
    await editor.addValue("\n\n");
    await editor.addValue("*");
    await editor.addValue("重点");
    await editor.addValue("*");
    expectedSource += "\n\n*重点*";
    await waitForSource(editor, expectedSource);

    await dispatchEditorShortcut(editor, "z");
    assert.notEqual(await readEditorSource(editor), expectedSource);
    await dispatchEditorShortcut(
      editor,
      process.platform === "darwin" ? "z" : "y",
      process.platform === "darwin",
    );
    await waitForSource(editor, expectedSource);

    await editor.click();
    await browser.keys([primaryModifier, "a"]);
    await browser.keys([Key.ArrowRight]);
    await $("details.format-menu > summary").click();
    await $('[aria-label="插入目录"]').click();
    const withToc = `${expectedSource}\n\n[toc]`;
    await waitForSource(editor, withToc);
    await editor.click();
    await dispatchEditorShortcut(editor, "z");
    await waitForSource(editor, expectedSource);
    await dispatchEditorShortcut(
      editor,
      process.platform === "darwin" ? "z" : "y",
      process.platform === "darwin",
    );
    await waitForSource(editor, withToc);
    expectedSource = withToc;

    await $("details.format-menu > summary").click();
    const focus = await exactButton("专注");
    const typewriter = await exactButton("打字机");
    if ((await focus.getAttribute("aria-pressed")) !== "true") {
      await focus.click();
    }
    if ((await typewriter.getAttribute("aria-pressed")) !== "true") {
      await typewriter.click();
    }
    assert.equal(await focus.getAttribute("aria-pressed"), "true");
    assert.equal(await typewriter.getAttribute("aria-pressed"), "true");
    await $(".cm-focus-dimmed").waitForDisplayed();

    if (process.platform === "win32") {
      await browser.execute(() => {
        window.__mdeditorPrintCalled = false;
        const observer = new MutationObserver(() => {
          document
            .querySelectorAll("iframe.document-print-frame")
            .forEach((frame) => {
              if (frame.contentWindow !== null) {
                frame.contentWindow.print = () => {
                  window.__mdeditorPrintCalled = true;
                };
              }
            });
        });
        observer.observe(document.body, { childList: true });
      });
    }
    await $("summary=导出").click();
    const printButton = await exactButton("打印 / PDF");
    assert.equal(await printButton.isDisplayed(), true);
    if (process.platform !== "win32") {
      // WebKit opens a native print dialog that cannot be automated reliably
      // on macOS or under Linux Xvfb. The browser suite validates the output;
      // these native flows verify that the real WebView exposes the command.
      await $("summary=导出").click();
    } else {
      await printButton.click();
      await browser.waitUntil(() =>
        browser.execute(() => window.__mdeditorPrintCalled === true),
      );
    }

    // Polling the app's real invoke bridge proves the Rust command persisted a
    // snapshot before the WebView is refreshed.
    await browser.waitUntil(
      async () => {
        const snapshot = await readRecoverySnapshot();
        return (
          snapshot?.version === 2 &&
          snapshot.documents.length === 1 &&
          snapshot.documents[0].session.id === snapshot.activeId &&
          snapshot.documents[0].text === expectedSource
        );
      },
      {
        timeout: 5_000,
        interval: 200,
        timeoutMsg:
          "The latest exact source was not persisted to native recovery",
      },
    );
    await browser.refresh();
    await browser.waitUntil(async () =>
      (await $(".document-notice").getText()).includes("已恢复"),
    );
    editor = await $('[role="textbox"][aria-label="Markdown 源码编辑器"]');
    await waitForSource(editor, expectedSource);
  });

  it("centers a distant caret in typewriter mode without changing source", async () => {
    const editor = await $(
      '.editor-document-host:not([hidden]) [role="textbox"][aria-label="Markdown 源码编辑器"]',
    );
    const source = Array.from({ length: 100 }, (_, index) =>
      index === 62 ? "NATIVE-TYPEWRITER-TARGET 中文段落" : `原生段落 ${index}`,
    ).join("\n\n");
    await editor.click();
    await browser.keys([primaryModifier, "a"]);
    await editor.addValue(source);
    // CodeMirror virtualizes long documents, so validate the whole canonical
    // text through the app's real Rust recovery store rather than visible DOM.
    await waitForRecoverySource(source);

    await $("details.format-menu > summary").click();
    const typewriter = await exactButton("打字机");
    if ((await typewriter.getAttribute("aria-pressed")) !== "true") {
      await typewriter.click();
    }
    assert.equal(await typewriter.getAttribute("aria-pressed"), "true");

    await exactButton("查找 / 替换").then((button) => button.click());
    await $('[aria-label="查找"]').setValue("NATIVE-TYPEWRITER-TARGET");
    await exactButton("下一个").then((button) => button.click());
    await browser.keys([Key.Escape]);
    await editor.click();
    await browser.keys([Key.ArrowRight]);

    await browser.waitUntil(
      async () =>
        (await browser.execute(() => {
          const active = document.querySelector(
            ".editor-document-host:not([hidden])",
          );
          const cursor = active
            ?.querySelector(".cm-cursor")
            ?.getBoundingClientRect();
          const scroller = active
            ?.querySelector(".cm-scroller")
            ?.getBoundingClientRect();
          if (cursor === undefined || scroller === undefined) return Infinity;
          return Math.abs(
            cursor.y + cursor.height / 2 - (scroller.y + scroller.height / 2),
          );
        })) < 90,
      {
        timeout: 5_000,
        interval: 100,
        timeoutMsg: "Typewriter mode did not center the distant native caret",
      },
    );
    await waitForRecoverySource(source);
    await typewriter.click();
    await $("details.format-menu > summary").click();
  });

  it("preserves BOM and CRLF on disk and refuses an external-change overwrite", async () => {
    const file = nativeFixturePath(process.env.MDEDITOR_NATIVE_RUN_DIR);
    await openFileMenu();
    // The embedded driver's option click does not emit a select change on
    // WebView2. Dispatch the DOM event; the app still uses its real Rust bridge.
    await browser.execute((selectedPath) => {
      const select = document.querySelector('[aria-label="最近文件"]');
      select.value = selectedPath;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, file);
    await browser.waitUntil(async () =>
      (
        await $(
          '[role="tablist"][aria-label="文档标签页"] [role="tab"][aria-selected="true"]',
        ).getText()
      ).includes("字节保真.md"),
    );
    // Inactive tabs keep their own editor instances, so only target the active one.
    const editor = await $(
      '.editor-document-host:not([hidden]) [role="textbox"]',
    );
    await editor.waitForDisplayed();
    await waitForSource(editor, nativeFileSource);
    assert.deepEqual(
      await readFile(file),
      encodeNativeFixture(nativeFileSource),
    );

    const editedSource = nativeFileSource.replace("中文与", "已编辑中文与");
    await replaceEditorSource(editor, editedSource);
    await exactButton("保存").then((button) => button.click());
    await browser.waitUntil(async () =>
      (await $(".document-notice").getText()).includes("已安全保存"),
    );
    assert.deepEqual(await readFile(file), encodeNativeFixture(editedSource));
    await waitForSource(editor, editedSource);

    const unsavedSource = editedSource.replace("保存校验", "保留未保存内容");
    await replaceEditorSource(editor, unsavedSource);
    const externalBytes = encodeNativeFixture(
      "# 外部修改\n\n必须保留此版本。\n",
    );
    await writeFile(file, externalBytes);
    await exactButton("保存").then((button) => button.click());
    await browser.waitUntil(async () =>
      (await $(".document-notice").getText()).includes("保存失败"),
    );
    assert.deepEqual(await readFile(file), externalBytes);
    await waitForSource(editor, unsavedSource);
  });

  it("previews and imports local images in a single opened document", async () => {
    const file = nativeFixturePath(process.env.MDEDITOR_NATIVE_RUN_DIR);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlwsAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(path.join(path.dirname(file), "本地图.png"), png);
    const editor = await $(
      '.editor-document-host:not([hidden]) [role="textbox"]',
    );
    await replaceEditorSource(
      editor,
      "# 单文件图片\n\n![本地图](%E6%9C%AC%E5%9C%B0%E5%9B%BE.png)",
    );
    await browser.waitUntil(async () => {
      const image = await $(".cm-md-image-widget img");
      return (await image.isExisting()) && (await image.isDisplayed());
    });
    const directImageButton = await $(
      '.editor-toolbar > button[aria-label="插入图片"]',
    );
    if (
      (await directImageButton.isExisting()) &&
      (await directImageButton.isDisplayed())
    ) {
      await directImageButton.click();
    } else {
      await $("details.format-menu > summary").click();
      await $(
        'details.format-menu .format-panel button[aria-label="插入图片"]',
      ).click();
    }
    await browser.waitUntil(async () =>
      (await readEditorSource(editor)).includes(
        "assets/%E9%80%89%E6%8B%A9%E5%9B%BE.png",
      ),
    );
    assert.deepEqual(
      await readFile(path.join(path.dirname(file), "assets", "选择图.png")),
      png,
    );
    await browser.execute(
      (element, imageBytes) => {
        const transfer = new window.DataTransfer();
        transfer.items.add(
          new window.File([new Uint8Array(imageBytes)], "粘贴图片.png", {
            type: "image/png",
          }),
        );
        element.dispatchEvent(
          new window.ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: transfer,
          }),
        );
      },
      editor,
      [...png],
    );
    await browser.waitUntil(async () =>
      (await readEditorSource(editor)).includes(
        "assets/%E7%B2%98%E8%B4%B4%E5%9B%BE%E7%89%87.png",
      ),
    );
    assert.deepEqual(
      await readFile(path.join(path.dirname(file), "assets", "粘贴图片.png")),
      png,
    );
  });

  it("searches and saves a Chinese-path repository in the native workspace", async () => {
    await openFileMenu();
    await exactButton("打开文件夹").then((button) => button.click());
    const workspace = await $(".workspace-files");
    await workspace.waitForDisplayed();
    assert.match(await workspace.getText(), /中文 指南/u);

    await workspace
      .$(".workspace-discovery-actions button:first-child")
      .click();
    const quickOpen = await workspace.$('[aria-label="快速打开"] input');
    await quickOpen.setValue("开始");
    await workspace.$('[role="option"][title="中文 指南/开始.md"]').click();
    await browser.waitUntil(async () =>
      (
        await $(
          '[role="tablist"][aria-label="文档标签页"] [role="tab"][aria-selected="true"]',
        ).getText()
      ).includes("开始.md"),
    );
    await browser.waitUntil(async () => {
      const image = await $(".cm-md-image-widget img");
      return (
        (await image.isExisting()) &&
        (await image.getAttribute("src")).startsWith("data:image/png")
      );
    });

    await workspace
      .$(".workspace-discovery-actions button:first-child")
      .click();
    await workspace.$('[aria-label="快速打开"] input').setValue("下一步");
    await workspace.$('[role="option"][title="中文 指南/下一步.md"]').click();
    await browser.waitUntil(async () =>
      (
        await $(
          '[role="tablist"][aria-label="文档标签页"] [role="tab"][aria-selected="true"]',
        ).getText()
      ).includes("下一步.md"),
    );
    await exactButton("源码").then((button) => button.click());
    const editor = await $(
      '.editor-document-host:not([hidden]) [role="textbox"][aria-label="Markdown 源码编辑器"]',
    );
    await editor.waitForDisplayed();
    await waitForSource(editor, nativeWorkspaceNextSource);

    const editedSource = nativeWorkspaceNextSource.replace(
      "数据库迁移方案。",
      "数据库迁移方案已核对。",
    );
    await replaceEditorSource(editor, editedSource);
    await exactButton("保存").then((button) => button.click());
    const savedPath = nativeWorkspaceNextPath(
      process.env.MDEDITOR_NATIVE_RUN_DIR,
    );
    await browser.waitUntil(
      async () => (await readFile(savedPath, "utf8")) === editedSource,
    );

    await workspace
      .$(".workspace-discovery-actions button:nth-child(2)")
      .click();
    const query = await workspace.$('[aria-label="全局搜索"] input[required]');
    await query.setValue("数据库迁移方案已核对");
    await workspace.$('[aria-label="全局搜索"] button[type="submit"]').click();
    await browser.waitUntil(async () =>
      (await workspace.$(".workspace-search-status").getText()).includes(
        "找到 1 处",
      ),
    );
    const result = await workspace.$(".workspace-search-results button");
    assert.match(await result.getText(), /中文 指南\/下一步\.md/u);
    await result.click();
    await waitForSource(editor, editedSource);
  });

  it("audits real workspace, document and search views for accessibility", async () => {
    await openFileMenu();
    await exactButton("打开文件夹").then((button) => button.click());
    const workspace = await $(".workspace-files");
    await workspace.waitForDisplayed();
    assert.match(await workspace.getText(), /可访问性\.md/u);
    await expectNativeAccessible("workspace file tree");

    await workspace.$(".workspace-files-heading button").click();
    await workspace.$(".workspace-file-create").waitForDisplayed();
    await expectNativeAccessible("workspace document creation");
    await workspace.$(".workspace-file-create button[type=button]").click();

    await workspace.$(".workspace-file-manage-button").click();
    await workspace.$(".workspace-file-manage").waitForDisplayed();
    await expectNativeAccessible("workspace file management");
    await workspace.$(".workspace-file-manage button:last-child").click();

    await workspace
      .$(".workspace-discovery-actions button:first-child")
      .click();
    await workspace.$('[aria-label="快速打开"]').waitForDisplayed();
    await expectNativeAccessible("workspace quick open");
    await workspace
      .$(".workspace-discovery-actions button:first-child")
      .click();

    await workspace
      .$(
        './/button[contains(@class, "workspace-file-open") and normalize-space(.)="可访问性.md"]',
      )
      .click();
    await browser.waitUntil(async () =>
      (
        await $(
          '[role="tablist"][aria-label="文档标签页"] [role="tab"][aria-selected="true"]',
        ).getText()
      ).includes("可访问性.md"),
    );
    await expectNativeAccessible("workspace document");

    await workspace
      .$(".workspace-discovery-actions button:nth-child(2)")
      .click();
    await workspace.$('[aria-label="全局搜索"]').waitForDisplayed();
    await expectNativeAccessible("workspace search");
  });
});
