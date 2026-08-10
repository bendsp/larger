export interface CanvasBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LargerCanvasBridge {
  load(generation: number, url: string): Promise<{ ok: true }>;
  navigate(generation: number, url: string): Promise<{ ok: true }>;
  setBounds(generation: number, bounds: CanvasBounds): void;
  show(generation: number): void;
  hide(): void;
  onNavigation(listener: (navigation: { generation: number; url: string }) => void): () => void;
}
