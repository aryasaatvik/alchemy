export type VerifyMode = "none" | "archive" | "consumer";

export interface IntegrationPackOptions {
  readonly verify: VerifyMode;
  readonly force: boolean;
  readonly plan: boolean;
  readonly outputDir: string;
  readonly cacheDir: string;
}

export type PackageManifest = Record<string, unknown> & {
  name?: string;
  version?: string;
  files?: ReadonlyArray<string>;
  exports?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  bundledDependencies?: ReadonlyArray<string>;
  workspaces?: unknown;
};

export interface WorkspacePackage {
  readonly name: string;
  readonly directory: string;
  readonly manifest: PackageManifest;
  readonly localDependencies: ReadonlyArray<string>;
}

export interface PackedPackage {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly fingerprint: string;
}
