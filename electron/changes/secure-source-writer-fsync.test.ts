import assert from "node:assert/strict";
import { test } from "node:test";

import { isUnsupportedSourceDirectoryFsyncError } from "./secure-source-writer";

test("source directory fsync suppresses only explicit Windows unsupported errors", () => {
  for (const code of ["EINVAL", "ENOTSUP", "EISDIR", "EACCES", "EPERM"]) {
    assert.equal(isUnsupportedSourceDirectoryFsyncError({ code }, "win32"), true);
  }

  for (const code of ["EIO", "ENOSPC", "ENOENT", "EROFS"]) {
    assert.equal(isUnsupportedSourceDirectoryFsyncError({ code }, "win32"), false);
  }

  assert.equal(isUnsupportedSourceDirectoryFsyncError({ code: "EPERM" }, "darwin"), false);
  assert.equal(isUnsupportedSourceDirectoryFsyncError({ code: "EINVAL" }, "linux"), false);
  assert.equal(isUnsupportedSourceDirectoryFsyncError(new Error("missing code"), "win32"), false);
});
