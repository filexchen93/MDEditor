import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getIdentifier, getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";

import { AppShell } from "@mdeditor/ui";
import "@mdeditor/ui/styles.css";

import { createDesktopDocumentAdapter } from "./document-adapter.js";

function confirmInDesktop(message: string): Promise<boolean> {
  return confirm(message, { title: "MDEditor", kind: "warning" });
}

function confirmRecoveryInNativeTest(message: string): Promise<boolean> {
  if (
    message.includes("自动保存的") &&
    message.endsWith("恢复工作区。是否恢复？")
  ) {
    return Promise.resolve(true);
  }
  return confirmInDesktop(message);
}

async function resolveDesktopConfirmation() {
  if (!isTauri()) return undefined;
  try {
    const identifier = await getIdentifier();
    if (identifier === "io.github.filexchen93.mdeditor.native-test") {
      return confirmRecoveryInNativeTest;
    }
  } catch {
    // A metadata lookup failure must not prevent the editor from opening.
  }
  return confirmInDesktop;
}

const rootElement = document.querySelector<HTMLDivElement>("#root");

if (!rootElement) {
  throw new Error("MDEditor root element was not found");
}

void Promise.all([
  resolveDesktopConfirmation(),
  isTauri() ? getVersion().catch(() => "未知") : Promise.resolve("开发版"),
]).then(([confirmAction, appVersion]) => {
  createRoot(rootElement).render(
    <StrictMode>
      <AppShell
        appVersion={appVersion}
        confirmAction={confirmAction}
        documentAdapter={isTauri() ? createDesktopDocumentAdapter() : undefined}
      />
    </StrictMode>,
  );
});
