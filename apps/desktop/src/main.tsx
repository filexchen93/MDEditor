import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";

import { AppShell } from "@mdeditor/ui";
import "@mdeditor/ui/styles.css";

import { createDesktopDocumentAdapter } from "./document-adapter.js";

const rootElement = document.querySelector<HTMLDivElement>("#root");

if (!rootElement) {
  throw new Error("MDEditor root element was not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppShell
      documentAdapter={isTauri() ? createDesktopDocumentAdapter() : undefined}
    />
  </StrictMode>,
);
