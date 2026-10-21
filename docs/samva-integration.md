# Samva integration lifecycle

The `samva/integration` branch is Samva's maintained Alchemy distribution. It combines an upstream
Alchemy base with changes that Samva has validated but that are still awaiting upstream work or are
intentionally integration-only. It is not an upstream pull-request branch, a package release, or a
substitute for focused contribution branches.

This guide owns the producer workflow. Samva's `docs/alchemy-operations.md` owns the consumer pin,
installation, and application-validation boundary.

## Checkout topology

- `/Users/aryasaatvik/Developer/alchemy` is the upstream Alchemy checkout used to fetch and inspect
  `alchemy-run/alchemy`.
- `/Users/aryasaatvik/Developer/alchemy-worktrees/samva-integration` is the canonical validated
  checkout of `samva/integration`.
- Focused Alchemy changes use their own branches and `wt` worktrees. A Samva delivery worktree does
  not patch Alchemy independently.
- `~/Developer/distilled-worktrees/` is a conventional location for independent authoring worktrees
  from Alchemy's embedded Distilled repository. Discover the actual paths with `git worktree list`
  in that repository; native `wt` can select a nested location. Every Alchemy worktree keeps its own
  `submodules/distilled/` submodule checked out at the immutable gitlink recorded by that parent. The distribution's
  `.gitmodules` selects the Samva fork so retained integration commits are fetchable.
- Reconstruction branches produce candidate-only verification and co-development archives for
  fresh-consumer checks and local Samva acceptance before promotion. Portable maintained
  distribution checkpoints come from `samva/integration` after promotion; preserved candidate refs
  are recovery history, not parallel maintained distributions.
- Samva consumes the exact core and extracted provider artifacts through its root catalog, with
  overrides selecting the same local dependency closure. It does not link the Alchemy workspace or carry Distilled source.

Current commit IDs, pull-request states, candidate readiness, and validation receipts belong in Git,
GitHub, the coordinating Codex task, or the canonical Scratchpad. Do not copy those moving values
into this guide.

## Develop and contribute

Start substantial or generally useful work on a focused branch from freshly fetched upstream main.
Prove it at the owning Alchemy or Distilled boundary before integrating it for Samva. A contribution
must stand on its own, avoid Samva-specific package or hostname assumptions, and include the focused
regression evidence needed to review it independently.

Use the integration line as a proving and distribution lane:

1. Fetch upstream and classify the existing integration behavior against current source and open or
   merged pull requests.
2. Preserve the validated integration head behind explicit local and fork recovery refs before any
   history reconstruction.
3. Build a candidate from current upstream. Reconstruct retained behavior as dependency-ordered,
   coherent commits; drop upstreamed, obsolete, and intermediate implementations.
4. Record every original integration commit as retained, rewritten, folded, extracted, superseded,
   or dropped in the canonical Scratchpad ledger.
5. Compare the candidate with both current upstream and the preserved integration tree using
   merge-base-aware diffs and `git range-diff`, then run the owning focused suites and workspace
   typecheck.
6. Pack candidate verification archives and complete fresh-consumer checks and local Samva
   acceptance against their exact bytes before promotion.
7. Promote only after review and acceptance, using an exact `--force-with-lease` against the
   previously observed fork head. Promotion does not authorize checkpoint publication or a consumer
   repin.

Do not conventionally rebase the only validated integration branch when its history contains
upstreamed work, integration-only packaging, dependency pins, and intermediate fixes. Construct and
review a fresh candidate instead.

## Distilled changes

Author Distilled changes in an independent checkout or worktree, test them in Distilled, and commit
them there first. The Alchemy parent then records the exact Distilled commit as its submodule gitlink
and verifies the combined behavior from that Alchemy worktree.

Publish a retained Distilled commit to the repository selected by `.gitmodules` before publishing
the Alchemy commit that records it. Verify retrieval from that remote independently of the local
object database.

Never symlink or share one mutable Distilled working directory across Alchemy worktrees. A parent
checkout's gitlink is its reproducible build input; changing the standalone authoring checkout does
not change that input.

## Pack an integration artifact

Run packaging from the selected producer checkout using Bun 1.3.13, Node 24 and the exact pnpm
version declared by `packageManager`. `mise exec` must select those installed runtimes.

```bash
bun run pack:integration
```

`integrationEntrypoints` in `scripts/integration-pack/graph.ts` selects the core and application
provider roots. The packer discovers their workspace dependency and peer closure. Core remains
provider-free; the integration does not restore `alchemy/AWS` or other removed provider aliases.
Provider packages keep their `alchemy.contributes` entries for CLI/auth/state discovery.

Each package builds through its native package task. Distilled SDKs additionally run their root
`bundle-lib.ts` and `strip-lib-docs.ts` publication steps, preserving `lib/services.full`, lazy Node
facades and shared chunks. Fingerprints include those scripts, authored publication metadata, the
shared Alchemy builder, compiler configuration and locked dependency inputs.

The command emits separate package archives and `integration-<commit12>.json`. The receipt records
the full Alchemy commit, Distilled gitlink, each package's version, fingerprint, local tarball and
SHA-256, plus exact `file:` dependencies. Versions use
`<base>-samva.<commit12>.<fingerprint12>`. Keep the verified archives; fingerprints identify build
inputs and are not archive digests or promises of byte-identical fresh rebuilds.

