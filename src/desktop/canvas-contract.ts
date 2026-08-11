import { z } from "zod";

export const CANVAS_IPC_CHANNELS = {
  navigated: "canvas:navigated",
  focusReturn: "canvas:focus-return",
  load: "canvas:load",
  navigate: "canvas:navigate",
  bounds: "canvas:bounds",
  show: "canvas:show",
  focus: "canvas:focus",
  hide: "canvas:hide",
} as const;

const generationSchema = z.number().int().nonnegative();
const surfaceIdSchema = z.string().min(1).max(256);
export const canvasBoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
}).strict();
export const canvasRouteSchema = z.string().startsWith("/").max(2048)
  .refine((route) => !route.startsWith("//") && !route.includes("\\"), {
    message: "route must be project-relative",
  });

export const canvasSurfaceInputSchema = z.object({
  generation: generationSchema,
  surfaceId: surfaceIdSchema,
}).strict();
export const canvasNavigateInputSchema = canvasSurfaceInputSchema.extend({ route: canvasRouteSchema }).strict();
export const canvasBoundsInputSchema = canvasSurfaceInputSchema.extend({ bounds: canvasBoundsSchema }).strict();
export const canvasAckSchema = z.object({ ok: z.literal(true) }).strict();
export const canvasNavigationSchema = canvasNavigateInputSchema;
export const canvasFocusReturnSchema = canvasSurfaceInputSchema;

export type CanvasBounds = z.infer<typeof canvasBoundsSchema>;
export type CanvasNavigation = z.infer<typeof canvasNavigationSchema>;
export type CanvasFocusReturn = z.infer<typeof canvasFocusReturnSchema>;

export interface LargerCanvasBridge {
  load(generation: number, surfaceId: string): Promise<{ ok: true }>;
  navigate(generation: number, surfaceId: string, route: string): Promise<{ ok: true }>;
  setBounds(generation: number, surfaceId: string, bounds: CanvasBounds): void;
  show(generation: number, surfaceId: string): void;
  focus(generation: number, surfaceId: string): void;
  hide(generation: number, surfaceId: string): void;
  onNavigation(listener: (navigation: CanvasNavigation) => void): () => void;
  onFocusReturn(listener: (navigation: CanvasFocusReturn) => void): () => void;
}
