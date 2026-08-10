export interface CanvasBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LargerCanvasBridge {
  load(url: string): Promise<{ ok: true }>;
  navigate(url: string): Promise<{ ok: true }>;
  setBounds(bounds: CanvasBounds): void;
  hide(): void;
  onNavigation(listener: (url: string) => void): () => void;
}
