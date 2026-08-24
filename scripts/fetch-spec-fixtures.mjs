import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = resolve(projectRoot, "tests/fixtures/spec");

const sources = [
  {
    name: "CommonMark 0.31.2",
    url: "https://spec.commonmark.org/0.31.2/spec.json",
    file: "commonmark-0.31.2.json",
    format: "json",
  },
  {
    name: "GitHub Flavored Markdown 0.29.0.gfm.13",
    url: "https://raw.githubusercontent.com/github/cmark-gfm/0.29.0.gfm.13/test/spec.txt",
    file: "gfm-0.29.0.gfm.13.json",
    format: "spec-text",
  },
];

function parseGfmSpec(specification) {
  const lines = specification.split(/\r?\n/);
  const examples = [];
  let section = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading?.[2]) section = heading[2];

    const openingFence = /^(`{10,})\s+example(?:\s+(disabled))?\s*$/.exec(line);
    if (!openingFence?.[1]) continue;

    const fence = openingFence[1];
    const markdown = [];
    const html = [];
    index += 1;
    while (index < lines.length && lines[index] !== ".") {
      markdown.push(lines[index] ?? "");
      index += 1;
    }
    index += 1;
    while (index < lines.length && lines[index] !== fence) {
      html.push(lines[index] ?? "");
      index += 1;
    }

    if (!openingFence[2]) {
      examples.push({
        markdown: `${markdown.join("\n").replaceAll("→", "\t")}\n`,
        html: `${html.join("\n").replaceAll("→", "\t")}\n`,
        example: examples.length + 1,
        section,
      });
    }
  }

  return examples;
}

await mkdir(fixtureDirectory, { recursive: true });

const manifest = [];
for (const source of sources) {
  const response = await fetch(source.url);
  if (!response.ok) {
    throw new Error(
      `Unable to download ${source.name}: HTTP ${response.status}`,
    );
  }

  const body = await response.text();
  const examples =
    source.format === "json" ? JSON.parse(body) : parseGfmSpec(body);
  if (!Array.isArray(examples) || examples.length === 0) {
    throw new Error(`${source.name} did not contain a non-empty example array`);
  }

  await writeFile(
    resolve(fixtureDirectory, source.file),
    `${JSON.stringify(examples, null, 2)}\n`,
  );
  manifest.push({
    ...source,
    examples: examples.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
  process.stdout.write(
    `Imported ${examples.length} examples from ${source.name}.\n`,
  );
}

await writeFile(
  resolve(fixtureDirectory, "manifest.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), sources: manifest }, null, 2)}\n`,
);
