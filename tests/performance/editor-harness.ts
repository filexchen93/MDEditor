import { createSourceEditor } from "../../packages/editor-core/src/index.js";

interface CorpusResult {
  readonly bytes: number;
  readonly hash: string;
  readonly openToEditableMs: number;
  readonly hybridActivationMs: number;
  readonly outlineReadyMs: number;
  readonly outlineItems: number;
  readonly dispatchToPaintP50Ms: number;
  readonly dispatchToPaintP95Ms: number;
  readonly dispatchSyncP95Ms: number;
  readonly paintWaitP95Ms: number;
}

interface EditorBenchmarkResult {
  readonly corpora: readonly CorpusResult[];
  readonly longLine: {
    readonly bytes: number;
    readonly openToEditableMs: number;
  };
  readonly viewportWidgets: {
    readonly totalImages: number;
    readonly initialWidgets: number;
    readonly finalWidgets: number;
  };
  readonly longTasks: {
    readonly count: number;
    readonly totalDurationMs: number;
    readonly longestDurationMs: number;
  };
  readonly breaches: readonly string[];
}

declare global {
  interface Window {
    runMDEditorBenchmark: () => Promise<EditorBenchmarkResult>;
  }
}

const rootElement = document.querySelector<HTMLElement>("#benchmark-root");
if (rootElement === null) throw new Error("Benchmark root is missing.");
const root: HTMLElement = rootElement;
const textEncoder = new TextEncoder();

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function createMarkdown(size: number): string {
  const block = [
    "## 性能基线标题\n",
    "包含 **强调**、[链接](https://example.com) 与 `code` 的中英文段落。🙂\n",
    "> 渐进渲染只派生视图，不修改源码。\n",
    "- [ ] task\n- nested item\n\n",
  ].join("");
  const blockBytes = textEncoder.encode(block).byteLength;
  const completeBlocks = Math.floor(size / blockBytes);
  const remainingBytes = size - completeBlocks * blockBytes;
  return block.repeat(completeBlocks) + "x".repeat(remainingBytes);
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index] ?? 0;
}

async function profileCorpus(bytes: number): Promise<CorpusResult> {
  const text = createMarkdown(bytes);
  const documentLength = text.length;
  root.replaceChildren();

  const startedAt = performance.now();
  const editor = createSourceEditor({ parent: root, text, mode: "source" });
  editor.focus();
  await nextPaint();
  const openToEditableMs = performance.now() - startedAt;

  const hybridStartedAt = performance.now();
  editor.setMode("hybrid");
  await nextPaint();
  const hybridActivationMs = performance.now() - hybridStartedAt;

  const outlineStartedAt = performance.now();
  const outlineItems = await new Promise<number>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      editor.setOutlineListener(null);
      reject(new Error(`Outline did not finish for ${bytes} bytes.`));
    }, 30_000);
    editor.setOutlineListener((items) => {
      window.clearTimeout(timeout);
      editor.setOutlineListener(null);
      resolve(items.length);
    });
  });
  const outlineReadyMs = performance.now() - outlineStartedAt;

  const dispatchDurations: number[] = [];
  const dispatchSyncDurations: number[] = [];
  const paintWaitDurations: number[] = [];
  for (let iteration = 0; iteration < 15; iteration += 1) {
    const dispatchStartedAt = performance.now();
    editor.applyTextChange({
      from: documentLength,
      to: documentLength,
      insert: "x",
    });
    const dispatchedAt = performance.now();
    await nextPaint();
    const paintedAt = performance.now();
    dispatchSyncDurations.push(dispatchedAt - dispatchStartedAt);
    paintWaitDurations.push(paintedAt - dispatchedAt);
    dispatchDurations.push(paintedAt - dispatchStartedAt);
    editor.applyTextChange({
      from: documentLength,
      to: documentLength + 1,
      insert: "",
    });
    await nextPaint();
  }

  const result = {
    bytes,
    hash: await sha256(text),
    openToEditableMs,
    hybridActivationMs,
    outlineReadyMs,
    outlineItems,
    dispatchToPaintP50Ms: percentile(dispatchDurations, 0.5),
    dispatchToPaintP95Ms: percentile(dispatchDurations, 0.95),
    dispatchSyncP95Ms: percentile(dispatchSyncDurations, 0.95),
    paintWaitP95Ms: percentile(paintWaitDurations, 0.95),
  };
  editor.destroy();
  root.replaceChildren();
  return result;
}