Install the core and providers the application imports as direct dependencies. Override every
local package in the receipt to its exact artifact so no same-version registry copy can replace a
local SDK or shared package. A lone `catalog.alchemy` pin cannot supply extracted provider imports.

Every cache miss quarantines old native compiler/bundler output and incremental metadata until
replacement build and archive verification succeeds. Cleanup refuses tracked paths, paths outside
the package, and symbolic links; failure restores old output and retains the failed replacement for
inspection. Archive staging refuses untracked files in source roots and unresolved workspace,
catalog or local-file dependency protocols. Builds that change fingerprinted inputs fail before
caching; commit regenerated publication metadata before repacking.

Archive verification checks export targets and Contributions modules for each package, including
Distilled full-service outputs and shared chunks. Fresh-consumer verification installs the coherent
collection beside Effect 4.0.4 and the declared Vite peer, then checks declarations and Bun/Node
imports, contribution discovery, packaged Lambda boot, local Lambda placement and service endpoint
routing. `consumerSubpaths` in `scripts/integration-pack/verify.ts` owns the probe inventory.

Diagnostic options are:

```bash
bun run pack:integration -- --plan
bun run pack:integration -- --force
bun run pack:integration -- --fast
bun run pack:integration -- --verify none
bun run pack:integration -- --verify archive
bun run pack:integration -- --verify consumer
```

`--plan` reports the closure and cache decisions without packing. `--force` rebuilds cached package
inputs. `--fast` defaults to archive verification. `--verify none` proves only that a tarball was
created; `archive` proves its packaged structure; `consumer` additionally proves a clean install and
the representative runtime import path. A Samva repin requires consumer verification of the complete collection.

The fingerprint in each version is not its artifact digest. Record the separately printed SHA-256
as the archive identity. A rerun at the same commit reuses cached package archives and reproduces
the same bytes; `--force` or a fresh `--cache-dir` rebuilds every package from source. A full
rebuild yields the same version but not the same bytes: TypeScript can order the union in
`lib/State/HttpStateApi.d.ts` differently, and the `@alchemy.run/cloudflare-runtime` build can
order its internal worker imports differently. Keep the artifact a consumer was verified against;
do not expect to recreate it bit-for-bit from a clean cache.

## Publish a portable checkpoint

A portable checkpoint is an explicit publication step after candidate review, local acceptance and
promotion. It requires a clean maintained `samva/integration` worktree:

```bash
pnpm run checkpoint:integration -- --dry-run
pnpm run checkpoint:integration
```

The command performs a consumer-verified collection pack, reuses an existing production Scratchpad
upload only when its filename and SHA-256 match, and otherwise uploads each archive. Its output
maps every package to an immutable URL. Dry run reads existing uploads and reports missing ones
without uploading. All archive digests are rechecked before publication.

Checkpoint publication is not implied by packing, committing, pushing, or a request to validate
Samva locally. The checkpoint script is integration-only infrastructure and must be retained when
the integration history is reconstructed even if it has no upstream destination.

## Accept an artifact in Samva

For each explicitly selected Samva head:

1. Set the core/provider catalog entries and local-closure overrides to the receipt's exact
   `file:` references or approved immutable checkpoint URLs.
2. Install that exact pin. Use `bun install --force` when replacing content behind an unchanged
   dependency specifier.
3. Verify the installed Alchemy version and representative runtime exports.
4. Run the Samva checks and product surfaces required by the affected behavior.
5. Record the Alchemy commit, Distilled gitlink, artifact SHA-256, consumer reference, Samva commit,
   and validation result separately.

A successful Alchemy test, pack, or fresh-consumer check is producer evidence. It is not Samva
acceptance, a provider plan, a deployment, or customer-path proof.

## Authority gates

Treat each of these as a separate action requiring its own scope or approval:

| Gate | Result |
| --- | --- |
| Edit and focused verification | Candidate source evidence |
| Commit | Local history boundary |
| Push or pull-request update | Remote source/review mutation |
| Integration promotion | Canonical overlay history rewrite |
| Artifact packing | Local distributable plus verification evidence |
| Checkpoint publication | Immutable hosted artifact |
| Samva repin | Selected consumer dependency change |
| Provider plan | Proposed infrastructure changes without Apply; state-backend writes require authorization |
| Deploy/apply | Provider and state mutation |
| Customer-path verification | Observed application behavior |

Success at one gate does not authorize the next.

A native `plan` or `deploy --dry-run` skips infrastructure Apply, but its state backend can write.
The S3 state store acquires a stack/stage lease with `PutObject` before reading persisted state,
renews it while the scope is open, and attempts `DeleteObject` on close. First use also ensures the
state bucket exists and reconciles versioning, encryption, public-access blocking, and ownership
controls when absent or different. Bucket reconciliation affects the shared state bucket, beyond
the stage's lease key.

Before planning against S3 state, obtain explicit authorization for the resolved account, region,
bucket, stack/stage prefix, lease acquisition/renewal/release, and any required bucket reconciliation.
A strict no-provider-writes grant does not cover this path. The native S3 state store has no supported
strict-read-only plan mode; stop for a scope decision when those backend writes are not authorized.
