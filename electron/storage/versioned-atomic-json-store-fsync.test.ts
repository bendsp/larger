import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  isUnsupportedDirectoryFsyncError,
  syncDirectory,
} from "./versioned-atomic-json-store";

test("directory fsync suppresses only explicit portable unsupported errors", () => {
  for (const code of ["EINVAL", "ENOTSUP", "EISDIR"]) {
    assert.equal(isUnsupportedDirectoryFsyncError({ code }, "darwin"), true);
    assert.equal(isUnsupportedDirectoryFsyncError({ code }, "linux"), true);
  }

  assert.equal(isUnsupportedDirectoryFsyncError({ code: "EIO" }, "darwin"), false);
  assert.equal(isUnsupportedDirectoryFsyncError({ code: "ENOSPC" }, "linux"), false);
  assert.equal(isUnsupportedDirectoryFsyncError(new Error("missing code"), "darwin"), false);
});

test("Windows-only directory fsync errors remain platform-scoped", () => {
  for (const code of ["EACCES", "EPERM"]) {
    assert.equal(isUnsupportedDirectoryFsyncError({ code }, "win32"), true);
    assert.equal(isUnsupportedDirectoryFsyncError({ code }, "darwin"), false);
    assert.equal(isUnsupportedDirectoryFsyncError({ code }, "linux"), false);
  }
});

test("directory fsync propagates an ordinary filesystem failure", async () => {
  const missingDirectory = join(tmpdir(), `larger-missing-directory-${randomUUID()}`);
  await assert.rejects(syncDirectory(missingDirectory), { code: "ENOENT" });
});
