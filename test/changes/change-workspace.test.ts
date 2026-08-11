import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CHANGE_SET_FORMAT_VERSION, type ChangeSetSnapshot } from "../../src/change-contracts.js";
import { ChangeWorkspace } from "../../src/changes/change-workspace.js";

const emptyChangeSet: ChangeSetSnapshot = {
  formatVersion: CHANGE_SET_FORMAT_VERSION,
  id: "change-set-empty",
  revision: 1,
  projectId: "project.example",
  instanceKey: "instance_example",
  baselineIdentity: "a".repeat(64),
  origin: { kind: "runtime-workspace", runtimeId: "runtime-example" },
  status: "reviewing",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  files: [],
  selection: { files: [] },
  application: null,
  recovery: null,
};

test("a failed scan is never presented as a clean runtime", () => {
  for (const changeSet of [null, emptyChangeSet]) {
    const html = renderToStaticMarkup(createElement(ChangeWorkspace, {
      changeSet,
      workspacePrepared: true,
      trusted: true,
      problem: "The runtime changed while it was being scanned.",
    }));

    assert.match(html, /Runtime scan failed/);
    assert.match(html, /The runtime changed while it was being scanned\./);
    assert.doesNotMatch(html, /No runtime changes/);
    assert.doesNotMatch(html, /runtime matches its immutable baseline/);
  }
});
