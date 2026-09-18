import mermaid from "mermaid";

import type { ComplexRenderContext } from "@mdeditor/editor-core";

let initialized = false;
let renderSequence = 0;

function hasUnsafeCss(value: string): boolean {
  if (/@import|expression\s*\(|behavior\s*:|-moz-binding/iu.test(value)) {
    return true;
  }
  return [...value.matchAll(/url\s*\(\s*([^)]+?)\s*\)/giu)].some((match) => {
    const target = (match[1] ?? "").trim().replace(/^(['"])(.*)\1$/u, "$2");
    return !/^#[a-z0-9_.:-]+$/iu.test(target);
  });
}

function initializeMermaid() {
  if (initialized) return;
  mermaid.initialize({
    maxEdges: 500,
    maxTextSize: 50_000,
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: "base",
    flowchart: {
      htmlLabels: false,
    },
  });
  initialized = true;
}

function parseSafeSvg(svg: string): SVGElement {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (parsed.querySelector("parsererror") !== null) {
    throw new Error("Mermaid 生成了无效 SVG");
  }
  parsed.querySelectorAll("script").forEach((element) => element.remove());
  parsed.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLocaleLowerCase();
      const value = attribute.value.trim().toLocaleLowerCase();
      if (
        name.startsWith("on") ||
        (name === "style" && hasUnsafeCss(value)) ||
        ((name === "href" || name === "xlink:href") &&
          value !== "" &&
          !value.startsWith("#"))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  parsed.querySelectorAll("style").forEach((element) => {
    if (hasUnsafeCss(element.textContent ?? "")) {
      element.remove();
    }
  });
  const root = parsed.documentElement;
  if (root.localName !== "svg") throw new Error("Mermaid 未生成 SVG 根节点");
  return document.importNode(root, true) as unknown as SVGElement;
}

async function createSafeMermaidSvg(source: string): Promise<SVGElement> {
  initializeMermaid();
  const id = `mdeditor-mermaid-${++renderSequence}`;
  const { svg } = await mermaid.render(id, source);
  return parseSafeSvg(svg);
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

export async function renderMermaidDataUrl(source: string): Promise<string> {
  const svg = await createSafeMermaidSvg(source);
  const serialized = new XMLSerializer().serializeToString(svg);
  return `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(serialized))}`;
}

export async function renderMermaid({
  container,
  source,
  signal,
}: ComplexRenderContext): Promise<void> {
  if (signal.aborted) return;
  const svg = await createSafeMermaidSvg(source);
  if (signal.aborted) return;
  container.replaceChildren(svg);
}
