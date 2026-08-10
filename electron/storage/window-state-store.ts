import { VersionedAtomicJsonStore, type JsonStoreCodec, type JsonStoreReadResult } from "./versioned-atomic-json-store.js";

export interface WindowState {
  schemaVersion: 1;
  bounds: { x: number; y: number; width: number; height: number };
  maximized: boolean;
}

function finiteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
}

export const windowStateCodec: JsonStoreCodec<WindowState> = {
  createDefault: () => ({
    schemaVersion: 1,
    bounds: { x: 80, y: 80, width: 1600, height: 980 },
    maximized: false,
  }),
  decode(value): WindowState {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Window state must be an object");
    const candidate = value as Record<string, unknown>;
    if (candidate.schemaVersion !== 1 || typeof candidate.maximized !== "boolean") throw new Error("Window state version is invalid");
    const bounds = candidate.bounds;
    if (typeof bounds !== "object" || bounds === null || Array.isArray(bounds)) throw new Error("Window bounds are invalid");
    const box = bounds as Record<string, unknown>;
    if (![box.x, box.y, box.width, box.height].every(finiteInteger)) throw new Error("Window bounds must be finite integers");
    if (Number(box.width) < 1080 || Number(box.height) < 680 || Number(box.width) > 10_000 || Number(box.height) > 10_000) {
      throw new Error("Window bounds are outside supported limits");
    }
    return {
      schemaVersion: 1,
      bounds: { x: Number(box.x), y: Number(box.y), width: Number(box.width), height: Number(box.height) },
      maximized: candidate.maximized,
    };
  },
  encode(value): unknown {
    return windowStateCodec.decode(value);
  },
};

export class WindowStateStore {
  private readonly store: VersionedAtomicJsonStore<WindowState>;

  constructor(filePath: string) {
    this.store = new VersionedAtomicJsonStore(filePath, windowStateCodec, { recoverCorruption: true });
  }

  read(): Promise<JsonStoreReadResult<WindowState>> {
    return this.store.read();
  }

  write(state: WindowState): Promise<void> {
    return this.store.write(state);
  }
}
