import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeTextFile,
  encodeTextFile,
  type DecodedTextFile,
} from "./text-codec.js";

function decode(bytes: Uint8Array): DecodedTextFile {
  const result = decodeTextFile(bytes);
  if (!result.ok) assert.fail(result.reason);
  return result.value;
}

test("strict UTF-8 decoding preserves BOM and every supported line terminator", () => {
  const bytes = Uint8Array.from(Buffer.from("\ufeffalpha\rbravo\r\ncharlie\ndelta", "utf8"));
  const value = decode(bytes);

  assert.equal(value.metadata.bom, "utf-8");
  assert.equal(value.metadata.lineEndings, "mixed");
  assert.deepEqual(value.lines, [
    { content: "alpha", terminator: "cr" },
    { content: "bravo", terminator: "crlf" },
    { content: "charlie", terminator: "lf" },
    { content: "delta", terminator: "none" },
  ]);
  assert.deepEqual(encodeTextFile(value), bytes);
});

test("empty, BOM-only, and trailing-newline files round trip without synthetic lines", () => {
  const empty = decode(new Uint8Array());
  assert.deepEqual(empty.lines, []);
  assert.equal(empty.metadata.bom, "none");

  const bomOnlyBytes = Uint8Array.of(0xef, 0xbb, 0xbf);
  const bomOnly = decode(bomOnlyBytes);
  assert.deepEqual(bomOnly.lines, []);
  assert.equal(bomOnly.metadata.bom, "utf-8");
  assert.deepEqual(encodeTextFile(bomOnly), bomOnlyBytes);

  const trailing = Uint8Array.from(Buffer.from("one\n\n"));
  const trailingValue = decode(trailing);
  assert.deepEqual(trailingValue.lines, [
    { content: "one", terminator: "lf" },
    { content: "", terminator: "lf" },
  ]);
  assert.deepEqual(encodeTextFile(trailingValue), trailing);
});

test("content identity is computed from an owned byte snapshot", () => {
  const input = Uint8Array.from(Buffer.from("owned\n"));
  const value = decode(input);
  const hash = value.metadata.sha256;
  input.fill(0);

  assert.equal(value.metadata.sha256, hash);
  assert.equal(Buffer.from(encodeTextFile(value)).toString(), "owned\n");
});

test("unsupported content reports stable reasons and byte identities", () => {
  const cases: readonly [Uint8Array, string][] = [
    [Uint8Array.of(0xff, 0xfe, 0x61, 0x00), "unsupported-encoding"],
    [Uint8Array.of(0xc3, 0x28), "unsupported-encoding"],
    [Uint8Array.from(Buffer.from("a\0b")), "binary"],
  ];

  for (const [bytes, reason] of cases) {
    const result = decodeTextFile(bytes);
    if (result.ok) assert.fail("Expected unsupported content.");
    assert.equal(result.reason, reason);
    assert.equal(result.identity.byteLength, bytes.byteLength);
    assert.match(result.identity.sha256, /^[0-9a-f]{64}$/);
  }
});

test("decode limits fail closed with distinct reasons", () => {
  const defaults = { maxBytes: 100, maxLines: 100, maxLineCodeUnits: 100 };

  assert.equal(decodeTextFile(Uint8Array.from(Buffer.from("abcd")), { ...defaults, maxBytes: 3 }).ok, false);
  const tooLarge = decodeTextFile(Uint8Array.from(Buffer.from("abcd")), { ...defaults, maxBytes: 3 });
  assert.equal(tooLarge.ok ? undefined : tooLarge.reason, "file-too-large");

  const tooMany = decodeTextFile(Uint8Array.from(Buffer.from("a\nb\n")), { ...defaults, maxLines: 1 });
  assert.equal(tooMany.ok ? undefined : tooMany.reason, "too-many-lines");

  const tooLong = decodeTextFile(Uint8Array.from(Buffer.from("abcd")), { ...defaults, maxLineCodeUnits: 3 });
  assert.equal(tooLong.ok ? undefined : tooLong.reason, "line-too-long");
});

test("encoder rejects structurally ambiguous line tokens", () => {
  const metadata = decode(Uint8Array.from(Buffer.from("safe"))).metadata;

  assert.throws(() => encodeTextFile({
    metadata,
    lines: [
      { content: "unterminated", terminator: "none" },
      { content: "next", terminator: "none" },
    ],
  }), /Only the final line/);
  assert.throws(() => encodeTextFile({
    metadata,
    lines: [{ content: "embedded\rbreak", terminator: "none" }],
  }), /line-ending character/);
});
