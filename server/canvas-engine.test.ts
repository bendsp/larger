import assert from "node:assert/strict";
import test from "node:test";
import { LineBuffer, parseReactRewriteOutput, stripAnsi } from "./canvas-engine.js";

test("strips terminal color codes", () => {
  assert.equal(stripAnsi("\u001b[32mProxy\u001b[0m"), "Proxy");
});

test("parses non-default React Rewrite ports", () => {
  const parsed = parseReactRewriteOutput(
    "\u001b[2m  Proxy: \u001b[32mhttp://localhost:3462\u001b[0m\n  WebSocket: ws://localhost:3463",
  );
  assert.deepEqual(parsed, {
    proxyUrl: "http://localhost:3462",
    websocketUrl: "ws://localhost:3463",
  });
});

test("buffers fragmented process output until a complete line arrives", () => {
  const buffer = new LineBuffer();
  assert.deepEqual(buffer.push("  Proxy: http://local"), []);
  assert.deepEqual(buffer.push("host:3462\n  WebSocket: ws://localhost"), ["  Proxy: http://localhost:3462"]);
  assert.deepEqual(buffer.push(":3463\n"), ["  WebSocket: ws://localhost:3463"]);
  assert.equal(buffer.flush(), null);
});
