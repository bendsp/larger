import { createHash } from "node:crypto";

import type {
  ByteContentIdentity,
  LineEndingStyle,
  LineTerminator,
  TextContentMetadata,
  TextLineToken,
} from "../../src/change-contracts.js";

const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

export interface TextDecodeLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly maxLineCodeUnits: number;
}

export const DEFAULT_TEXT_DECODE_LIMITS: TextDecodeLimits = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxLines: 250_000,
  maxLineCodeUnits: 1024 * 1024,
});

export interface DecodedTextFile {
  readonly metadata: TextContentMetadata;
  readonly lines: readonly TextLineToken[];
}

export type TextDecodeFailureReason =
  | "binary"
  | "unsupported-encoding"
  | "file-too-large"
  | "too-many-lines"
  | "line-too-long";

export type TextDecodeResult =
  | { readonly ok: true; readonly value: DecodedTextFile }
  | {
    readonly ok: false;
    readonly reason: TextDecodeFailureReason;
    readonly identity: ByteContentIdentity;
  };

function contentIdentity(bytes: Uint8Array): ByteContentIdentity {
  return Object.freeze({
    hashAlgorithm: "sha256" as const,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  });
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte);
}

function lineEndingStyle(lines: readonly TextLineToken[]): LineEndingStyle {
  let hasLf = false;
  let hasCrlf = false;
  let hasCr = false;

  for (const line of lines) {
    hasLf ||= line.terminator === "lf";
    hasCrlf ||= line.terminator === "crlf";
    hasCr ||= line.terminator === "cr";
  }

  if (Number(hasLf) + Number(hasCrlf) + Number(hasCr) > 1) return "mixed";
  if (hasCrlf) return "crlf";
  if (hasLf) return "lf";
  if (hasCr) return "cr";
  return "none";
}

function tokenizeLines(text: string, limits: TextDecodeLimits): readonly TextLineToken[] | TextDecodeFailureReason {
  const lines: TextLineToken[] = [];
  let lineStart = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text.charCodeAt(index);
    if (character !== 0x0a && character !== 0x0d) continue;

    const isCrlf = character === 0x0d && text.charCodeAt(index + 1) === 0x0a;
    const content = text.slice(lineStart, index);
    if (content.length > limits.maxLineCodeUnits) return "line-too-long";

    lines.push(Object.freeze({
      content,
      terminator: isCrlf ? "crlf" : character === 0x0d ? "cr" : "lf",
    }));
    if (lines.length > limits.maxLines) return "too-many-lines";
    if (isCrlf) index += 1;
    lineStart = index + 1;
  }

  if (lineStart < text.length) {
    const content = text.slice(lineStart);
    if (content.length > limits.maxLineCodeUnits) return "line-too-long";
    lines.push(Object.freeze({ content, terminator: "none" }));
    if (lines.length > limits.maxLines) return "too-many-lines";
  }

  return Object.freeze(lines);
}

function validLimits(limits: TextDecodeLimits): boolean {
  return [limits.maxBytes, limits.maxLines, limits.maxLineCodeUnits]
    .every((value) => Number.isSafeInteger(value) && value >= 0);
}

export function decodeTextFile(
  input: Uint8Array,
  limits: TextDecodeLimits = DEFAULT_TEXT_DECODE_LIMITS,
): TextDecodeResult {
  if (!validLimits(limits)) throw new TypeError("Text decode limits must be non-negative safe integers.");

  const bytes = new Uint8Array(input);
  const identity = contentIdentity(bytes);
  if (bytes.byteLength > limits.maxBytes) return { ok: false, reason: "file-too-large", identity };

  if (startsWith(bytes, Uint8Array.of(0xff, 0xfe)) || startsWith(bytes, Uint8Array.of(0xfe, 0xff))) {
    return { ok: false, reason: "unsupported-encoding", identity };
  }

  const hasBom = startsWith(bytes, UTF8_BOM);
  const body = hasBom ? bytes.subarray(UTF8_BOM.length) : bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return { ok: false, reason: "unsupported-encoding", identity };
  }

  if (text.includes("\0")) return { ok: false, reason: "binary", identity };

  const lines = tokenizeLines(text, limits);
  if (typeof lines === "string") return { ok: false, reason: lines, identity };

  const metadata: TextContentMetadata = Object.freeze({
    ...identity,
    encoding: "utf-8",
    bom: hasBom ? "utf-8" : "none",
    lineEndings: lineEndingStyle(lines),
    lineCount: lines.length,
  });

  return {
    ok: true,
    value: Object.freeze({ metadata, lines }),
  };
}

function terminatorText(terminator: LineTerminator): string {
  if (terminator === "lf") return "\n";
  if (terminator === "crlf") return "\r\n";
  if (terminator === "cr") return "\r";
  return "";
}

export function encodeTextFile(input: Pick<DecodedTextFile, "metadata" | "lines">): Uint8Array {
  const parts: string[] = [];

  input.lines.forEach((line, index) => {
    if (line.content.includes("\n") || line.content.includes("\r")) {
      throw new TypeError("Line content cannot contain a line-ending character.");
    }
    if (line.terminator === "none" && index !== input.lines.length - 1) {
      throw new TypeError("Only the final line may omit its terminator.");
    }
    parts.push(line.content, terminatorText(line.terminator));
  });

  const body = new TextEncoder().encode(parts.join(""));
  if (input.metadata.bom === "none") return body;

  const bytes = new Uint8Array(UTF8_BOM.length + body.length);
  bytes.set(UTF8_BOM);
  bytes.set(body, UTF8_BOM.length);
  return bytes;
}

export function textLineEquals(left: TextLineToken, right: TextLineToken): boolean {
  return left.content === right.content && left.terminator === right.terminator;
}
