import mermaid from "mermaid";

import type { ComplexRenderContext } from "@mdeditor/editor-core";

let initialized = false;
let renderSequence = 0;

function initializeMermaid() {
  if (initialized) return;
  mermaid.initialize({
    maxEdges: 500,
    maxTextSize: 50_000,
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: "base",
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
        ((name === "href" || name === "xlink:href") &&
          value !== "" &&
          !value.startsWith("#"))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  const root = parsed.documentElement;
  if (root.localName !== "svg") throw new Error("Mermaid 未生成 SVG 根节点");
  return document.importNode(root, true) as unknown as SVGElement;
}

export async function renderMermaid({
  container,
  source,
  signal,
}: ComplexRenderContext): Promise<void> {
  if (signal.aborted) return;
  initializeMermaid();
  const id = `mdeditor-mermaid-${++renderSequence}`;
  const { svg } = await mermaid.render(id, source);
  if (signal.aborted) return;
  container.replaceChildren(parseSafeSvg(svg));
}
