import path from "node:path";
import {
  APPLICATION_STATE_VERSION,
  type ApplicationState,
  type ProjectIdentity,
  type ProjectPersonalState,
  type RecentProject,
} from "../../src/project-contracts.js";
import {
  VersionedAtomicJsonStore,
  type AtomicJsonOperationOptions,
  type JsonStoreCodec,
  type JsonStoreReadResult,
} from "./versioned-atomic-json-store.js";

const MAX_RECENT_PROJECTS = 20;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIdentity(value: unknown): value is ProjectIdentity {
  return isObject(value)
    && typeof value.projectId === "string" && value.projectId.length > 0
    && typeof value.instanceKey === "string" && value.instanceKey.length > 0
    && typeof value.canonicalPath === "string"
    && path.isAbsolute(value.canonicalPath);
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function decodePersonalState(value: unknown): ProjectPersonalState {
  if (!isObject(value)) throw new Error("Personal project state must be an object");
  const allowed = new Set(["selectedRuntimeProfile", "lastRoute", "selectedSection"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Personal project state contains an unknown field");
  if (value.selectedRuntimeProfile !== undefined && typeof value.selectedRuntimeProfile !== "string") {
    throw new Error("selectedRuntimeProfile must be a string");
  }
  if (
    value.lastRoute !== undefined
    && (typeof value.lastRoute !== "string" || !value.lastRoute.startsWith("/") || value.lastRoute.startsWith("//"))
  ) {
    throw new Error("lastRoute must be an application-relative route");
  }
  const sections = new Set(["overview", "changes", "components", "design-system", "assets", "routes", "canvas", "servers"]);
  if (value.selectedSection !== undefined && (typeof value.selectedSection !== "string" || !sections.has(value.selectedSection))) {
    throw new Error("selectedSection must be a known project section");
  }
  return {
    ...(typeof value.selectedRuntimeProfile === "string" ? { selectedRuntimeProfile: value.selectedRuntimeProfile } : {}),
    ...(typeof value.lastRoute === "string" ? { lastRoute: value.lastRoute } : {}),
    ...(typeof value.selectedSection === "string" ? { selectedSection: value.selectedSection as ProjectPersonalState["selectedSection"] } : {}),
  };
}

export const applicationStateCodec: JsonStoreCodec<ApplicationState> = {
  createDefault: () => ({
    schemaVersion: APPLICATION_STATE_VERSION,
    recentProjects: [],
    personalStateByInstance: {},
  }),
  decode(value): ApplicationState {
    if (!isObject(value) || value.schemaVersion !== APPLICATION_STATE_VERSION) {
      throw new Error(`Application state must use schema version ${APPLICATION_STATE_VERSION}`);
    }
    const allowed = new Set(["schemaVersion", "recentProjects", "personalStateByInstance"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Application state contains an unknown field");
    if (!Array.isArray(value.recentProjects) || !isObject(value.personalStateByInstance)) {
      throw new Error("Application state collections are invalid");
    }
    const recentProjects = value.recentProjects.map((recent): RecentProject => {
      const entry = isObject(recent) ? recent : null;
      if (!entry || !validIdentity(entry) || typeof entry.displayName !== "string" || !validIsoDate(entry.lastOpenedAt)) {
        throw new Error("Recent project entry is invalid");
      }
      return {
        projectId: entry.projectId,
        instanceKey: entry.instanceKey,
        canonicalPath: entry.canonicalPath,
        displayName: entry.displayName,
        lastOpenedAt: new Date(entry.lastOpenedAt).toISOString(),
      };
    });
    if (new Set(recentProjects.map((recent) => recent.instanceKey)).size !== recentProjects.length) {
      throw new Error("Application state contains duplicate recent project instances");
    }
    const personalStateSource = value.personalStateByInstance;
    const personalStateByInstance = Object.fromEntries(
      Object.keys(personalStateSource).sort().map((instanceKey) => [
        instanceKey,
        decodePersonalState(personalStateSource[instanceKey]),
      ]),
    );
    return { schemaVersion: APPLICATION_STATE_VERSION, recentProjects, personalStateByInstance };
  },
  encode(value): unknown {
    return applicationStateCodec.decode(value);
  },
};

export class ApplicationStateStore {
  private readonly store: VersionedAtomicJsonStore<ApplicationState>;

  constructor(filePath: string) {
    this.store = new VersionedAtomicJsonStore(filePath, applicationStateCodec, { recoverCorruption: true });
  }

  read(): Promise<JsonStoreReadResult<ApplicationState>> {
    return this.store.read();
  }

  async recordRecent(
    identity: ProjectIdentity,
    displayName: string,
    openedAt = new Date(),
    options: AtomicJsonOperationOptions = {},
  ): Promise<ApplicationState> {
    if (!displayName.trim()) throw new Error("Recent project display name must not be empty");
    const timestamp = openedAt.toISOString();
    return this.store.update((state) => ({
      ...state,
      recentProjects: [
        { ...identity, displayName: displayName.trim(), lastOpenedAt: timestamp },
        ...state.recentProjects.filter((recent) => recent.instanceKey !== identity.instanceKey),
      ].slice(0, MAX_RECENT_PROJECTS),
    }), options);
  }

  async removeRecent(instanceKey: string, options: AtomicJsonOperationOptions = {}): Promise<ApplicationState> {
    return this.store.update((state) => ({
      ...state,
      recentProjects: state.recentProjects.filter((recent) => recent.instanceKey !== instanceKey),
    }), options);
  }

  async setPersonalState(
    instanceKey: string,
    personalState: ProjectPersonalState,
    options: AtomicJsonOperationOptions = {},
  ): Promise<ApplicationState> {
    const normalized = decodePersonalState(personalState);
    return this.store.update((state) => ({
      ...state,
      personalStateByInstance: { ...state.personalStateByInstance, [instanceKey]: normalized },
    }), options);
  }
}
