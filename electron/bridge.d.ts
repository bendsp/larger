export interface CanvasBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LargerCanvasBridge {
  load(generation: number, surfaceId: string): Promise<{ ok: true }>;
  navigate(generation: number, surfaceId: string, route: string): Promise<{ ok: true }>;
  setBounds(generation: number, bounds: CanvasBounds): void;
  show(generation: number, surfaceId: string): void;
  focus(generation: number, surfaceId: string): void;
  hide(): void;
  onNavigation(listener: (navigation: { generation: number; surfaceId: string; route: string }) => void): () => void;
  onFocusReturn(listener: (navigation: { generation: number; surfaceId: string }) => void): () => void;
}
