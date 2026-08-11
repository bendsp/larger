export type UnsupportedDependencyCode = "bun" | "yarn" | "yarn-pnp";

export class UnsupportedDependencyManagerError extends Error {
  override readonly name = "UnsupportedDependencyManagerError";

  constructor(
    readonly code: UnsupportedDependencyCode,
    message: string,
  ) {
    super(message);
  }
}

export class DependencyIntegrityError extends Error {
  override readonly name = "DependencyIntegrityError";
}

export class DependencyPlanError extends Error {
  override readonly name = "DependencyPlanError";
}
