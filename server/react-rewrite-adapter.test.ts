import assert from "node:assert/strict";
import test from "node:test";
import {
  LineBuffer,
  REACT_REWRITE_DESCRIPTOR,
  parseReactRewriteOutput,
} from "./adapters/react-rewrite.js";
import { resolveEditorAdapter } from "./editor-adapters.js";
import { stripAnsi } from "./process.js";

test("strips terminal color codes", () => {
  assert.equal(stripAnsi("\u001b[32mProxy\u001b[0m"), "Proxy");
});

test("parses non-default React Rewrite ports inside the adapter", () => {
  const parsed = parseReactRewriteOutput(
    "\u001b[2m  Proxy: \u001b[32mhttp://localhost:3462\u001b[0m\n  WebSocket: ws://localhost:3463",
  );
  assert.deepEqual(parsed, {
    proxyUrl: "http://localhost:3462",
    websocketUrl: "ws://localhost:3463",
  });
});

test("buffers fragmented upstream output until a complete line arrives", () => {
  const buffer = new LineBuffer();
  assert.deepEqual(buffer.push("  Proxy: http://local"), []);
  assert.deepEqual(buffer.push("host:3462\n  WebSocket: ws://localhost"), ["  Proxy: http://localhost:3462"]);
  assert.deepEqual(buffer.push(":3463\n"), ["  WebSocket: ws://localhost:3463"]);
  assert.equal(buffer.flush(), null);
});

test("describes upstream-owned capabilities without leaking endpoints", () => {
  assert.equal(REACT_REWRITE_DESCRIPTOR.id, "react-rewrite");
  assert.equal(REACT_REWRITE_DESCRIPTOR.capabilities.selection, "embedded");
  assert.equal(REACT_REWRITE_DESCRIPTOR.capabilities.textEditing, "embedded");
  assert.equal(REACT_REWRITE_DESCRIPTOR.maxClients, 1);
  assert.equal("proxyUrl" in REACT_REWRITE_DESCRIPTOR, false);
});

test("resolves adapters through the registry and rejects unknown ids", () => {
  const adapter = resolveEditorAdapter("react-rewrite")(() => undefined);
  assert.equal(adapter.descriptor.id, "react-rewrite");
  assert.throws(() => resolveEditorAdapter("future-native-editor"), /Unsupported editor adapter/);
});
