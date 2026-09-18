export const markdownFeatureNames = [
  "commonmark",
  "gfmAutolink",
  "gfmStrikethrough",
  "gfmTable",
  "gfmTaskList",
  "frontMatter",
  "tableOfContents",
  "alerts",
  "footnotes",
  "inlineMath",
  "blockMath",
  "mermaid",
] as const;

export type MarkdownFeature = (typeof markdownFeatureNames)[number];

export interface MarkdownProfile {
  /** Stable profile identifier persisted by future document settings. */
  readonly id: string;
  /** Schema version for the profile object itself. */
  readonly schemaVersion: 1;
  /** Human-readable revision of the syntax contract. */
  readonly revision: string;
  readonly features: Readonly<Record<MarkdownFeature, boolean>>;
}

export type MarkdownFeatureOverrides = Partial<
  Record<MarkdownFeature, boolean>
>;

const defaultFeatures: Readonly<Record<MarkdownFeature, boolean>> =
  Object.freeze({
    commonmark: true,
    gfmAutolink: true,
    gfmStrikethrough: true,
    gfmTable: true,
    gfmTaskList: true,
    frontMatter: true,
    tableOfContents: true,
    alerts: true,
    footnotes: true,
    inlineMath: true,
    blockMath: true,
    mermaid: true,
  });

export const defaultMarkdownProfile: MarkdownProfile = Object.freeze({
  id: "mdeditor-m4",
  schemaVersion: 1,
  revision: "2026-08-31",
  features: defaultFeatures,
});

export function createMarkdownProfile(
  overrides: MarkdownFeatureOverrides = {},
  metadata: Partial<Pick<MarkdownProfile, "id" | "revision">> = {},
): MarkdownProfile {
  return Object.freeze({
    id: metadata.id ?? defaultMarkdownProfile.id,
    schemaVersion: 1,
    revision: metadata.revision ?? defaultMarkdownProfile.revision,
    features: Object.freeze({ ...defaultFeatures, ...overrides }),
  });
}

export function supportsMarkdownFeature(
  profile: MarkdownProfile,
  feature: MarkdownFeature,
): boolean {
  return profile.features[feature];
}
