export const PLUGIN_API_VERSION = 1 as const;

export const PLUGIN_PERMISSIONS = ["document:read", "document:edit"] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export interface PluginManifest {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly entry: string;
  readonly permissions: readonly PluginPermission[];
}

export interface PluginGrant {
  readonly pluginId: string;
  readonly permissions: readonly PluginPermission[];
}

export interface PluginDocumentSnapshot {
  readonly id: string;
  readonly path: string | null;
  readonly text: string;
  readonly revision: number;
  readonly readOnly: boolean;
}

export interface PluginTextEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface PluginEditRequest {
  readonly expectedRevision: number;
  readonly edits: readonly PluginTextEdit[];
}

export interface PluginHostCapabilities {
  readonly readActiveDocument: () => Promise<PluginDocumentSnapshot | null>;
  readonly applyDocumentEdits: (
    request: PluginEditRequest,
  ) => Promise<PluginDocumentSnapshot>;
}

export interface PluginDocumentApi {
  readonly readActive?: () => Promise<PluginDocumentSnapshot | null>;
  readonly applyEdits?: (
    request: PluginEditRequest,
  ) => Promise<PluginDocumentSnapshot>;
}

export interface PluginHostApi {
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly plugin: Readonly<Pick<PluginManifest, "id" | "name" | "version">>;
  readonly permissions: readonly PluginPermission[];
  readonly document: PluginDocumentApi;
}

export class PluginValidationError extends Error {
  override readonly name = "PluginValidationError";
}

export class PluginPermissionError extends Error {
  override readonly name = "PluginPermissionError";

  constructor(
    readonly pluginId: string,
    readonly permission: PluginPermission,
  ) {
    super(`Plugin ${pluginId} is not granted ${permission}`);
  }
}

const manifestKeys = new Set([
  "manifestVersion",
  "id",
  "name",
  "version",
  "entry",
  "permissions",
]);
const permissionSet = new Set<string>(PLUGIN_PERMISSIONS);
const semanticVersionPattern = new RegExp(
  "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)" +
    "(?:-(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)" +
    "(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*)?" +
    "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
  "u",
);
const pluginIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const maximumEditCount = 1_000;
const maximumInsertedCharacters = 1_048_576;

function validationError(message: string): never {
  throw new PluginValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (typeof value !== "string") validationError(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    validationError(`${field} must contain 1-${maximumLength} characters`);
  }
  return normalized;
}

function parsePermissions(value: unknown): readonly PluginPermission[] {
  if (!Array.isArray(value)) validationError("permissions must be an array");
  const parsed: PluginPermission[] = [];
  const seen = new Set<PluginPermission>();
  for (const candidate of value) {
    if (typeof candidate !== "string" || !permissionSet.has(candidate)) {
      validationError(`Unknown plugin permission: ${String(candidate)}`);
    }
    const permission = candidate as PluginPermission;
    if (seen.has(permission)) {
      validationError(`Duplicate plugin permission: ${permission}`);
    }
    seen.add(permission);
    parsed.push(permission);
  }
  return Object.freeze(parsed);
}

function parseEntry(value: unknown): string {
  const entry = requireString(value, "entry", 240);
  const segments = entry.split("/");
  if (
    entry.includes("\\") ||
    entry.includes(":") ||
    entry.startsWith("/") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ) ||
    !/\.(?:js|mjs)$/u.test(entry)
  ) {
    validationError("entry must be a relative JavaScript module path");
  }
  return entry;
}

export function parsePluginManifest(value: unknown): PluginManifest {
  if (!isRecord(value)) validationError("Plugin manifest must be an object");
  for (const key of Object.keys(value)) {
    if (!manifestKeys.has(key))
      validationError(`Unknown manifest field: ${key}`);
  }
  if (value.manifestVersion !== PLUGIN_API_VERSION) {
    validationError(`manifestVersion must be ${PLUGIN_API_VERSION}`);
  }

  const id = requireString(value.id, "id", 100);
  if (!pluginIdPattern.test(id)) {
    validationError("id must be a lowercase, dot-separated plugin identifier");
  }
  const name = requireString(value.name, "name", 80);
  const version = requireString(value.version, "version", 80);
  if (!semanticVersionPattern.test(version)) {
    validationError("version must be a valid semantic version");
  }

  return Object.freeze({
    manifestVersion: PLUGIN_API_VERSION,
    id,
    name,
    version,
    entry: parseEntry(value.entry),
    permissions: parsePermissions(value.permissions),
  });
}

