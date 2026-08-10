import path from "node:path";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import {
  PROJECT_MANIFEST_VERSION,
  type ManifestFieldError,
  type ProjectManifest,
  type RuntimeProfile,
} from "../../src/project-contracts.js";

export const PROJECT_MANIFEST_RELATIVE_PATH = path.join(".larger", "project.json");
const MAX_PROJECT_MANIFEST_BYTES = 256_000;

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SECRET_ARGUMENT_PATTERN = /^[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*=/i;
const SECRET_FLAG_PATTERN = /^--?(?:token|secret|password|passwd|api[-_]?key|private[-_]?key)(?:=|$)/i;
const TOP_LEVEL_FIELDS = new Set(["$schema", "schemaVersion", "projectId", "name", "defaultRuntimeProfile", "runtimeProfiles"]);
const PROFILE_FIELDS = new Set(["command", "workingDirectory", "host", "preferredPort", "entryRoute", "editorAdapter"]);

export type ManifestMigration = (manifest: Record<string, unknown>) => Record<string, unknown>;
export type ManifestMigrations = Readonly<Record<number, ManifestMigration>>;

export class ProjectManifestValidationError extends Error {
  readonly errors: ManifestFieldError[];

  constructor(errors: ManifestFieldError[]) {
    super(errors.map((error) => `${error.path}: ${error.message}`).join("; "));
    this.name = "ProjectManifestValidationError";
    this.errors = errors;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(
  errors: ManifestFieldError[],
  path: string,
  code: ManifestFieldError["code"],
  message: string,
): void {
  errors.push({ path, code, message });
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  basePath: string,
  errors: ManifestFieldError[],
): void {
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key)) {
      error(errors, `${basePath}/${key}`, "unknown_field", "field is not part of this manifest version");
    }
  }
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  basePath: string,
  errors: ManifestFieldError[],
): string | null {
  const candidate = value[key];
  const path = `${basePath}/${key}`;
  if (candidate === undefined) {
    error(errors, path, "missing", "field is required");
    return null;
  }
  if (typeof candidate !== "string") {
    error(errors, path, "invalid_type", "must be a string");
    return null;
  }
  const normalized = candidate.trim();
  if (!normalized) {
    error(errors, path, "invalid_value", "must not be empty");
    return null;
  }
  return normalized;
}

function normalizeRelativePath(value: string, fieldPath: string, errors: ManifestFieldError[]): string | null {
  const segments = value.split("/");
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    segments.some((segment, index) => segment === ".." || (segment === "" && index > 0 && index < segments.length - 1))
  ) {
    error(errors, fieldPath, "invalid_value", "must be a project-relative path without parent traversal");
    return null;
  }
  const normalized = path.posix.normalize(value).replace(/\/$/, "");
  return normalized || ".";
}

function normalizeProfile(
  value: unknown,
  basePath: string,
  errors: ManifestFieldError[],
): RuntimeProfile | null {
  if (!isObject(value)) {
    error(errors, basePath, "invalid_type", "must be an object");
    return null;
  }
  rejectUnknownFields(value, PROFILE_FIELDS, basePath, errors);

  const commandValue = value.command;
  let command: string[] | null = null;
  if (commandValue === undefined) {
    error(errors, `${basePath}/command`, "missing", "field is required");
  } else if (!Array.isArray(commandValue)) {
    error(errors, `${basePath}/command`, "invalid_type", "must be an array of command arguments");
  } else if (commandValue.length === 0) {
    error(errors, `${basePath}/command`, "invalid_value", "must contain an executable");
  } else {
    const normalized: string[] = [];
    commandValue.forEach((argument, index) => {
      const argumentPath = `${basePath}/command/${index}`;
      if (typeof argument !== "string") {
        error(errors, argumentPath, "invalid_type", "must be a string");
      } else if (!argument.trim()) {
        error(errors, argumentPath, "invalid_value", "must not be empty");
      } else if (SECRET_ARGUMENT_PATTERN.test(argument) || SECRET_FLAG_PATTERN.test(argument)) {
        error(errors, argumentPath, "invalid_value", "must not contain an inline secret; use the process environment at launch time");
      } else {
        normalized.push(argument);
      }
    });
    if (normalized.length === commandValue.length && normalized.length > 0) command = normalized;
  }

  const workingDirectoryValue = requiredString(value, "workingDirectory", basePath, errors);
  const workingDirectory = workingDirectoryValue === null
    ? null
    : normalizeRelativePath(workingDirectoryValue, `${basePath}/workingDirectory`, errors);
  const hostValue = requiredString(value, "host", basePath, errors);
  const host = hostValue === "127.0.0.1" || hostValue === "localhost" ? hostValue : null;
  if (hostValue !== null && host === null) {
    error(errors, `${basePath}/host`, "invalid_value", "must be a loopback host");
  }

  const portValue = value.preferredPort;
  const preferredPort = Number.isInteger(portValue) && Number(portValue) >= 1024 && Number(portValue) <= 65_535
    ? Number(portValue)
    : null;
  if (portValue === undefined) {
    error(errors, `${basePath}/preferredPort`, "missing", "field is required");
  } else if (preferredPort === null) {
    error(errors, `${basePath}/preferredPort`, "invalid_value", "must be an integer between 1024 and 65535");
  }

  const entryRoute = requiredString(value, "entryRoute", basePath, errors);
  if (entryRoute !== null && (!entryRoute.startsWith("/") || entryRoute.startsWith("//"))) {
    error(errors, `${basePath}/entryRoute`, "invalid_value", "must be an application-relative route beginning with one slash");
  }
  const editorAdapter = requiredString(value, "editorAdapter", basePath, errors);

  if (command === null || workingDirectory === null || host === null || preferredPort === null || entryRoute === null || editorAdapter === null) {
    return null;
  }
  return { command, workingDirectory, host, preferredPort, entryRoute, editorAdapter };
}

