import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const roots = ["electron", "test"];

async function collectTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTests(candidate));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(candidate);
  }
  return files;
}

const files = (await Promise.all(roots.map(collectTests)))
  .flat()
  .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

if (files.length === 0) throw new Error("No test files were discovered");

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`Test process exited from ${signal}`));
    else resolve(code ?? 1);
  });
});

process.exitCode = exitCode;
