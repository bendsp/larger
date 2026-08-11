import assert from "node:assert/strict";
import test from "node:test";

import { diffTextFiles } from "./diff-engine.js";
import { decodeTextFile, type DecodedTextFile } from "./text-codec.js";

function text(value: string): DecodedTextFile {
  const result = decodeTextFile(Uint8Array.from(Buffer.from(value)));
  if (!result.ok) assert.fail(result.reason);
  return result.value;
}

function diff(path: string, baseline: DecodedTextFile, edited: DecodedTextFile) {
  const result = diffTextFiles(path, baseline, edited);
  if (!result.ok) assert.fail(result.reason);
  return result.value;
}

test("creates stable structured hunks for separated edits", () => {
  const baseline = text("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
  const edited = text("ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nNINE\n");
  const first = diff("src/file.ts", baseline, edited);
  const second = diff("src/file.ts", baseline, edited);
  const textHunks = first.hunks.filter((hunk) => hunk.kind === "text");

  assert.equal(textHunks.length, 2);
  assert.deepEqual(first.hunks.map((hunk) => hunk.id), second.hunks.map((hunk) => hunk.id));
  assert.deepEqual(textHunks[0]?.edits, [{
    baseStart: 0,
    baseEnd: 1,
    replacement: [{ content: "ONE", terminator: "lf" }],
  }]);
  assert.ok(textHunks.every((hunk) => hunk.lines.some((line) => line.kind === "addition")));
  assert.ok(textHunks.every((hunk) => hunk.lines.some((line) => line.kind === "deletion")));
});

test("hunk IDs are path-scoped and content-derived", () => {
  const baseline = text("before\n");
  const edited = text("after\n");
  const left = diff("left.ts", baseline, edited);
  const right = diff("right.ts", baseline, edited);

  assert.notEqual(left.hunks[0]?.id, right.hunks[0]?.id);
  assert.match(left.hunks[0]?.id ?? "", /^[0-9a-f]{64}$/);
});

test("BOM changes are explicit selection units independent from text hunks", () => {
  const baseline = text("same\n");
  const bomResult = decodeTextFile(Uint8Array.from(Buffer.from("\ufeffsame\n")));
  if (!bomResult.ok) assert.fail(bomResult.reason);

  const result = diff("bom.txt", baseline, bomResult.value);
  assert.equal(result.edits.length, 0);
  assert.deepEqual(result.hunks.map((hunk) => hunk.kind), ["bom"]);
  assert.deepEqual(result.hunks[0], {
    kind: "bom",
    id: result.hunks[0]?.id,
    baseline: "none",
    edited: "utf-8",
  });
});

test("line terminators participate in the structured diff", () => {
  const result = diff("eol.txt", text("one\ntwo\n"), text("one\r\ntwo\n"));
  const hunk = result.hunks.find((candidate) => candidate.kind === "text");
  assert.ok(hunk && hunk.kind === "text");
  assert.deepEqual(hunk.edits, [{
    baseStart: 0,
    baseEnd: 1,
    replacement: [{ content: "one", terminator: "crlf" }],
  }]);
});

test("bounded adapter reports excessive edit distance without a partial diff", () => {
  const result = diffTextFiles("large.txt", text("a\nb\n"), text("x\ny\n"), {
    contextLines: 3,
    maxEditLength: 0,
    timeoutMs: 1_000,
  });

  assert.deepEqual(result, { ok: false, reason: "diff-too-complex" });
});