async function profileLongLine(bytes: number) {
  root.replaceChildren();
  const unit = "中A";
  const unitBytes = textEncoder.encode(unit).byteLength;
  const text =
    unit.repeat(Math.floor(bytes / unitBytes)) + "x".repeat(bytes % unitBytes);
  const startedAt = performance.now();
  const editor = createSourceEditor({
    parent: root,
    text,
    mode: "source",
    lineWrapping: false,
  });
  editor.focus();
  await nextPaint();
  const result = { bytes, openToEditableMs: performance.now() - startedAt };
  editor.destroy();
  root.replaceChildren();
  return result;
}

async function profileWidgets(totalImages: number) {
  root.replaceChildren();
  const text = Array.from(
    { length: totalImages },
    (_, index) =>
      `![image ${index}](javascript:blocked)\n\nparagraph ${index}\n\n`,
  ).join("");
  const editor = createSourceEditor({ parent: root, text, mode: "hybrid" });
  await nextPaint();

  const countWidgets = () =>
    root.querySelectorAll('[data-md-image-widget="true"]').length;
  const initialWidgets = countWidgets();
  const scroller = root.querySelector<HTMLElement>(".cm-scroller");
  if (scroller === null) throw new Error("Editor scroller is missing.");
  scroller.scrollTop = scroller.scrollHeight;
  scroller.dispatchEvent(new Event("scroll"));
  await nextPaint();
  await nextPaint();
  const finalWidgets = countWidgets();

  editor.destroy();
  root.replaceChildren();
  return { totalImages, initialWidgets, finalWidgets };
}

window.runMDEditorBenchmark = async () => {
  const longTaskDurations: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      longTaskDurations.push(entry.duration);
  });
  observer.observe({ type: "longtask", buffered: true });

  const corpora = [
    await profileCorpus(1024 * 1024),
    await profileCorpus(10 * 1024 * 1024),
  ];
  const longLine = await profileLongLine(1024 * 1024);
  const viewportWidgets = await profileWidgets(1000);
  await nextPaint();
  longTaskDurations.push(
    ...observer.takeRecords().map((entry) => entry.duration),
  );
  observer.disconnect();

  const breaches: string[] = [];
  const [oneMiB, tenMiB] = corpora;
  if (oneMiB !== undefined && oneMiB.openToEditableMs > 3000) {
    breaches.push("1 MiB open-to-editable exceeded 3000 ms");
  }
  if (tenMiB !== undefined && tenMiB.openToEditableMs > 10000) {
    breaches.push("10 MiB open-to-editable exceeded 10000 ms");
  }
  if (oneMiB !== undefined && oneMiB.dispatchToPaintP95Ms > 250) {
    breaches.push("1 MiB dispatch-to-paint P95 exceeded 250 ms");
  }
  if (tenMiB !== undefined && tenMiB.dispatchToPaintP95Ms > 500) {
    breaches.push("10 MiB dispatch-to-paint P95 exceeded 500 ms");
  }
  if (oneMiB !== undefined && oneMiB.outlineReadyMs > 3000) {
    breaches.push("1 MiB outline-ready exceeded 3000 ms");
  }
  if (tenMiB !== undefined && tenMiB.outlineReadyMs > 10000) {
    breaches.push("10 MiB outline-ready exceeded 10000 ms");
  }
  if (
    oneMiB !== undefined &&
    tenMiB !== undefined &&
    (oneMiB.outlineItems === 0 || tenMiB.outlineItems <= oneMiB.outlineItems)
  ) {
    breaches.push("Outline item counts did not scale with the fixed corpora");
  }
  if (longLine.openToEditableMs > 4000) {
    breaches.push("1 MiB long-line open-to-editable exceeded 4000 ms");
  }
  if (
    viewportWidgets.initialWidgets > 100 ||
    viewportWidgets.finalWidgets > 100
  ) {
    breaches.push("Image widgets were not bounded to the viewport");
  }

  return {
    corpora,
    longLine,
    viewportWidgets,
    longTasks: {
      count: longTaskDurations.length,
      totalDurationMs: longTaskDurations.reduce(
        (total, duration) => total + duration,
        0,
      ),
      longestDurationMs: Math.max(0, ...longTaskDurations),
    },
    breaches,
  };
};
