import path from "node:path";
import { writeFile } from "node:fs/promises";
import { DirectDependencyCommandRunner, type DependencyCommandRunner } from "./process.js";
import type {
  DependencyInstaller,
  DependencyOperationOptions,
  ResolvedDependencyPlan,
} from "./types.js";

function installationEnvironment(operationStagingPath: string, userConfigPath: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: path.join(operationStagingPath, "tmp"),
    CI: "true",
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_enable_global_virtual_store: "false",
    npm_config_userconfig: userConfigPath,
    npm_config_update_notifier: "false",
  };
}

export class PackageManagerInstaller implements DependencyInstaller {
  constructor(private readonly commandRunner: DependencyCommandRunner = new DirectDependencyCommandRunner()) {}

  async install(
    plan: ResolvedDependencyPlan,
    stagedProjectRoot: string,
    operationStagingPath: string,
    options: DependencyOperationOptions = {},
  ): Promise<void> {
    const cwd = plan.installRootRelativePath === "."
      ? stagedProjectRoot
      : path.join(stagedProjectRoot, ...plan.installRootRelativePath.split("/"));
    const arguments_ = plan.key.packageManager === "npm"
      ? ["ci", "--no-audit", "--no-fund"]
      : [
          "install",
          "--frozen-lockfile",
          "--package-import-method=clone-or-copy",
          "--store-dir",
          path.join(operationStagingPath, "pnpm-store"),
        ];
    const userConfigPath = path.join(operationStagingPath, "empty-user-npmrc");
    await writeFile(userConfigPath, "", { flag: "wx", mode: 0o600 });
    await this.commandRunner.run({
      executable: plan.managerExecutable,
      arguments: arguments_,
      cwd,
      environment: installationEnvironment(operationStagingPath, userConfigPath),
      signal: options.signal,
    });
  }
}
