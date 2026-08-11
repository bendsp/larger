import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApplicationDegradedBanner, ApplicationLifecycleScreen } from "../../src/desktop/application-lifecycle.js";
import type { ApplicationSnapshot } from "../../src/desktop/application-contract.js";
import {
  applicationLifecycleReducer,
  initialApplicationLifecycleState,
  normalizeDesktopProblem,
  projectServiceAvailable,
} from "../../src/desktop/application-state.js";
import type { ApplicationLifecycleController } from "../../src/desktop/use-application-lifecycle.js";

const bootId = "11111111-1111-4111-8111-111111111111";

function snapshot(overrides: Partial<ApplicationSnapshot> = {}): ApplicationSnapshot {
  return {
    formatVersion: 1,
    protocolVersion: 1,
    bootId,
    revision: 1,
    phase: "ready",
    services: {
      projects: { status: "ready", problem: null },
      workspaces: { status: "ready", problem: null },
      changes: { status: "ready", problem: null },
      runtime: { status: "ready", problem: null },
      editor: { status: "ready", problem: null },
    },
    problem: null,
    ...overrides,
  };
}

function controller(overrides: Partial<ApplicationLifecycleController> = {}): ApplicationLifecycleController {
  return {
    snapshot: null,
    problem: null,
    operation: "idle",
    bridgeAvailable: true,
    busy: false,
    retry: async () => undefined,
    quit: async () => undefined,
    ...overrides,
  };
}

test("lifecycle state ignores stale revisions and snapshots from another desktop boot", () => {
  const current = applicationLifecycleReducer(initialApplicationLifecycleState, {
    type: "snapshot",
    snapshot: snapshot({ revision: 4 }),
  });

  assert.equal(applicationLifecycleReducer(current, {
    type: "snapshot",
    snapshot: snapshot({ revision: 3 }),
  }), current);
  assert.equal(applicationLifecycleReducer(current, {
    type: "snapshot",
    snapshot: snapshot({ bootId: "22222222-2222-4222-8222-222222222222", revision: 5 }),
  }), current);
});

test("protocol failures preserve validated structured errors and contain unknown causes", () => {
  assert.deepEqual(normalizeDesktopProblem({
    code: "protocol-mismatch",
    message: "Renderer and desktop versions differ.",
    retryable: false,
  }), {
    code: "protocol-mismatch",
    message: "Renderer and desktop versions differ.",
    retryable: false,
  });
  assert.deepEqual(normalizeDesktopProblem({
    code: "made-up-code",
    message: "Untrusted payload",
    retryable: false,
  }), {
    code: "contract-violation",
    message: "Desktop service returned an invalid error response.",
    retryable: false,
  });
});

test("only ready and degraded application states with a usable project service mount the project UI", () => {
  assert.equal(projectServiceAvailable(snapshot()), true);
  assert.equal(projectServiceAvailable(snapshot({ phase: "degraded" })), true);
  assert.equal(projectServiceAvailable(snapshot({ phase: "recovering" })), false);
  assert.equal(projectServiceAvailable(snapshot({
    phase: "degraded",
    services: { ...snapshot().services, projects: { status: "unavailable", problem: null } },
  })), false);
});

test("blocking lifecycle states expose semantic progress and recovery controls", () => {
  const starting = renderToStaticMarkup(createElement(ApplicationLifecycleScreen, {
    lifecycle: controller({ snapshot: snapshot({ phase: "starting" }) }),
  }));
  assert.match(starting, /aria-busy="true"/);
  assert.match(starting, /Starting Larger/);
  assert.match(starting, /role="status"/);

  const unavailable = renderToStaticMarkup(createElement(ApplicationLifecycleScreen, {
    lifecycle: controller({
      snapshot: snapshot({
        phase: "unavailable",
        problem: { code: "unavailable", message: "Service failed safely.", retryable: true },
      }),
    }),
  }));
  assert.match(unavailable, /role="alert"/);
  assert.match(unavailable, /Service failed safely\./);
  assert.match(unavailable, /Try again/);
  assert.match(unavailable, /Quit/);
});

test("degraded banner names affected services and remains a polite live region", () => {
  const degraded = snapshot({
    phase: "degraded",
    problem: { code: "unavailable", message: "Runtime did not recover.", retryable: true },
    services: {
      ...snapshot().services,
      runtime: {
        status: "unavailable",
        problem: { code: "unavailable", message: "Runtime did not recover.", retryable: true },
      },
    },
  });
  const html = renderToStaticMarkup(createElement(ApplicationDegradedBanner, {
    snapshot: degraded,
    busy: false,
    onRetry: () => undefined,
  }));

  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Runtime did not recover\./);
  assert.match(html, /Affected: runtime\./);
});
