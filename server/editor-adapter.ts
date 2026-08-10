import type { EditorAdapterDescriptor, EditorSurface } from "../src/contracts.js";

export interface EditorStartInput {
  workspaceRoot: string;
  target: {
    url: string;
  };
}

export type EditorAdapterEvent =
  | { type: "log"; message: string }
  | { type: "exit"; code: number | null; signal: string | null };

export type EditorAdapterEventHandler = (event: EditorAdapterEvent) => void;

export interface EditorAdapter {
  readonly descriptor: EditorAdapterDescriptor;
  start(input: EditorStartInput): Promise<EditorSurface>;
  stop(): Promise<void>;
}

export type EditorAdapterFactory = (emit: EditorAdapterEventHandler) => EditorAdapter;
