import { ReactRewriteAdapter } from "./adapters/react-rewrite.js";
import type { EditorAdapterFactory } from "./editor-adapter.js";

const factories: Record<string, EditorAdapterFactory> = {
  "react-rewrite": (emit) => new ReactRewriteAdapter(emit),
};

export function resolveEditorAdapter(adapterId: string): EditorAdapterFactory {
  const factory = factories[adapterId];
  if (!factory) {
    throw new Error(
      `Unsupported editor adapter "${adapterId}". Available adapters: ${Object.keys(factories).join(", ")}`,
    );
  }
  return factory;
}
