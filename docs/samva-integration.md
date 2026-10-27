# Samva integration lifecycle

The `samva/integration` branch is Samva's maintained Alchemy distribution. It combines an upstream
Alchemy base with changes that Samva has validated but that are still awaiting upstream work or are
intentionally integration-only. It is not an upstream pull-request branch, a package release, or a
substitute for focused contribution branches.

This guide owns producer mechanics. Samva's project-local `alchemy-floci-integration` skill owns
execution mode and standing authority; its `docs/alchemy-operations.md` owns the consumer pin,
installation and application-validation boundary.

## Checkout topology

- `/Users/aryasaatvik/Developer/alchemy` is the upstream Alchemy checkout used to fetch and inspect
  `alchemy-run/alchemy`.
- `/Users/aryasaatvik/Developer/alchemy-worktrees/samva-integration` is the canonical validated
  checkout of `samva/integration`.
- Direct execution is the default: work in this maintained checkout and Samva main in place. Use
  producer and consumer `wt` lanes only when AFK is specified, then land their validated changes.
  Direct/orchestrated describe execution ownership; AFK/HITL describe interaction. AFK can be direct.
  A Samva delivery worktree never patches an installed Alchemy copy.
- Honor an explicitly named checkout. If another owner's native run holds its clean fence, wait
  for that owner to release it and continue independent producer work; do not ask the user to choose
  a new execution mode or silently move the consumer. Documentation edits also dirty that fence.
- `~/Developer/distilled-worktrees/` is a conventional location for independent authoring worktrees
  from Alchemy's embedded Distilled repository. Discover the actual paths with `git worktree list`
  in that repository; native `wt` can select a nested location. Every Alchemy worktree keeps its own
  `submodules/distilled/` submodule checked out at the immutable gitlink recorded by that parent. The distribution's
  `.gitmodules` selects the Samva fork so retained integration commits are fetchable.
- Reconstruction branches produce candidate-only verification and co-development archives for
  fresh-consumer checks and local Samva acceptance before promotion. Portable maintained
  distribution checkpoints come from `samva/integration` after promotion; preserved candidate refs
  are recovery history, not parallel maintained distributions.
- A user-selected diagnostic collection may be uploaded and pinned before promotion. Retain its
  exact source/ref, Distilled gitlink, selected verified receipt, hashes and reconciliation owner;
  call it a published candidate rather than a maintained checkpoint.
- Samva consumes the exact core and extracted provider artifacts through its root catalog, with
  overrides selecting the same local dependency closure. It does not link the Alchemy workspace or carry Distilled source.

Current commit IDs, pull-request states, candidate readiness, and validation receipts belong in Git,
GitHub, the coordinating Codex task, or the canonical Scratchpad. Do not copy those moving values
into this guide.

## Develop and contribute

Start a focused downstream fix from the maintained head and prove it at the owning boundary.
An upstream contribution uses a separate branch from freshly fetched upstream main when that
contribution is in scope. It must stand on its own, avoid Samva-specific package or hostname
assumptions, and include focused regression evidence. A distribution update does not require an
upstream PR or an unrelated fork-main merge to consume a published Distilled commit.

Use the integration line as a proving and distribution lane:

1. Fetch upstream and classify the existing integration behavior against current source and open or
   merged pull requests.
2. Preserve the validated local head before rewriting it. Before direct in-place reconstruction,
   also push the observed fork head to a dated remote backup and verify it. An AFK candidate can be
   built without changing the maintained line; back up its observed fork head before promotion.
3. Reconstruct against current upstream in the maintained checkout for direct work or a producer
   candidate for explicit AFK work. Keep dependency-ordered coherent commits; drop upstreamed,
   obsolete and intermediate implementations.
4. Record every original integration commit as retained, rewritten, folded, extracted, superseded,
   or dropped in the canonical Scratchpad ledger.
5. Compare the candidate with both current upstream and the preserved integration tree using
   merge-base-aware diffs and `git range-diff`, then run the owning focused suites and workspace
   typecheck.
