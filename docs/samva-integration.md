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
- `~/Developer/distilled` is the independent authoring checkout for Distilled changes. Every
  Alchemy worktree keeps its own `distilled/` submodule checked out at the immutable gitlink recorded
  by that parent.
- Samva consumes an exact packed artifact through its root `catalog.alchemy`; it does not link the
  Alchemy workspace or carry Distilled source.

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
6. Promote only after review, using an exact `--force-with-lease` against the previously observed
   fork head. Promotion does not authorize packaging or a consumer repin.

Do not conventionally rebase the only validated integration branch when its history contains
upstreamed work, integration-only packaging, dependency pins, and intermediate fixes. Construct and
review a fresh candidate instead.

## Distilled changes

Author Distilled changes in an independent checkout or worktree, test them in Distilled, and commit
them there first. The Alchemy parent then records the exact Distilled commit as its submodule gitlink
and verifies the combined behavior from that Alchemy worktree.

Never symlink or share one mutable Distilled working directory across Alchemy worktrees. A parent
checkout's gitlink is its reproducible build input; changing the standalone authoring checkout does
not change that input.

## Pack an integration artifact

Run packaging only from the Alchemy integration checkout:

```bash
bun run pack:integration
```

The default run discovers the publishable workspace closure, builds and packs it in dependency
order, stages exact local tarballs, rejects local workspace-specifier leakage, verifies archive
exports and bundled Distilled surfaces, and installs the result in a fresh Bun/Node consumer. It
prints:

- the artifact path;
- a version containing the Alchemy commit and source/build fingerprint;
- the archive SHA-256;
- the exact local `file:` dependency for a consumer.

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
the representative runtime import path. A Samva repin requires consumer verification.

The fingerprint in the version is not the artifact digest. Record the separately printed SHA-256
as the archive identity.

## Publish a portable checkpoint

A portable checkpoint is an explicit publication step and requires a clean integration worktree:

```bash
pnpm run checkpoint:integration -- --dry-run
pnpm run checkpoint:integration
```

The command performs a consumer-verified pack, looks for an existing production Scratchpad upload
with the same filename and SHA-256, and returns that immutable URL when present. Otherwise the real
run uploads the artifact through the production Scratchpad profile and verifies the response. The
dry run does not upload.

Checkpoint publication is not implied by packing, committing, pushing, or a request to validate
Samva locally. The checkpoint script is integration-only infrastructure and must be retained when
the integration history is reconstructed even if it has no upstream destination.

## Accept an artifact in Samva

For each explicitly selected Samva head:

1. Set root `catalog.alchemy` to the packer's exact local `file:` reference or an approved immutable
   checkpoint URL.
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
| Provider plan | Read-only proposed infrastructure changes |
| Deploy/apply | Provider and state mutation |
| Customer-path verification | Observed application behavior |

Success at one gate does not authorize the next.
