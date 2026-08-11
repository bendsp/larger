import assert from "node:assert/strict";
import test from "node:test";

import { denyStudioPermissions, trustedStudioUrl } from "./studio-security.js";

const options = {
  developmentUrl: "http://127.0.0.1:4310",
  packagedUrl: "file:///Applications/Larger.app/Contents/Resources/app.asar/dist/index.html",
};

test("production trusts only the exact packaged studio document", () => {
  assert.equal(trustedStudioUrl(options.packagedUrl, { ...options, packaged: true }), true);
  assert.equal(trustedStudioUrl(`${options.packagedUrl}?unexpected=1`, { ...options, packaged: true }), true);
  assert.equal(trustedStudioUrl(`${options.packagedUrl}#route`, { ...options, packaged: true }), true);
  assert.equal(trustedStudioUrl("file:///tmp/attacker.html", { ...options, packaged: true }), false);
  assert.equal(trustedStudioUrl("file:///Applications/Larger.app/Contents/Resources/app.asar/dist/other.html", { ...options, packaged: true }), false);
  assert.equal(trustedStudioUrl("https://larger.design/", { ...options, packaged: true }), false);
});

test("development trusts only the configured studio origin", () => {
  assert.equal(trustedStudioUrl("http://127.0.0.1:4310/work", { ...options, packaged: false }), true);
  assert.equal(trustedStudioUrl("http://localhost:4310/", { ...options, packaged: false }), false);
  assert.equal(trustedStudioUrl("http://127.0.0.1:4311/", { ...options, packaged: false }), false);
});

test("studio permissions are denied in both request and check paths", () => {
  let requestHandler: ((contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined;
  let checkHandler: (() => boolean) | undefined;
  denyStudioPermissions({
    setPermissionRequestHandler: (handler) => { requestHandler = handler; },
    setPermissionCheckHandler: (handler) => { checkHandler = handler; },
  });

  let allowed = true;
  requestHandler?.(null, "camera", (value) => { allowed = value; });
  assert.equal(allowed, false);
  assert.equal(checkHandler?.(), false);
});
