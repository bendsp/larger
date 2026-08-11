import type { RuntimeEnvironment } from "../../src/project-contracts.js";

export interface SecretProvider {
  resolve(reference: string, signal?: AbortSignal): Promise<string>;
}

export class MissingSecretProvider implements SecretProvider {
  async resolve(reference: string): Promise<string> {
    throw new Error(`No secret provider is configured for ${reference}`);
  }
}

export class ProcessEnvironmentSecretProvider implements SecretProvider {
  constructor(private readonly source: ProcessEnvironmentSource) {}

  async resolve(reference: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const match = /^env:\/\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference);
    if (!match) throw new Error(`Unsupported secret reference: ${reference}`);
    const value = this.source.get(match[1]!);
    if (value === undefined) throw new Error(`Secret environment variable is unavailable: ${match[1]}`);
    return value;
  }
}

export interface ProcessEnvironmentSource {
  readonly platform: NodeJS.Platform;
  get(name: string): string | undefined;
}

export interface ResolvedRuntimeEnvironment {
  readonly values: Readonly<Record<string, string>>;
  readonly secretValues: readonly string[];
}

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const unixEssentials = ["HOME", "LANG", "LC_ALL", "TMPDIR", "PATH"] as const;
const windowsEssentials = ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "PATH"] as const;

function assertEnvironmentEntry(name: string, value: string): void {
  if (!environmentName.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
  if (value.includes("\0")) throw new Error(`Environment variable ${name} contains a NUL byte`);
}

export class RuntimeEnvironmentBuilder {
  constructor(
    private readonly source: ProcessEnvironmentSource,
    private readonly secrets: SecretProvider,
  ) {}

  async build(declaration: RuntimeEnvironment, signal?: AbortSignal): Promise<ResolvedRuntimeEnvironment> {
    const values: Record<string, string> = {};
    const secretValues: string[] = [];
    const canonicalNames = new Set<string>();
    const set = (name: string, value: string) => {
      assertEnvironmentEntry(name, value);
      const canonical = this.source.platform === "win32" ? name.toUpperCase() : name;
      if (canonicalNames.has(canonical)) throw new Error(`Duplicate environment variable: ${name}`);
      canonicalNames.add(canonical);
      values[name] = value;
    };

    const essentials = this.source.platform === "win32" ? windowsEssentials : unixEssentials;
    for (const name of essentials) {
      const value = this.source.get(name);
      if (value !== undefined && !canonicalNames.has(this.source.platform === "win32" ? name.toUpperCase() : name)) {
        set(name, value);
      }
    }
    for (const name of declaration.inherit) {
      signal?.throwIfAborted();
      const value = this.source.get(name);
      if (value === undefined) throw new Error(`Required inherited environment variable is unavailable: ${name}`);
      const canonical = this.source.platform === "win32" ? name.toUpperCase() : name;
      if (canonicalNames.has(canonical)) continue;
      set(name, value);
      secretValues.push(value);
    }
    for (const [name, value] of Object.entries(declaration.literals)) set(name, value);
    for (const [name, reference] of Object.entries(declaration.secrets)) {
      signal?.throwIfAborted();
      const value = await this.secrets.resolve(reference, signal);
      if (!value) throw new Error(`Secret ${reference} resolved to an empty value`);
      set(name, value);
      secretValues.push(value);
    }
    return { values, secretValues };
  }
}

export function currentProcessEnvironmentSource(): ProcessEnvironmentSource {
  return {
    platform: process.platform,
    get: (name) => process.env[name],
  };
}
