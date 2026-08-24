import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface SpecExample {
  readonly markdown: string;
  readonly html: string;
  readonly example: number;
}

const fixtureFiles = [
  new URL("../fixtures/spec/commonmark-0.31.2.json", import.meta.url),
  new URL("../fixtures/spec/gfm-0.29.0.gfm.13.json", import.meta.url),
];

describe("official Markdown fixture corpus", () => {
  it.each(fixtureFiles)(
    "contains structured examples in %s",
    async (fixtureUrl) => {
      const examples = JSON.parse(
        await readFile(fixtureUrl, "utf8"),
      ) as SpecExample[];

      expect(examples.length).toBeGreaterThan(600);
      const firstExample = examples[0];
      expect(firstExample).toBeDefined();
      expect(typeof firstExample?.markdown).toBe("string");
      expect(typeof firstExample?.html).toBe("string");
      expect(typeof firstExample?.example).toBe("number");
    },
  );
});
