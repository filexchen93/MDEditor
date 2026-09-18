import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(
  repositoryRoot,
  ".playwright-browsers",
);

const [{ chromium }, { createServer }] = await Promise.all([
  import("@playwright/test"),
  import("vite"),
]);

let revision = "uncommitted";
try {
  revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // A new repository without an initial commit is still benchmarkable.
}

const server = await createServer({
  root: repositoryRoot,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
});
let browser;

try {
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error("Vite did not expose a local URL.");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  await page.goto(new URL("tests/performance/editor-harness.html", url).href, {
    timeout: 90_000,
  });
  await page.waitForFunction(
    () => typeof globalThis.runMDEditorBenchmark === "function",
  );
  const result = await page.evaluate(() => globalThis.runMDEditorBenchmark());
  const report = {
    capturedAt: new Date().toISOString(),
    revision,
    mode: "Vite development harness in headless Chromium",
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpus: os.cpus().length,
    node: process.version,
    result,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (result.breaches.length > 0) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