export function runSequentialManifestMigrations(
  input: Record<string, unknown>,
  migrations: ManifestMigrations = {},
): Record<string, unknown> {
  let current = { ...input };
  const initialVersion = current.schemaVersion;
  if (initialVersion === undefined) {
    throw new ProjectManifestValidationError([
      { path: "/schemaVersion", code: "missing", message: "field is required" },
    ]);
  }
  if (!Number.isInteger(initialVersion) || Number(initialVersion) < 0) {
    throw new ProjectManifestValidationError([
      { path: "/schemaVersion", code: "unsupported_version", message: "must be a non-negative integer schema version" },
    ]);
  }
  if (Number(initialVersion) > PROJECT_MANIFEST_VERSION) {
    throw new ProjectManifestValidationError([
      { path: "/schemaVersion", code: "unsupported_version", message: `version ${String(initialVersion)} is newer than supported version ${PROJECT_MANIFEST_VERSION}` },
    ]);
  }

  while (Number(current.schemaVersion) < PROJECT_MANIFEST_VERSION) {
    const version = Number(current.schemaVersion);
    const migration = migrations[version];
    if (!migration) {
      throw new ProjectManifestValidationError([
        { path: "/schemaVersion", code: "unsupported_version", message: `no migration is registered from version ${version}` },
      ]);
    }
    const migrated = migration({ ...current });
    if (!isObject(migrated) || migrated.schemaVersion !== version + 1) {
      throw new ProjectManifestValidationError([
        { path: "/schemaVersion", code: "invalid_value", message: `migration from version ${version} must produce version ${version + 1}` },
      ]);
    }
    current = migrated;
  }
  return current;
}

