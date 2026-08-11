import assert from "node:assert/strict";
import test from "node:test";

import { diffTextFiles, type TextFileDiff } from "./diff-engine.js";
import { buildSelectedText } from "./selection.js";
import { decodeTextFile, type DecodedTextFile } from "./text-codec.js";

function text(value: string): DecodedTextFile {
  const result = decodeTextFile(Uint8Array.from(Buffer.from(value)));
  if (!result.ok) assert.fail(result.reason);
  return result.value;
}

function createDiff(path: string, baseline: DecodedTextFile, edited: DecodedTextFile): TextFileDiff {
  const result = diffTextFiles(path, baseline, edited);
  if (!result.ok) assert.fail(result.reason);
  return result.value;
}

test("selecting one of two hunks constructs exact desired bytes and preserves rejected content", () => {
  const baseline = text("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
  const edited = text("ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nNINE\n");
  const diff = createDiff("two-hunks.txt", baseline, edited);
  const hunks = diff.hunks.filter((hunk) => hunk.kind === "text");
  assert.equal(hunks.length, 2);

  const result = buildSelectedText(baseline, edited, diff, [hunks[0]?.id ?? ""]);
  if (!result.ok) assert.fail(result.reason);

  assert.equal(Buffer.from(result.bytes).toString(), "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
  assert.deepEqual(result.selectedHunkIds, [hunks[0]?.id]);
});

test("BOM and EOL changes can be selected independently", () => {
  const baseline = text("one\ntwo\n");
  const editedResult = decodeTextFile(Uint8Array.from(Buffer.from("\ufeffone\r\ntwo\n")));
  if (!editedResult.ok) assert.fail(editedResult.reason);
  const edited = editedResult.value;
  const diff = createDiff("metadata.txt", baseline, edited);
  const bom = diff.hunks.find((hunk) => hunk.kind === "bom");
  const eol = diff.hunks.find((hunk) => hunk.kind === "text");
  assert.ok(bom && eol);

  const bomOnly = buildSelectedText(baseline, edited, diff, [bom.id]);
  if (!bomOnly.ok) assert.fail(bomOnly.reason);
  assert.deepEqual(bomOnly.bytes.slice(0, 3), Uint8Array.of(0xef, 0xbb, 0xbf));
  assert.equal(Buffer.from(bomOnly.bytes.slice(3)).toString(), "one\ntwo\n");

  const eolOnly = buildSelectedText(baseline, edited, diff, [eol.id]);
  if (!eolOnly.ok) assert.fail(eolOnly.reason);
  assert.equal(eolOnly.value.metadata.bom, "none");
  assert.equal(Buffer.from(eolOnly.bytes).toString(), "one\r\ntwo\n");
});

test("empty selection reproduces baseline bytes", () => {
  const baselineResult = decodeTextFile(Uint8Array.from(Buffer.from("\ufeffbase\r")));
  if (!baselineResult.ok) assert.fail(baselineResult.reason);
  const baseline = baselineResult.value;
  const edited = text("edited\n");
  const diff = createDiff("none.txt", baseline, edited);

  const result = buildSelectedText(baseline, edited, diff, []);
  if (!result.ok) assert.fail(result.reason);
  assert.deepEqual(result.bytes, Uint8Array.from(Buffer.from("\ufeffbase\r")));
});

test("selection rejects unknown hunks and stale content identities", () => {
  const baseline = text("before\n");
  const edited = text("after\n");
  const diff = createDiff("stale.txt", baseline, edited);

  assert.deepEqual(buildSelectedText(baseline, edited, diff, ["unknown"]), {
    ok: false,
    reason: "unknown-hunk",
  });
  assert.deepEqual(buildSelectedText(text("other\n"), edited, diff, []), {
    ok: false,
    reason: "stale-baseline",
  });
  assert.deepEqual(buildSelectedText(baseline, text("other\n"), diff, []), {
    ok: false,
    reason: "stale-edited",
  });
});
