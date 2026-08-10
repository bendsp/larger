import path from "node:path";
import {
  PROJECT_TRUST_STORE_VERSION,
  type ProjectIdentity,
  type ProjectTrustRecord,
  type ProjectTrustState,
} from "../../src/project-contracts.js";
import { VersionedAtomicJsonStore, type JsonStoreCodec, type JsonStoreReadResult } from "../storage/versioned-atomic-json-store.js";
import { projectInstanceKey, sameProjectInstance } from "./project-identity.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertIdentity(identity: ProjectIdentity): void {
  if (!path.isAbsolute(identity.canonicalPath)) throw new Error("Trust identity path must be absolute");
  if (projectInstanceKey(identity.projectId, identity.canonicalPath) !== identity.instanceKey) {
    throw new Error("Trust identity instance key does not match its project and canonical path");
  }
}

function decodeRecord(value: unknown): ProjectTrustRecord {
  if (!isObject(value)) throw new Error("Trust record must be an object");
  const allowed = new Set(["projectId", "instanceKey", "canonicalPath", "decision", "createdAt", "updatedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Trust record contains an unknown field");
  if (
    typeof value.projectId !== "string"
    || typeof value.instanceKey !== "string"
    || typeof value.canonicalPath !== "string"
    || (value.decision !== "trusted" && value.decision !== "denied")
    || typeof value.createdAt !== "string"
    || typeof value.updatedAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new Error("Trust record fields are invalid");
  }
  const record: ProjectTrustRecord = {
    projectId: value.projectId,
    instanceKey: value.instanceKey,
    canonicalPath: value.canonicalPath,
    decision: value.decision,
    createdAt: new Date(value.createdAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
  assertIdentity(record);
  return record;
}

export const projectTrustCodec: JsonStoreCodec<ProjectTrustState> = {
  createDefault: () => ({ schemaVersion: PROJECT_TRUST_STORE_VERSION, records: [] }),
  decode(value): ProjectTrustState {
    if (!isObject(value) || value.schemaVersion !== PROJECT_TRUST_STORE_VERSION || !Array.isArray(value.records)) {
      throw new Error(`Project trust store must use schema version ${PROJECT_TRUST_STORE_VERSION}`);
    }
    const allowed = new Set(["schemaVersion", "records"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Project trust store contains an unknown field");
    const records = value.records.map(decodeRecord);
    if (new Set(records.map((record) => record.instanceKey)).size !== records.length) {
      throw new Error("Project trust store contains duplicate instances");
    }
    return { schemaVersion: PROJECT_TRUST_STORE_VERSION, records };
  },
  encode(value): unknown {
    const decoded = projectTrustCodec.decode(value);
    return {
      ...decoded,
      records: [...decoded.records].sort((left, right) => left.instanceKey.localeCompare(right.instanceKey)),
    };
  },
};

export class ProjectTrustStore {
  private readonly store: VersionedAtomicJsonStore<ProjectTrustState>;

  constructor(filePath: string) {
    this.store = new VersionedAtomicJsonStore(filePath, projectTrustCodec, { recoverCorruption: true });
  }

  read(): Promise<JsonStoreReadResult<ProjectTrustState>> {
    return this.store.read();
  }

  async decisionFor(identity: ProjectIdentity): Promise<ProjectTrustRecord["decision"] | null> {
    assertIdentity(identity);
    const state = (await this.store.read()).value;
    return state.records.find((record) => sameProjectInstance(record, identity))?.decision ?? null;
  }

  async setDecision(
    identity: ProjectIdentity,
    decision: ProjectTrustRecord["decision"],
    now = new Date(),
  ): Promise<ProjectTrustRecord> {
    assertIdentity(identity);
    const timestamp = now.toISOString();
    let saved: ProjectTrustRecord | undefined;
    await this.store.update((state) => {
      const existing = state.records.find((record) => sameProjectInstance(record, identity));
      saved = {
        ...identity,
        decision,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      return {
        ...state,
        records: [saved, ...state.records.filter((record) => record.instanceKey !== identity.instanceKey)],
      };
    });
    return saved as ProjectTrustRecord;
  }

  async revoke(identity: ProjectIdentity): Promise<boolean> {
    assertIdentity(identity);
    let removed = false;
    await this.store.update((state) => {
      const records = state.records.filter((record) => !sameProjectInstance(record, identity));
      removed = records.length !== state.records.length;
      return { ...state, records };
    });
    return removed;
  }
}
