import { createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { readManifest, resolveSourceRoot } from "./manifest.js";
import { inspectProject, mimeTypeForAsset, resolveProjectAsset } from "./project-inspector.js";
import { SessionManager } from "./session-manager.js";

const API_HOST = "127.0.0.1";
const API_PORT = 4311;
const STUDIO_ORIGIN = "http://127.0.0.1:4310";
const API_CAPABILITY = randomBytes(32).toString("base64url");
const manifest = await readManifest();
const sourceRoot = await resolveSourceRoot(manifest);
const sourceStat = await stat(sourceRoot);
if (!sourceStat.isDirectory()) throw new Error(`Project root is not a directory: ${sourceRoot}`);
const session = new SessionManager(manifest, sourceRoot);

function applyCommonHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", STUDIO_ORIGIN);
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Larger-Capability");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  applyCommonHeaders(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${API_HOST}:${API_PORT}`}`);
  if (request.method === "OPTIONS") {
    applyCommonHeaders(response);
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "POST") {
    if (request.headers.origin && request.headers.origin !== STUDIO_ORIGIN) {
      sendJson(response, 403, { error: "Rejected cross-origin session command" });
      return;
    }
    if (request.headers["x-larger-capability"] !== API_CAPABILITY) {
      sendJson(response, 403, { error: "Missing or invalid session capability" });
      return;
    }
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, project: manifest.project.name, capability: API_CAPABILITY });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/project") {
      sendJson(
        response,
        200,
        await inspectProject(manifest.project.name, sourceRoot, manifest.project.entryRoute ?? "/"),
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/session") {
      sendJson(response, 200, await session.snapshot());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/session/start") {
      sendJson(response, 200, await session.start());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/session/stop") {
      sendJson(response, 200, await session.stop());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/asset") {
      const requestedPath = url.searchParams.get("path");
      if (!requestedPath) throw new Error("Missing asset path");
      const assetPath = await resolveProjectAsset(sourceRoot, requestedPath);
      const assetStat = await stat(assetPath);
      applyCommonHeaders(response);
      response.writeHead(200, {
        "Content-Type": mimeTypeForAsset(assetPath),
        "Content-Length": String(assetStat.size),
        "Cache-Control": "private, max-age=60",
      });
      createReadStream(assetPath).pipe(response);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(API_PORT, API_HOST, () => {
  console.log(`Larger API listening at http://${API_HOST}:${API_PORT}`);
  console.log(`Attached project: ${sourceRoot}`);
});

async function shutdown(): Promise<void> {
  await session.stop();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
