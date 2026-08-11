import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSketchServer } from "react-rewrite-cli/dist/server.js";
import {
  isProjectFilePathSafe,
  writeProjectFileAtomically,
} from "react-rewrite-cli/dist/path-resolver.js";

const UPSTREAM_VERSION = "0.1.1";
const UPSTREAM_COMMIT = "d19d8e952b69f99700b0d86e4c056379c067dfd8";

async function attemptUpgrade(
  port: number,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const upgrade = request({
      host: "127.0.0.1",
      port,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        ...headers,
      },
    });
    upgrade.once("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 101);
    });
    upgrade.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    upgrade.once("error", reject);
    upgrade.end();
  });
}

test("records the exact upstream package base for mechanical patch review", async () => {
  const packageMetadata = JSON.parse(await readFile(path.resolve("node_modules/react-rewrite-cli/package.json"), "utf8")) as {
    version: string;
  };
  assert.equal(packageMetadata.version, UPSTREAM_VERSION);
  assert.match(UPSTREAM_COMMIT, /^[a-f0-9]{40}$/);
});

test("requires main-assigned proxy ports instead of publishing undiscoverable random listeners", async () => {
  const entrypoint = await readFile(path.resolve("node_modules/react-rewrite-cli/dist/index.js"), "utf8");
  assert.match(entrypoint, /REACT_REWRITE_PROXY_PORT/);
  assert.match(entrypoint, /REACT_REWRITE_WS_PORT/);
  assert.match(entrypoint, /detect\(projectRoot\)/);
  assert.doesNotMatch(entrypoint, /getAvailablePort\(/);
});

test("accepts only capability-bound WebSockets from the exact loopback origin", async (context) => {
  const capability = randomBytes(32).toString("base64url");
  const allowedOrigin = "http://127.0.0.1:45678";
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-react-rewrite-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "App.tsx"), "export default () => <main />;\n");
  const server = createSketchServer({
    port: 0,
    host: "127.0.0.1",
    capability,
    allowedOrigin,
    projectRoot: root,
  });
  context.after(() => new Promise<void>((resolve) => server.wss.close(() => resolve())));
  if (!server.wss.address()) await new Promise<void>((resolve) => server.wss.once("listening", resolve));
  const address = server.wss.address();
  assert.ok(address && typeof address === "object");

  assert.notEqual(await attemptUpgrade(address.port, {
    Origin: allowedOrigin,
    "Sec-WebSocket-Protocol": "larger, wrong-capability",
  }), 101);
  assert.notEqual(await attemptUpgrade(address.port, {
    Origin: "http://127.0.0.1:9999",
    "Sec-WebSocket-Protocol": `larger, ${capability}`,
  }), 101);
  assert.equal(await attemptUpgrade(address.port, {
    Origin: allowedOrigin,
    "Sec-WebSocket-Protocol": `larger, ${capability}`,
  }), 101);
});

test("rejects symlink traversal and atomically writes only regular runtime files", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-react-rewrite-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "larger-react-rewrite-outside-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  const target = path.join(root, "src", "App.tsx");
  const outsideTarget = path.join(outside, "Outside.tsx");
  await writeFile(target, "export const value = 1;\n");
  await writeFile(outsideTarget, "outside\n");

  assert.equal(isProjectFilePathSafe(target, root), true);
  assert.equal(isProjectFilePathSafe(outsideTarget, root), false);
  writeProjectFileAtomically(target, "export const value = 2;\n", root);
  assert.equal(await readFile(target, "utf8"), "export const value = 2;\n");

  if (process.platform !== "win32") {
    const linkedLeaf = path.join(root, "src", "Linked.tsx");
    await symlink(outsideTarget, linkedLeaf);
    assert.equal(isProjectFilePathSafe(linkedLeaf, root), false);
    assert.throws(() => writeProjectFileAtomically(linkedLeaf, "escaped\n", root), /outside|symbolic/i);
    assert.equal(await readFile(outsideTarget, "utf8"), "outside\n");
  }
});
