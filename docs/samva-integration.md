# Samva’s Alchemy integration

`samva/integration` supplies Samva’s pinned Alchemy distribution. Samva installs core, provider,
runtime, and SDK archives as one dependency closure. The Distilled gitlink pins the SDK source.

| Surface | Integration behavior |
| --- | --- |
| Distribution | The packer builds publishable archives and records their SHA-256 digests, Alchemy commit, Distilled gitlink and input fingerprints. |
| AWS durable execution | Workflow start receipts, execution references, callback and result encodings, and durable handles preserve existing executions. Lambda pins each numbered runtime before promoting its alias. |
| Lambda and local AWS | The fork carries IAM policy compaction, environment-size validation and pre-create cleanup. Per-service endpoints and provider sessions connect Samva to its own Floci and local Lambda placement. Scoped Cloudflare bindings carry their account into Lambda. |
| Core and CLI | The CLI supports a configurable data directory, immutable compilation and watch control. Apply revisits planned noops after dependency outputs change and checks ownership before promotion. Bundling preserves runtime references and captured config. |
| Artifacts | Local bindings use disk-backed metadata and a Git sidecar. `Alchemy.remote()` selects a preview bridge that preserves typed errors and uses one RPC session per operation. Local storage is keyed by namespace. Samva owns its stage and repository cleanup. |
| Vite and Workers | A Vite config loaded again during a build inherits that build’s Cloudflare options. A build-only prerender Worker serves the preview and stays outside deploy output. Local dev preserves cached imports across request teardown, supports synthetic asset URLs and retries timed-out preview prefetches on demand. Ports, Worker lifecycle and WebSocket handling come from upstream. |
| Cloudflare configuration | AI Gateway exposes `byokOnly`. Flagship preserves live rules when `rules` is omitted and clears them when passed an empty array. Zone lookup follows upstream. DNS name and type edit in place, and moving a record to a new zone replaces it. |

## Refresh the distribution

1. Select an upstream commit and preserve the current producer commit. Compare the carried
   behavior against upstream. Port it in dependency order, record each old commit’s disposition in
   the delivery ledger, and review the range diff. Verify retrieval of the pinned Distilled gitlink.
2. Run workspace typecheck, owning provider and runtime suites, and compatibility fixtures for
   stored state and in-flight executions.
3. Pack with the Bun, Node and pnpm versions in the producer manifest. Consumer verification
   installs the archives in a fresh directory and exercises declarations and runtime imports.

   ```sh
   mise x bun@1.3.13 node@24 pnpm@12.15.0 -- bun run pack:integration -- --verify consumer
   ```

4. Install the receipt’s complete set as `file:` catalog entries and overrides in a disposable
   Samva copy. Run the affected builds, tests and typechecks. Verify deploy output for builds with
   extra Worker environments.
5. With publication approval, inspect the collection with `checkpoint:integration -- --dry-run`,
   then run `checkpoint:integration` from the reviewed producer commit. Verify immutable filenames,
   digests and downloadable bytes against the receipt.
6. Repin Samva’s catalog and overrides together to the verified URLs and regenerate `bun.lock`.
   Verify state conversion, resource identity and version promotion in the Samva deployment plan
   before applying the repin.
