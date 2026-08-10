import path from "node:path";
import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

const outputDirectory = path.resolve(".larger/electron");
await mkdir(outputDirectory, { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["electron/main.ts"],
    outfile: path.join(outputDirectory, "main.cjs"),
    format: "cjs",
  }),
  build({
    ...shared,
    entryPoints: ["electron/preload.ts"],
    outfile: path.join(outputDirectory, "preload.cjs"),
    format: "cjs",
  }),
]);
