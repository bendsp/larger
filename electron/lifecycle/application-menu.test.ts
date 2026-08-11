import assert from "node:assert/strict";
import test from "node:test";
import type { MenuItemConstructorOptions } from "electron";

import type { ProjectLifecycleSnapshot } from "../../src/project-ipc.js";
import { ApplicationMenuController, createApplicationMenuTemplate } from "./application-menu.js";

const snapshot: ProjectLifecycleSnapshot = {
  revision: 4,
  active: null,
  pending: null,
  transition: null,
  problem: null,
  recentProjects: [{
    projectId: "project",
    instanceKey: "instance",
    canonicalPath: "/projects/example",
    displayName: "Example",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
  }],
};

function submenu(item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] {
  assert.ok(item && Array.isArray(item.submenu));
  return item.submenu;
}

test("native menu routes Open Recent and disables Close Project without an active project", async () => {
  const opened: string[] = [];
  const template = createApplicationMenuTemplate(snapshot, {
    openProject: () => undefined,
    openRecent: (instanceKey) => { opened.push(instanceKey); },
    closeProject: () => undefined,
  }, "darwin");
  const file = template.find((item) => item.label === "File");
  const fileItems = submenu(file);
  const recent = fileItems.find((item) => item.label === "Open Recent");
  const example = submenu(recent)[0]!;
  example.click?.({} as never, {} as never, {} as never);
  await Promise.resolve();

  assert.deepEqual(opened, ["instance"]);
  assert.equal(fileItems.find((item) => item.label === "Close Project")?.enabled, false);
});

test("menu controller rebuilds from main-owned project state", () => {
  let installed: readonly MenuItemConstructorOptions[] = [];
  const controller = new ApplicationMenuController({
    platform: "linux",
    adapter: { install: (template) => { installed = template; } },
    commands: { openProject: () => undefined, openRecent: () => undefined, closeProject: () => undefined },
  });
  controller.refresh(snapshot);

  assert.ok(installed.some((item) => item.label === "File"));
  assert.equal(installed[0]?.label, "File");
});

test("production menu omits reload and developer tools", () => {
  const commands = { openProject: () => undefined, openRecent: () => undefined, closeProject: () => undefined };
  const production = createApplicationMenuTemplate(snapshot, commands, "darwin", false);
  const development = createApplicationMenuTemplate(snapshot, commands, "darwin", true);
  const productionView = submenu(production.find((item) => item.label === "View"));
  const developmentView = submenu(development.find((item) => item.label === "View"));

  assert.equal(productionView.some((item) => item.role === "reload" || item.role === "toggleDevTools"), false);
  assert.equal(developmentView.some((item) => item.role === "reload"), true);
  assert.equal(developmentView.some((item) => item.role === "toggleDevTools"), true);
});

test("native menu command failures are surfaced through the application boundary", async () => {
  const failures: unknown[] = [];
  const failure = new Error("picker failed");
  const template = createApplicationMenuTemplate(snapshot, {
    openProject: () => { throw failure; },
    openRecent: () => undefined,
    closeProject: () => undefined,
    onError: (cause) => { failures.push(cause); },
  }, "darwin");
  const fileItems = submenu(template.find((item) => item.label === "File"));
  fileItems.find((item) => item.label === "Open Project…")?.click?.({} as never, {} as never, {} as never);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(failures, [failure]);
});
