import assert from "node:assert/strict";
import test from "node:test";
import { resolveCanvasNavigation } from "./canvas-security.js";

test("canvas navigation resolves only project-relative routes on the active origin", () => {
  assert.equal(
    resolveCanvasNavigation("http://127.0.0.1:3000/", "http://127.0.0.1:3000", "/work?view=grid#top"),
    "http://127.0.0.1:3000/work?view=grid#top",
  );
  assert.throws(
    () => resolveCanvasNavigation("http://127.0.0.1:3000/", "http://127.0.0.1:3000", "/\\example.com"),
    /safe project-relative route/,
  );
  assert.throws(
    () => resolveCanvasNavigation("http://127.0.0.1:3000/", "http://127.0.0.1:3001", "/work"),
    /active project origin/,
  );
});
