import assert from "node:assert/strict";
import test from "node:test";
import { RedactingLogBuffer } from "./redacting-log-buffer.js";

test("redacts secrets split across process chunks before exposing a complete line", () => {
  const logs = new RedactingLogBuffer({ now: () => new Date("2026-08-11T00:00:00.000Z") });
  logs.addSecrets(["top-secret-token"]);
  logs.write({ source: "runtime", stream: "stdout", chunk: "token=top-secret" });
  assert.equal(logs.window().retained, 0);
  logs.write({ source: "runtime", stream: "stdout", chunk: "-token\nready\n" });
  assert.deepEqual(logs.window().entries.map((entry) => entry.message), ["token=[REDACTED]", "ready"]);
});

test("omits oversized unterminated lines without leaking their contents", () => {
  const logs = new RedactingLogBuffer({ maxLineBytes: 8 });
  logs.addSecrets(["secret"]);
  logs.write({ source: "editor", stream: "stderr", chunk: "prefix-secret-more" });
  assert.deepEqual(logs.window().entries.map((entry) => entry.message), ["[oversized log line omitted]"]);
  logs.write({ source: "editor", stream: "stderr", chunk: "discarded\nnext\n" });
  assert.deepEqual(logs.window().entries.map((entry) => entry.message), ["[oversized log line omitted]", "next"]);
});
test("omits oversized newline-terminated lines before publishing them", () => {
  const logs = new RedactingLogBuffer({ maxLineBytes: 8 });
  logs.write({ source: "runtime", stream: "stdout", chunk: "12345678" });
  logs.write({ source: "runtime", stream: "stdout", chunk: "9\nnext\n" });
  assert.deepEqual(logs.window().entries.map((entry) => entry.message), ["[oversized log line omitted]", "next"]);
});
test("clear removes retained project logs, pending chunks, and redaction secrets", () => {
  const logs = new RedactingLogBuffer();
  logs.addSecrets(["project-a-secret"]);
  logs.write({ source: "runtime", stream: "stdout", chunk: "pending" });
  logs.diagnostic("project-a-secret");
  logs.clear();
  logs.diagnostic("project-a-secret");
  assert.deepEqual(logs.window().entries.map((entry) => entry.message), ["project-a-secret"]);
  assert.equal(logs.window().earliestId, 1);
});

test("retains a bounded window with monotonic ids", () => {
  const logs = new RedactingLogBuffer({ limit: 2 });
  logs.write({ source: "system", stream: "diagnostic", chunk: "one\ntwo\nthree\n" });
  const window = logs.window();
  assert.equal(window.truncated, true);
  assert.equal(window.earliestId, 2);
  assert.equal(window.latestId, 3);
  assert.deepEqual(window.entries.map((entry) => entry.message), ["two", "three"]);
});
