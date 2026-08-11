export interface StudioPermissionSession {
  setPermissionRequestHandler(
    handler: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void,
  ): void;
  setPermissionCheckHandler(handler: () => boolean): void;
}

export interface TrustedStudioUrlOptions {
  readonly developmentUrl: string;
  readonly packagedUrl: string;
  readonly packaged: boolean;
}

export function trustedStudioUrl(value: string, options: TrustedStudioUrlOptions): boolean {
  try {
    const url = new URL(value);
    if (!options.packaged) return url.origin === new URL(options.developmentUrl).origin;
    url.hash = "";
    url.search = "";
    return url.href === options.packagedUrl;
  } catch {
    return false;
  }
}

export function denyStudioPermissions(session: StudioPermissionSession): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}
