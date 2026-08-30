import { basename, resolve } from "node:path";

import { run } from "./io.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");

interface PackResult {
  readonly artifact: string;
  readonly sha256: string;
  readonly version: string;
}

interface ScratchpadUpload {
  readonly id: string;
  readonly filename: string;
  readonly contentHash: string;
  readonly url: string;
  readonly createdAt: string;
}

interface ScratchpadUploadResult {
  readonly filename: string;
  readonly sha256: string;
  readonly url: string;
}

const help = `Publish a verified Alchemy integration checkpoint to Scratchpad.

Usage:
  pnpm run checkpoint:integration
  pnpm run checkpoint:integration -- --dry-run

The command requires a clean Git worktree, runs fresh-consumer verification,
and uploads the resulting tarball with the Scratchpad production profile.
Re-running an already uploaded checkpoint returns its existing URL.
`;

export const parsePackResult = (output: string): PackResult => {
  const artifact = /^Created (.+)$/m.exec(output)?.[1];
  const sha256 = /^SHA256 ([a-f0-9]{64})$/m.exec(output)?.[1];
  const version = /^Version (.+)$/m.exec(output)?.[1];
  if (artifact === undefined || sha256 === undefined || version === undefined) {
    throw new Error(
      "Integration packer did not report one artifact, version, and SHA-256 digest",
    );
  }
  return { artifact, sha256, version };
};

export const findExistingUpload = (
  uploads: ReadonlyArray<ScratchpadUpload>,
  result: PackResult,
): ScratchpadUpload | undefined =>
  uploads
    .filter(
      (upload) =>
        upload.filename === basename(result.artifact) &&
        upload.contentHash === result.sha256,
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

export const parseUploadResult = (
  output: string,
  result: PackResult,
): ScratchpadUploadResult => {
  const response = JSON.parse(output) as {
    readonly uploads?: ReadonlyArray<ScratchpadUploadResult>;
  };
  const uploaded = response.uploads?.[0];
  if (
    response.uploads?.length !== 1 ||
    uploaded?.filename !== basename(result.artifact) ||
    uploaded.sha256 !== result.sha256 ||
    typeof uploaded.url !== "string"
  ) {
    throw new Error(
      "Scratchpad upload response did not match the verified integration artifact",
    );
  }
  return uploaded;
};

const parseArgs = (): {
  readonly dryRun: boolean;
  readonly showHelp: boolean;
} => {
  const args = Bun.argv.slice(2).filter((argument) => argument !== "--");
  const unknown = args.filter(
    (argument) => !["--dry-run", "--help", "-h"].includes(argument),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown argument: ${unknown[0]}`);
  }
  return {
    dryRun: args.includes("--dry-run"),
    showHelp: args.includes("--help") || args.includes("-h"),
  };
};

const uploadCheckpoint = async (dryRun: boolean): Promise<void> => {
  const dirty = await run(["git", "status", "--porcelain"], {
    cwd: repositoryRoot,
    quiet: true,
  });
  if (dirty !== "") {
    throw new Error(
      "Integration checkpoint requires a clean Git worktree; commit or restore tracked changes first",
    );
  }
  if (Bun.which("scratchpad") === null) {
    throw new Error(
      "scratchpad is not installed; install it before publishing an integration checkpoint",
    );
  }

  const packOutput = await run(
    ["bun", "scripts/integration-pack/cli.ts", "--verify", "consumer"],
    { cwd: repositoryRoot, quiet: true },
  );
  console.log(packOutput);
  const result = parsePackResult(packOutput);

  const uploadsOutput = await run(
    ["scratchpad", "uploads", "list", "--profile", "production", "--json"],
    { cwd: repositoryRoot, quiet: true },
  );
  const uploads = JSON.parse(uploadsOutput) as ReadonlyArray<ScratchpadUpload>;
  const existing = findExistingUpload(uploads, result);
  if (existing !== undefined) {
    console.log(`Scratchpad checkpoint already exists: ${existing.url}`);
    return;
  }

  if (dryRun) {
    console.log(
      `Dry run: would upload ${result.artifact} to Scratchpad profile production`,
    );
    return;
  }

  const uploadedOutput = await run(
    [
      "scratchpad",
      "upload",
      "--profile",
      "production",
      "--json",
      result.artifact,
    ],
    { cwd: repositoryRoot, quiet: true },
  );
  const uploaded = parseUploadResult(uploadedOutput, result);
  console.log(`Scratchpad checkpoint: ${uploaded.url}`);
};

const main = async (): Promise<void> => {
  const options = parseArgs();
  if (options.showHelp) {
    console.log(help);
    return;
  }
  await uploadCheckpoint(options.dryRun);
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `✗ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
