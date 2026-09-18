import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(packageRoot, "dist", "dictionaries");

await mkdir(outputDirectory, { recursive: true });

await Promise.all(
  [
    ["dictionary-en", "en-US"],
    ["dictionary-en-gb", "en-GB"],
  ].flatMap(([packageName, language]) =>
    ["aff", "dic"].map((extension) =>
      copyFile(
        resolve(packageRoot, "node_modules", packageName, `index.${extension}`),
        resolve(outputDirectory, `${language}.${extension}`),
      ),
    ),
  ),
);
