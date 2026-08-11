import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import type { SourceTransactionJournal } from "./transaction-journal";
import {
  SourceTransactionRepository,
  transactionPlanDigest,
} from "./transaction-journal";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function makeJournal(sourceRoot: string): {
  readonly journal: SourceTransactionJournal;
  readonly blobs: ReadonlyMap<string, Uint8Array>;
} {
  const replacementBytes = Buffer.from("replacement\n", "utf8");
  const replacementSha256 = sha256(replacementBytes);
  const expected = {
    kind: "absent" as const,
    sha256: null,
    size: 0,
    mode: null,
    device: null,
    inode: null,
  };
  const result = {
    kind: "file" as const,
    sha256: replacementSha256,
    size: replacementBytes.byteLength,
    mode: 0o644,
    device: null,
    inode: null,
  };
  const plannedFile = {
    path: "src/example.txt",
    operation: "replace" as const,
    expected,
    result,
    mode: 0o644,
    temporaryName: ".larger-11111111-1111-4111-8111-111111111111-aaaaaaaaaaaaaaaa.tmp",
  };
  const identity = {
    changeSetId: "change-set-1",
    changeSetRevision: 1,
    projectId: "project-1",
    instanceKey: "instance-1",
    baselineIdentity: "b".repeat(64),
    runtimeId: "runtime-1",
  };
  const now = new Date(0).toISOString();
  const journal: SourceTransactionJournal = {
    formatVersion: 1,
    transactionId: "11111111-1111-4111-8111-111111111111",
    ...identity,
    projectGeneration: 1,
    canonicalSourceRoot: sourceRoot,
    sourceRootDevice: 1,
    sourceRootInode: 1,
    planDigest: transactionPlanDigest({ ...identity, files: [plannedFile] }),
    createdAt: now,
    updatedAt: now,
    state: "prepared",
    files: [
      {
        ...plannedFile,
        backup: null,
        replacement: {
          sha256: replacementSha256,
          size: replacementBytes.byteLength,
          fileName: `${replacementSha256}.blob`,
        },
        state: "pending",
        plannedDirectories: [],
        createdDirectories: [],
      },
    ],
  };
  return { journal, blobs: new Map([[replacementSha256, replacementBytes]]) };
}

async function setup(t: TestContext) {
  const instanceRoot = await mkdtemp(path.join(tmpdir(), "larger-journal-hardening-"));
  t.after(() => rm(instanceRoot, { recursive: true, force: true }));
  const canonicalInstanceRoot = await realpath(instanceRoot);
  const repository = await SourceTransactionRepository.create(
    canonicalInstanceRoot,
    "instance-1",
  );
  const fixture = makeJournal(canonicalInstanceRoot);
  await repository.createJournal(fixture.journal, fixture.blobs);
  const transactionDirectory = (
    repository as unknown as { transactionDirectory(transactionId: string): string }
  ).transactionDirectory(fixture.journal.transactionId);
  return { repository, fixture, transactionDirectory };
}

test("transaction updates cannot redirect the authorized source root", async (t) => {
  const { repository, fixture } = await setup(t);
  await assert.rejects(
    repository.update(fixture.journal.transactionId, (current) => ({
      ...current,
      canonicalSourceRoot: path.join(current.canonicalSourceRoot, "redirected"),
    })),
    /immutable plan/,
  );
});

test("transaction reads fail closed when the immutable plan is tampered", async (t) => {
  const { repository, fixture, transactionDirectory } = await setup(t);
  const immutablePath = path.join(transactionDirectory, "immutable-plan.json");
  const record = JSON.parse(await readFile(immutablePath, "utf8")) as Record<string, unknown>;
  record.digest = "f".repeat(64);
  await chmod(immutablePath, 0o600);
  await writeFile(immutablePath, `${JSON.stringify(record)}\n`, "utf8");

  await assert.rejects(repository.read(fixture.journal.transactionId), /immutable plan/);
});

test("transaction reads fail closed when the immutable plan is missing", async (t) => {
  const { repository, fixture, transactionDirectory } = await setup(t);
  await rm(path.join(transactionDirectory, "immutable-plan.json"));
  await assert.rejects(repository.read(fixture.journal.transactionId), { code: "ENOENT" });
});

test("transaction updates reject unsafe created-directory paths", async (t) => {
  const { repository, fixture } = await setup(t);
  await assert.rejects(
    repository.update(fixture.journal.transactionId, (current) => ({
      ...current,
      files: current.files.map((file) => ({
        ...file,
        createdDirectories: ["../escape"],
      })),
    })),
    /safe relative POSIX path|must not contain/,
  );
});

test("transaction blob reads reject a same-content symlink leaf", async (t) => {
  if (process.platform === "win32") {
    t.skip("Creating symlinks requires additional privileges on Windows.");
    return;
  }
  const { repository, fixture, transactionDirectory } = await setup(t);
  const reference = fixture.journal.files[0]?.replacement;
  assert.ok(reference);
  const blobPath = path.join(transactionDirectory, "blobs", reference.fileName);
  const externalPath = path.join(path.dirname(transactionDirectory), "external-matching-blob");
  await writeFile(externalPath, await readFile(blobPath));
  await unlink(blobPath);
  await symlink(externalPath, blobPath);

  await assert.rejects(
    repository.readBlob(fixture.journal.transactionId, reference),
    /ELOOP|symbolic link/i,
  );
});

test("transaction blob reads reject a wrong-sized file before reading content", async (t) => {
  const { repository, fixture, transactionDirectory } = await setup(t);
  const reference = fixture.journal.files[0]?.replacement;
  assert.ok(reference);
  const blobPath = path.join(transactionDirectory, "blobs", reference.fileName);
  await chmod(blobPath, 0o600);
  await writeFile(blobPath, Buffer.alloc(reference.size + 1, 0x61));

  await assert.rejects(
    repository.readBlob(fixture.journal.transactionId, reference),
    /size does not match/,
  );
});
