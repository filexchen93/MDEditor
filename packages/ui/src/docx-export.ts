const supportedEmbeddedImage =
  /^data:image\/(?:avif|gif|jpeg|png|svg\+xml|webp);base64,[a-z0-9+/]+=*$/iu;

export function prepareSafeHtmlForDocx(html: string): Uint8Array {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  if (parsed.querySelector("script, iframe, object, embed") !== null) {
    throw new Error("DOCX 导出正文包含不安全元素");
  }
  for (const image of parsed.body.querySelectorAll("img")) {
    const source = image.getAttribute("src")?.trim() ?? "";
    if (!supportedEmbeddedImage.test(source)) {
      throw new Error(
        "DOCX 导出不读取本地或远程图片，请先使用工作区本地图片完成安全内嵌",
      );
    }
  }
  for (const style of parsed.querySelectorAll("style")) style.remove();
  return new TextEncoder().encode(
    `<!doctype html>\n${parsed.documentElement.outerHTML}`,
  );
}
