import type { Options as Html2CanvasOptions } from "@html2canvas/html2canvas";

type Html2Canvas = (
  element: HTMLElement,
  options?: Partial<Html2CanvasOptions>,
) => Promise<HTMLCanvasElement>;

const imageExportViewportWidth = 960;
const maximumImageExportHeight = 16_384;
const maximumImageExportPixels = 64 * 1024 * 1024;

async function loadHtml2Canvas(): Promise<Html2Canvas> {
  const module = await import("@html2canvas/html2canvas");
  return (module as unknown as { readonly default: Html2Canvas }).default;
}

function waitForFrameLoad(frame: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error("图片导出布局超时")),
      15_000,
    );
    frame.addEventListener(
      "load",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("浏览器未能生成 PNG"));
        return;
      }
      void blob.arrayBuffer().then(
        (buffer) => resolve(new Uint8Array(buffer)),
        () => reject(new Error("读取 PNG 数据失败")),
      );
    }, "image/png");
  });
}

function collectKatexCss(): string {
  for (const sheet of document.styleSheets) {
    try {
      const rules = [...sheet.cssRules];
      if (rules.some((rule) => rule.cssText.includes(".katex"))) {
        return rules.map((rule) => rule.cssText).join("\n");
      }
    } catch {
      // Cross-origin stylesheets are not part of the application bundle.
    }
  }
  throw new Error("无法读取 KaTeX 图片导出样式");
}

async function prepareRasterHtml(parsed: Document): Promise<string> {
  const math = [...parsed.body.querySelectorAll<HTMLElement>(".md-math")];
  if (math.length > 0) {
    const { renderKatexHtml } = await import("@mdeditor/renderers/katex");
    const katexStyle = parsed.createElement("style");
    katexStyle.textContent = collectKatexCss();
    parsed.head.append(katexStyle);
    for (const container of math) {
      const source = container.querySelector(
        'annotation[encoding="application/x-tex"]',
      )?.textContent;
      if (source === undefined) throw new Error("图片导出数学公式缺少源标记");
      container.innerHTML = renderKatexHtml(
        source,
        container.classList.contains("md-math-block"),
      );
    }
  }
  parsed.body.style.margin = "0";
  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}

export async function renderSafeHtmlToPng(
  html: string,
  scale: 1 | 2,
): Promise<Uint8Array> {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const style = parsed.head.querySelector("style");
  if (style === null) throw new Error("图片导出需要带样式 HTML");
  for (const image of parsed.body.querySelectorAll<HTMLImageElement>("img")) {
    if (!image.src.startsWith("data:image/")) {
      throw new Error("图片导出不加载远程图片，请先使用工作区本地图片");
    }
  }

  const frame = document.createElement("iframe");
  frame.className = "document-image-frame";
  frame.title = "图片导出布局";
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.style.width = `${imageExportViewportWidth}px`;
  const loaded = waitForFrameLoad(frame);
  frame.srcdoc = await prepareRasterHtml(parsed);
  document.body.append(frame);

  try {
    await loaded;
    const frameDocument = frame.contentDocument;
    if (frameDocument === null) throw new Error("无法读取图片导出布局");
    await Promise.all([...frameDocument.images].map((image) => image.decode()));
    await frameDocument.fonts.ready;
    const body = frameDocument.body;
    const width = Math.ceil(body.getBoundingClientRect().width);
    const height = Math.ceil(
      Math.max(body.scrollHeight, body.getBoundingClientRect().height),
    );
    if (width <= 0 || height <= 0) throw new Error("图片导出布局为空");
    if (height > maximumImageExportHeight) {
      throw new Error(`图片导出高度超过 ${maximumImageExportHeight}px 限制`);
    }
    if (width * height * scale * scale > maximumImageExportPixels) {
      throw new Error("图片导出像素超过 64 MiP 限制");
    }

    const html2canvas = await loadHtml2Canvas();
    const canvas = await html2canvas(body, {
      allowTaint: false,
      backgroundColor: null,
      foreignObjectRendering: false,
      height,
      logging: false,
      scale,
      scrollX: 0,
      scrollY: 0,
      useCORS: false,
      width,
      windowHeight: height,
      windowWidth: imageExportViewportWidth,
    });
    return await canvasToPng(canvas);
  } finally {
    frame.remove();
  }
}
