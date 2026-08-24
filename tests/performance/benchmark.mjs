import { performance } from "node:perf_hooks";
import process from "node:process";

const sizes = [1, 10].map((megabytes) => megabytes * 1024 * 1024);
const textEncoder = new TextEncoder();

function createMarkdown(size) {
  const block = [
    "## 性能基线标题\n",
    "包含 **强调**、[链接](https://example.com) 与 `code` 的中英文段落。🙂\n",
    "- [ ] task\n- nested item\n\n",
  ].join("");
  const blockBytes = textEncoder.encode(block).byteLength;
  const completeBlocks = Math.floor(size / blockBytes);
  return block.repeat(completeBlocks) + "x".repeat(size % blockBytes);
}

for (const size of sizes) {
  const start = performance.now();
  const document = createMarkdown(size);
  const created = performance.now();
  let newlines = 0;
  for (let index = 0; index < document.length; index += 1) {
    if (document.charCodeAt(index) === 10) newlines += 1;
  }
  const scanned = performance.now();

  process.stdout.write(
    `${(size / 1024 / 1024).toFixed(0)} MiB: generate ${(created - start).toFixed(2)} ms, ` +
      `scan ${(scanned - created).toFixed(2)} ms, ${newlines} newlines\n`,
  );
}

process.stdout.write(
  "Corpus generation and scan preflight complete; browser editor measurements follow.\n",
);
