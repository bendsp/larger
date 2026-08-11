import type { SourceTransactionFile, SourceTransactionJournal } from "./transaction-journal.js";
import { readSourceLeaf, sameSourceState, type AuthorizedSourceRoot } from "./source-authorization.js";

export type RecoveryFileAssessment =
  | { readonly path: string; readonly state: "expected" | "result" }
  | { readonly path: string; readonly state: "unknown"; readonly currentSha256: string | null };

export interface RecoveryAssessment {
  readonly transactionId: string;
  readonly safeToRollForward: boolean;
  readonly safeToRollBack: boolean;
  readonly files: readonly RecoveryFileAssessment[];
}

function expectedState(file: SourceTransactionFile) {
  return file.expected;
}

export async function assessTransactionRecovery(
  journal: SourceTransactionJournal,
  root: AuthorizedSourceRoot,
): Promise<RecoveryAssessment> {
  const files: RecoveryFileAssessment[] = [];
  for (const file of journal.files) {
    const current = await readSourceLeaf(root, file.path);
    if (sameSourceState(current, file.result)) {
      files.push({ path: file.path, state: "result" });
    } else if (sameSourceState(current, expectedState(file))) {
      files.push({ path: file.path, state: "expected" });
    } else {
      files.push({ path: file.path, state: "unknown", currentSha256: current.sha256 });
    }
  }
  const known = files.every((file) => file.state !== "unknown");
  return {
    transactionId: journal.transactionId,
    safeToRollForward: known,
    safeToRollBack: known,
    files,
  };
}