6. Pack the complete native collection, verify it in a fresh consumer and run the affected Samva
   checks against those exact bytes. Reuse unaffected evidence with its original source identity.
7. Land after applicable review and validation. A normal direct fix fast-forwards the distribution;
   an AFK candidate merges or replaces it. Before replacement, push the observed remote head to a
   dated `backup/<topic>-<date>` ref on `fork`, verify readback, then use an exact
   `--force-with-lease=refs/heads/samva/integration:<observed-sha>`. Stop if the lease moves.

Preserve the validated line before reconstructing it; do not mechanically replay mixed upstreamed
work, integration-only packaging, dependency pins and intermediate fixes. Keep one writer per
checkout and drain any using runtime before changing source, dependencies or history.

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

Run packaging from the selected producer checkout with the Bun and Node versions in the root
`devEngines.runtime` and the exact pnpm version declared by `packageManager`. The packer runs every
nested build, staging and consumer check with the runtimes the outer command selected, and refuses
to start when Bun or Node differ from `devEngines`. Select them explicitly; an unqualified nested
`mise exec` resolves the global runtime instead. Samva's runtime is a separate input.

```bash
mise x bun@1.3.13 node@24 -- bun run pack:integration
```

The packer lives in `scripts/integration-pack`, a Bun-typed project inside the `scripts` workspace
package; `bun test scripts/integration-pack/integration-pack.test.ts` runs its suite.

`integrationEntrypoints` in `scripts/integration-pack/graph.ts` selects the core and application
provider roots. The packer discovers their workspace dependency and peer closure. Core remains
provider-free; the integration does not restore `alchemy/AWS` or other removed provider aliases.
Provider packages keep their `alchemy.contributes` entries for CLI/auth/state discovery.

Each package builds through its native package task. Distilled SDKs additionally run their root
`bundle-lib.ts` and `strip-lib-docs.ts` publication steps, preserving the opt-in `distilled-lazy`
service stubs and shared chunks. Fingerprints include those scripts, authored publication metadata, the
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
collection beside the workspace-pinned Effect (`overrides.effect`) and the declared Vite peer, then checks declarations and Bun/Node
imports, contribution discovery, packaged Lambda boot, local Lambda placement and service endpoint
routing. A second consumer without the optional framework peers (`optionalFrameworkPeers`) bundles
and loads a root `@alchemy.run/aws` import with `bun build --target node`, the shape of a deployed
API. `consumerSubpaths` in `scripts/integration-pack/verify.ts` owns the probe inventory.

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
mise x bun@1.3.13 node@24 -- bun run checkpoint:integration -- --dry-run
mise x bun@1.3.13 node@24 -- bun run checkpoint:integration
```

The command performs a consumer-verified collection pack, reuses an existing production Scratchpad
upload only when its filename and SHA-256 match, and otherwise uploads each archive. Its output
maps every package to an immutable URL. Dry run reads existing uploads and reports missing ones
without uploading. All archive digests are rechecked before publication.

For an already verified selected receipt, upload its existing archives through the native Scratchpad
workflow rather than rebuilding to obtain URLs. Match filename and SHA-256, then verify immutable
GET bytes. The checkpoint helper always packs again, even with `--dry-run`; that flag suppresses
uploading, not local builds. Preserve the selected archives and receipt without substituting a
fresh build. The checkpoint script remains integration-only infrastructure even without an upstream
destination.

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

## Authority and evidence

Samva's integration skill records standing authority for a requested end-to-end update: edit,
build/test, pack and fresh-consumer verify, publish needed artifacts, repin, commit/push and land
after applicable checks/review. Continue through those covered stages without repeated permission
questions. Inspection/discussion remains read-only, and explicit prepare-only, no-upload, no-push or
no-merge instructions narrow the grant. AFK alone is not a merge grant in generic delivery work;
this integration workflow has the standing scoped grant. No action may bypass repository protections.

Record each result independently:

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

Success at one boundary does not prove another. The standing scope supplies authority for covered
delivery actions; live provider writes, plans, deployments, upstream contributions and branch
deletion remain outside it unless separately authorized.

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