export function normalizeProjectManifest(input: unknown, migrations: ManifestMigrations = {}): ProjectManifest {
  if (!isObject(input)) {
    throw new ProjectManifestValidationError([
      { path: "/", code: "invalid_type", message: "manifest must be an object" },
    ]);
  }
  const migrated = runSequentialManifestMigrations(input, migrations);
  const errors: ManifestFieldError[] = [];
  rejectUnknownFields(migrated, TOP_LEVEL_FIELDS, "", errors);
  if (migrated.$schema !== undefined && typeof migrated.$schema !== "string") {
    error(errors, "/$schema", "invalid_type", "must be a string");
  } else if (typeof migrated.$schema === "string" && !migrated.$schema.trim()) {
    error(errors, "/$schema", "invalid_value", "must not be empty");
  }

  const projectId = requiredString(migrated, "projectId", "", errors);
  if (projectId !== null && !PROJECT_ID_PATTERN.test(projectId)) {
    error(errors, "/projectId", "invalid_value", "must be 3-128 letters, numbers, dots, underscores, or hyphens");
  }
  const name = requiredString(migrated, "name", "", errors);
  const defaultRuntimeProfile = requiredString(migrated, "defaultRuntimeProfile", "", errors);
  if (defaultRuntimeProfile !== null && !PROFILE_NAME_PATTERN.test(defaultRuntimeProfile)) {
    error(errors, "/defaultRuntimeProfile", "invalid_value", "must be a valid profile name");
  }

  const runtimeProfilesValue = migrated.runtimeProfiles;
  const runtimeProfiles: Record<string, RuntimeProfile> = {};
  if (runtimeProfilesValue === undefined) {
    error(errors, "/runtimeProfiles", "missing", "field is required");
  } else if (!isObject(runtimeProfilesValue)) {
    error(errors, "/runtimeProfiles", "invalid_type", "must be an object keyed by profile name");
  } else if (Object.keys(runtimeProfilesValue).length === 0) {
    error(errors, "/runtimeProfiles", "invalid_value", "must define at least one runtime profile");
  } else {
    for (const profileName of Object.keys(runtimeProfilesValue).sort()) {
      if (!PROFILE_NAME_PATTERN.test(profileName)) {
        error(errors, `/runtimeProfiles/${profileName}`, "invalid_value", "profile name is invalid");
        continue;
      }
      const profile = normalizeProfile(runtimeProfilesValue[profileName], `/runtimeProfiles/${profileName}`, errors);
      if (profile) runtimeProfiles[profileName] = profile;
    }
  }
  if (defaultRuntimeProfile !== null && isObject(runtimeProfilesValue) && !(defaultRuntimeProfile in runtimeProfilesValue)) {
    error(errors, "/defaultRuntimeProfile", "invalid_value", "must name an existing runtime profile");
  }

  if (errors.length > 0 || projectId === null || name === null || defaultRuntimeProfile === null) {
    throw new ProjectManifestValidationError(errors);
  }
  return {
    ...(typeof migrated.$schema === "string" ? { $schema: migrated.$schema.trim() } : {}),
    schemaVersion: PROJECT_MANIFEST_VERSION,
    projectId,
    name,
    defaultRuntimeProfile,
    runtimeProfiles,
  };
}

export function parseProjectManifest(text: string, migrations: ManifestMigrations = {}): ProjectManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "invalid JSON";
    throw new ProjectManifestValidationError([{ path: "/", code: "invalid_json", message }]);
  }
  return normalizeProjectManifest(parsed, migrations);
}

export async function resolveProjectManifestPath(projectRoot: string): Promise<string> {
  const canonicalRoot = await realpath(path.resolve(projectRoot));
  const requestedPath = path.join(canonicalRoot, PROJECT_MANIFEST_RELATIVE_PATH);
  await lstat(requestedPath);
  const resolvedPath = await realpath(requestedPath);
  const relative = path.relative(canonicalRoot, resolvedPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Project manifest resolves outside the project root");
  }
  return resolvedPath;
}

export async function readProjectManifest(projectRoot: string, migrations: ManifestMigrations = {}): Promise<ProjectManifest> {
  const manifestPath = await resolveProjectManifestPath(projectRoot);
  const metadata = await stat(manifestPath);
  if (!metadata.isFile()) throw new Error("Project manifest must be a regular file");
  if (metadata.size > MAX_PROJECT_MANIFEST_BYTES) throw new Error(`Project manifest exceeds ${MAX_PROJECT_MANIFEST_BYTES} bytes`);
  const text = await readFile(manifestPath, "utf8");
  const confirmedPath = await resolveProjectManifestPath(projectRoot);
  if (confirmedPath !== manifestPath) throw new Error("Project manifest path changed during inspection");
  return parseProjectManifest(text, migrations);
}

export function serializeProjectManifest(manifest: ProjectManifest): string {
  const normalized = normalizeProjectManifest(manifest);
  const runtimeProfiles = Object.fromEntries(
    Object.keys(normalized.runtimeProfiles).sort().map((name) => {
      const profile = normalized.runtimeProfiles[name]!;
      return [name, {
        command: [...profile.command],
        workingDirectory: profile.workingDirectory,
        host: profile.host,
        preferredPort: profile.preferredPort,
        entryRoute: profile.entryRoute,
        editorAdapter: profile.editorAdapter,
      }];
    }),
  );
  return `${JSON.stringify({
    ...(normalized.$schema ? { $schema: normalized.$schema } : {}),
    schemaVersion: normalized.schemaVersion,
    projectId: normalized.projectId,
    name: normalized.name,
    defaultRuntimeProfile: normalized.defaultRuntimeProfile,
    runtimeProfiles,
  }, null, 2)}\n`;
}
