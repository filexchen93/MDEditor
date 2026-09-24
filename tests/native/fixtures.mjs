import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const nativeFileSource =
  "# 原生文件\n\n中文与 emoji 🙂。\n\n- [ ] 保存校验\n";

export function nativeFixturePath(runDirectory) {
  return path.join(runDirectory, "files", "中文 路径", "字节保真.md");
}

export function nativeImagePath(runDirectory) {
  return path.join(runDirectory, "files", "中文 路径", "选择图.png");
}

export function nativeWorkspaceRoot(runDirectory) {
  return path.join(runDirectory, "workspace");
}

export const nativeWorkspaceGuideSource =
  "# 项目指南\n\n请看[下一步](下一步.md)。\n\n![流程图](../assets/%E6%B5%81%E7%A8%8B%20%E5%9B%BE.png)\n";

export const nativeWorkspaceNextSource =
  "# 下一步\n\n唯一路标：数据库迁移方案。\n";

export function nativeWorkspaceNextPath(runDirectory) {
  return path.join(nativeWorkspaceRoot(runDirectory), "中文 指南", "下一步.md");
}

export function encodeNativeFixture(source) {
  return Buffer.from(`\uFEFF${source.replaceAll("\n", "\r\n")}`, "utf8");
}

export function seedNativeFiles(runDirectory) {
  const file = nativeFixturePath(runDirectory);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, encodeNativeFixture(nativeFileSource));
  writeFileSync(
    nativeImagePath(runDirectory),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlwsAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const workspace = nativeWorkspaceRoot(runDirectory);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    path.join(workspace, "可访问性.md"),
    "# 工作区验收\n\n可通过全局搜索找到的内容。\n",
  );
  const guideDirectory = path.join(workspace, "中文 指南");
  mkdirSync(guideDirectory, { recursive: true });
  writeFileSync(
    path.join(guideDirectory, "开始.md"),
    nativeWorkspaceGuideSource,
  );
  writeFileSync(
    nativeWorkspaceNextPath(runDirectory),
    nativeWorkspaceNextSource,
  );
  const assetsDirectory = path.join(workspace, "assets");
  mkdirSync(assetsDirectory, { recursive: true });
  writeFileSync(
    path.join(assetsDirectory, "流程 图.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlwsAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const stateDirectory = path.join(runDirectory, "app-data", "state");
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(
    path.join(stateDirectory, "recent.json"),
    JSON.stringify([file]),
  );
}
