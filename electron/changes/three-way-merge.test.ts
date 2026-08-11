import assert from "node:assert/strict";
import test from "node:test";

import { mergeTextFiles } from "./three-way-merge.js";
import { decodeTextFile, type DecodedTextFile } from "./text-codec.js";

function text(value: string): DecodedTextFile {
  const result = decodeTextFile(Uint8Array.from(Buffer.from(value)));
  if (!result.ok) assert.fail(result.reason);
  return result.value;
}

test("deterministically merges disjoint source and desired edits", () => {
  const result = mergeTextFiles(
    text("one\ntwo\nthree\nfour\n"),
    text("SOURCE\ntwo\nthree\nfour\n"),
    text("one\ntwo\nthree\nDESIRED\n"),
  );

  if (result.kind !== "merged") assert.fail(`Expected merge, received ${result.kind}.`);
  assert.equal(Buffer.from(result.bytes).toString(), "SOURCE\ntwo\nthree\nDESIRED\n");
});

test("deduplicates identical edits from both branches", () => {
  const baseline = text("before\n");
  const result = mergeTextFiles(baseline, text("after\n"), text("after\n"));

  if (result.kind !== "merged") assert.fail(`Expected merge, received ${result.kind}.`);
  assert.equal(result.mergedEdits.length, 1);
  assert.equal(Buffer.from(result.bytes).toString(), "after\n");
});

test("overlapping replacements are explicit conflicts with no synthesized content", () => {
  const result = mergeTextFiles(
    text("one\ntwo\nthree\n"),
    text("one\nsource\nthree\n"),
    text("one\ndesired\nthree\n"),
  );

  if (result.kind !== "conflicted") assert.fail(`Expected conflict, received ${result.kind}.`);
  assert.deepEqual(result.conflicts.map((conflict) => conflict.reason), ["overlapping-change"]);
  assert.equal("bytes" in result, false);
});

test("different insertions at the same anchor conflict conservatively", () => {
  const result = mergeTextFiles(
    text("one\ntwo\n"),
    text("one\nsource\ntwo\n"),
    text("one\ndesired\ntwo\n"),
  );

  if (result.kind !== "conflicted") assert.fail(`Expected conflict, received ${result.kind}.`);
  assert.equal(result.conflicts[0]?.reason, "same-anchor-insertion");
});

test("an insertion on a replacement boundary is an explicit conflict", () => {
  const result = mergeTextFiles(
    text("one\ntwo\nthree\n"),
    text("one\nsource\nthree\n"),
    text("one\ninserted\ntwo\nthree\n"),
  );

  if (result.kind !== "conflicted") assert.fail(`Expected conflict, received ${result.kind}.`);
  assert.equal(result.conflicts[0]?.reason, "insertion-overlaps-change");
});

test("adjacent replacements merge without ambiguous ordering", () => {
  const result = mergeTextFiles(
    text("one\ntwo\nthree\n"),
    text("ONE\ntwo\nthree\n"),
    text("one\nTWO\nthree\n"),
  );

  if (result.kind !== "merged") assert.fail(`Expected merge, received ${result.kind}.`);
  assert.equal(Buffer.from(result.bytes).toString(), "ONE\nTWO\nthree\n");
});

test("preserves unrelated EOL-only source drift and desired content", () => {
  const result = mergeTextFiles(
    text("one\ntwo\nthree\n"),
    text("one\r\ntwo\nthree\n"),
    text("one\ntwo\nTHREE\n"),
  );

  if (result.kind !== "merged") assert.fail(`Expected merge, received ${result.kind}.`);
  assert.equal(Buffer.from(result.bytes).toString(), "one\r\ntwo\nTHREE\n");
});

test("merges BOM as a three-way scalar without normalizing line bytes", () => {
  const baseline = text("one\r\n");
  const sourceResult = decodeTextFile(Uint8Array.from(Buffer.from("\ufeffone\r\n")));
  if (!sourceResult.ok) assert.fail(sourceResult.reason);
  const result = mergeTextFiles(baseline, sourceResult.value, text("ONE\r\n"));

  if (result.kind !== "merged") assert.fail(`Expected merge, received ${result.kind}.`);
  assert.deepEqual(result.bytes.slice(0, 3), Uint8Array.of(0xef, 0xbb, 0xbf));
  assert.equal(Buffer.from(result.bytes.slice(3)).toString(), "ONE\r\n");
});

test("propagates bounded diff failure instead of attempting an unbounded merge", () => {
  const result = mergeTextFiles(text("a\nb\n"), text("x\ny\n"), text("m\nn\n"), {
    contextLines: 3,
    maxEditLength: 0,
    timeoutMs: 1_000,
  });

  assert.deepEqual(result, { kind: "failed", reason: "diff-too-complex" });
});