export function createPluginGrant(
  manifestValue: PluginManifest,
  grantedPermissions: readonly PluginPermission[],
): PluginGrant {
  const manifest = parsePluginManifest(manifestValue);
  const permissions = parsePermissions(grantedPermissions);
  for (const permission of permissions) {
    if (!manifest.permissions.includes(permission)) {
      validationError(
        `Cannot grant undeclared permission ${permission} to ${manifest.id}`,
      );
    }
  }
  return Object.freeze({ pluginId: manifest.id, permissions });
}

export function requirePluginPermission(
  manifest: PluginManifest,
  grant: PluginGrant,
  permission: PluginPermission,
): void {
  if (
    grant.pluginId !== manifest.id ||
    !manifest.permissions.includes(permission) ||
    !grant.permissions.includes(permission)
  ) {
    throw new PluginPermissionError(manifest.id, permission);
  }
}

function freezeSnapshot(
  snapshot: PluginDocumentSnapshot | null,
): PluginDocumentSnapshot | null {
  if (snapshot === null) return null;
  if (
    typeof snapshot.id !== "string" ||
    snapshot.id.length === 0 ||
    (snapshot.path !== null && typeof snapshot.path !== "string") ||
    typeof snapshot.text !== "string" ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    typeof snapshot.readOnly !== "boolean"
  ) {
    validationError("Host returned an invalid document snapshot");
  }
  return Object.freeze({
    id: snapshot.id,
    path: snapshot.path,
    text: snapshot.text,
    revision: snapshot.revision,
    readOnly: snapshot.readOnly,
  });
}

function validateEditRequest(request: PluginEditRequest): PluginEditRequest {
  if (
    !isRecord(request) ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0 ||
    !Array.isArray(request.edits) ||
    request.edits.length === 0 ||
    request.edits.length > maximumEditCount
  ) {
    validationError("Invalid plugin edit request");
  }

  const edits: PluginTextEdit[] = [];
  let previousTo = 0;
  let insertedCharacters = 0;
  for (const [index, edit] of request.edits.entries()) {
    const from = isRecord(edit) ? edit.from : undefined;
    const to = isRecord(edit) ? edit.to : undefined;
    if (
      !isRecord(edit) ||
      typeof from !== "number" ||
      typeof to !== "number" ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < previousTo ||
      from < 0 ||
      to < from ||
      typeof edit.insert !== "string"
    ) {
      validationError(`Invalid or overlapping text edit at index ${index}`);
    }
    insertedCharacters += edit.insert.length;
    if (insertedCharacters > maximumInsertedCharacters) {
      validationError("Plugin edit request inserts too much text");
    }
    previousTo = to;
    edits.push(
      Object.freeze({
        from,
        to,
        insert: edit.insert,
      }),
    );
  }

  return Object.freeze({
    expectedRevision: request.expectedRevision,
    edits: Object.freeze(edits),
  });
}

export function createPluginHostApi(
  manifestValue: PluginManifest,
  grantValue: PluginGrant,
  capabilities: PluginHostCapabilities,
): PluginHostApi {
  const manifest = parsePluginManifest(manifestValue);
  const grant = createPluginGrant(manifest, grantValue.permissions);
  if (grantValue.pluginId !== manifest.id) {
    validationError("Plugin grant does not match the manifest id");
  }

  const document: {
    readActive?: () => Promise<PluginDocumentSnapshot | null>;
    applyEdits?: (
      request: PluginEditRequest,
    ) => Promise<PluginDocumentSnapshot>;
  } = {};

  if (grant.permissions.includes("document:read")) {
    document.readActive = async () =>
      freezeSnapshot(await capabilities.readActiveDocument());
  }
  if (grant.permissions.includes("document:edit")) {
    document.applyEdits = async (request) => {
      const snapshot = await capabilities.applyDocumentEdits(
        validateEditRequest(request),
      );
      return freezeSnapshot(snapshot) as PluginDocumentSnapshot;
    };
  }

  return Object.freeze({
    apiVersion: PLUGIN_API_VERSION,
    plugin: Object.freeze({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
    }),
    permissions: grant.permissions,
    document: Object.freeze(document),
  });
}
