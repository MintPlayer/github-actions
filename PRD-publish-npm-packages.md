# PRD — `publish-npm-packages` action

**Status:** Draft
**Author:** Pieterjan De Clippel
**Date:** 2026-05-23
**Repo:** `MintPlayer/github-actions`
**Tracking issue:** _TBD — file under MintPlayer/github-actions once this draft is approved_

---

## 1. Problem

The release workflow in `MintPlayer/mintplayer-ng-bootstrap` currently publishes 13 npm packages to 2 registries (npmjs + GitHub Packages). The same publish snippet is repeated 32 times — 16 packages × 2 registries — managed today through four matrix jobs in `.github/workflows/publish-master.yml`:

- `publish-npm-core` (10 packages → npmjs)
- `publish-npm-wrappers` (3 packages → npmjs, depends on core)
- `publish-ghpkg-core` (10 packages → GitHub Packages)
- `publish-ghpkg-wrappers` (3 packages → GitHub Packages, depends on core)

Each matrix lists every package by hand. When a new library is added under `libs/`, four matrices must be updated in lockstep, and forgetting one silently skips publishing to a registry. The existing in-consumer composite action (`.github/actions/publish-npm-package`) collapses the per-step boilerplate but does not solve the matrix-duplication problem.

## 2. Goal

Ship a single JavaScript GitHub Action in `MintPlayer/github-actions` that:

1. **Auto-discovers** every publishable `package.json` under a caller-provided folder.
2. **Publishes each discovered package to every caller-provided registry** in one invocation.
3. **Honours peer-dependency ordering** automatically (no hand-curated "core vs wrappers" split).
4. **Skips already-published versions** instead of failing the run.
5. **Produces a single readable step summary** of what was published, skipped, and failed.

After adoption, the four matrix jobs in `publish-master.yml` collapse into one job per folder root (typically two: `dist/libs` and `libs/mintplayer-ng-bootstrap-snippets`).

## 3. Non-goals

- **Not a Visual Studio Marketplace publisher.** `HaaLeo/publish-vscode-extension` continues to handle that step.
- **Not a Docker image publisher.** GHCR pushes stay in `docker/build-push-action`.
- **Not a version bumper.** The action publishes what it finds; it does not edit `package.json` versions.
- **Not a build step.** The caller is responsible for producing `dist/` before invoking this action.
- **No support for registries other than npm-protocol registries.** No JFrog/Artifactory-specific features in v1 (they speak the npm protocol and should work; we just don't promise it).

## 4. Public contract

### 4.1 `action.yml`

```yaml
name: 'Publish npm packages'
description: 'Discover and publish every npm package in a folder to one or more registries.'
author: MintPlayer

inputs:
  folder:
    description: 'Folder to scan recursively for publishable package.json files.'
    required: true
  registries:
    description: |
      JSON array of registry descriptors. Each entry:
        { "url": string,                  # required, http(s)
          "token": string,                # required
          "access": "public"|"restricted",# optional, default "public"
          "skipDuplicate": boolean,       # optional, default true
          "provenance": boolean }         # optional, default: true on registry.npmjs.org, false elsewhere
    required: true
  order:
    description: |
      Optional JSON array-of-arrays of package-name globs that overrides the
      computed topological order. Useful when peerDependencies don't capture
      the real ordering constraint.
    required: false
  concurrency:
    description: 'Max packages published in parallel within a wave.'
    required: false
    default: '4'
  dry-run:
    description: 'If true, run npm publish --dry-run instead of publishing.'
    required: false
    default: 'false'

outputs:
  published:
    description: 'JSON array of {name, version, registry} tuples that were actually published.'
  skipped:
    description: 'JSON array of {name, version, registry, reason} tuples that were skipped (e.g. already published).'
  failed:
    description: 'JSON array of {name, version, registry, error} tuples that failed.'

runs:
  using: 'node20'
  main: '../dist/publish-npm-packages/index.js'
```

### 4.2 Caller example (target shape after migration)

```yaml
publish-npm:
  needs: build
  runs-on: ubuntu-latest
  permissions:
    contents: read
    id-token: write
    packages: write
  steps:
    - uses: actions/checkout@v4
    - uses: actions/download-artifact@v4
      with: { name: dist, path: dist }

    - name: Publish dist/ packages
      uses: MintPlayer/github-actions/publish-npm-packages@main
      with:
        folder: dist/libs
        registries: |
          [
            { "url": "https://registry.npmjs.org", "token": "${{ secrets.PUBLISH_TO_NPMJS }}" },
            { "url": "https://npm.pkg.github.com", "token": "${{ github.token }}" }
          ]

    - name: Publish snippets (source, npmjs only)
      uses: MintPlayer/github-actions/publish-npm-packages@main
      with:
        folder: libs/mintplayer-ng-bootstrap-snippets
        registries: |
          [
            { "url": "https://registry.npmjs.org", "token": "${{ secrets.PUBLISH_TO_NPMJS }}" }
          ]
```

This replaces four matrix jobs (~150 lines of YAML) with one job containing two steps.

## 5. Behaviour

### 5.1 Discovery

- Recursively glob `folder/**/package.json` using `fast-glob` with `ignore: ['**/node_modules/**']` and `followSymbolicLinks: false`.
- A hit is **publishable** iff: `private !== true`, `name` is a non-empty string, `version` is a non-empty string.
- Discovered packages are sorted alphabetically by `name` for deterministic logs.
- If no publishable packages are found, the action **fails** with a clear message — silent no-op is a footgun for release pipelines.

### 5.2 Input parsing

- `registries` is parsed with `JSON.parse`; malformed input fails the action with a parse error pointing at the offending position.
- Each entry is schema-validated (URL is `http(s)`, token is non-empty). Failures cite `registries[i].field`.
- Every parsed token is re-registered via `core.setSecret()` as a defensive mask in case the caller passed a literal token instead of `${{ secrets.X }}`.

### 5.3 Ordering

- Build a directed graph over **discovered package names only**. Edges = entries in `peerDependencies` and `dependencies` that are themselves in the discovered set. (External deps are ignored — they're already published.)
- Kahn's algorithm produces ordered **waves**. Each wave is a set of packages with no remaining intra-discovered-set dependencies.
- Within a wave, publish packages in parallel (bounded by `concurrency`, default 4). Waves are strictly sequential.
- Cycles abort the action with the cycle path printed.
- If the optional `order` input is provided, it overrides the computed waves (escape hatch for ordering constraints that aren't expressed in `package.json`).

### 5.4 Publishing engine

- Use the `@jsdevtools/npm-publish` library (v4.x) programmatically — **not** a shell-out to `npm publish`.
  - Rationale: it already implements skip-duplicate (409/`EPUBLISHCONFLICT` handling), per-call isolated `.npmrc` via `npm_config_userconfig`, and a clean Promise-returning API. Re-implementing this on `@actions/exec` would re-derive the same logic.
- For each (package, registry) pair:
  - `strategy: "all"` (publish iff the exact `version` isn't already in the registry).
  - `provenance: registry.provenance ?? (registry.url === 'https://registry.npmjs.org')` — npm provenance attestations are an **npmjs.com** feature; GitHub Packages rejects `--provenance` (as of 2026-01). Default reflects that.
  - `access: registry.access ?? 'public'`.
  - `dryRun: inputs['dry-run'] === 'true'`.
- **Failure isolation:** each call is `try/catch`ed. One failure does not abort sibling packages or the next registry. At the end, if any failures occurred, the action calls `core.setFailed()` with a count and the step exits non-zero.
- **Sequential per package across registries, parallel across packages within a wave.** Same tarball, two registries — no wall-clock benefit to parallelising, and serial output is more readable.

### 5.5 Step summary

- Markdown table written via `core.summary.addTable(...).write()`:

  | Package | Version | Registry | Status |
  |---|---|---|---|
  | @mintplayer/web-components | 1.2.3 | https://registry.npmjs.org | published |
  | @mintplayer/web-components | 1.2.3 | https://npm.pkg.github.com | skipped (already published) |
  | @mintplayer/react-bootstrap | 1.2.3 | https://registry.npmjs.org | **FAIL: ENEEDAUTH** |

- The same data is also emitted as the `published` / `skipped` / `failed` outputs (JSON arrays) for downstream steps.

## 6. Implementation plan

The action folder layout follows the existing convention in this repo:

```
publish-npm-packages/action.yml             # entry point
src/publish-npm-packages/index.ts           # ncc entry
src/publish-npm-packages/main.ts            # run(...) — pure orchestration
src/publish-npm-packages/discover.ts        # discoverPackages(root) -> DiscoveredPackage[]
src/publish-npm-packages/topo.ts            # toWaves(packages) -> string[][]
src/publish-npm-packages/publish.ts         # publishOne(pkg, registry, opts) -> Result
src/publish-npm-packages/summary.ts         # renderSummary(results)
dist/publish-npm-packages/index.js          # ncc output (committed; minified)
```

Build script additions to `package.json`:

```json
"pack:publish-npm-packages": "ncc build lib/publish-npm-packages -o dist/publish-npm-packages --minify"
```

…added to the `all` script.

Production dependencies added:
- `fast-glob` — package discovery
- `@jsdevtools/npm-publish` (v4) — publish engine
- `p-limit` — bounded parallelism

`@actions/core` and `@actions/exec` are already present.

### 6.1 Open implementation decision — Node runtime + ESM

`@jsdevtools/npm-publish@4` is **ESM-only** and requires **Node ≥20**. The other actions in this repo declare `using: node16` in their `action.yml`. Two choices:

- **(a) Per-action runtime.** Set `using: node20` only on `publish-npm-packages/action.yml` and confirm `ncc --minify` produces a runnable CJS bundle from an ESM source. Smallest blast radius.
- **(b) Repo-wide migration.** Bump every action in this repo to `node20`. Larger PR but removes a divergence.

**Recommendation:** (a) for v1. Migrate the rest later if it pays off.

If `ncc` cannot bundle the ESM library cleanly, fall back to pinning `@jsdevtools/npm-publish@3.x` (last CJS major) and accept the slightly older feature set.

## 7. Migration from current workflow

Drop-in steps for `mintplayer-ng-bootstrap/.github/workflows/publish-master.yml`:

1. Remove the four matrix jobs (`publish-npm-core`, `publish-npm-wrappers`, `publish-ghpkg-core`, `publish-ghpkg-wrappers`).
2. Remove the in-consumer composite action at `.github/actions/publish-npm-package` (now redundant).
3. Add a single `publish-npm` job needing `build`, using the new action twice — once for `dist/libs` (both registries), once for `libs/mintplayer-ng-bootstrap-snippets` (npmjs only).
4. Update the `deploy` job's `needs:` list from `[build, publish-npm-core, publish-npm-wrappers, publish-ghpkg-core, publish-ghpkg-wrappers]` to `[build, publish-npm]`.

Net diff: ~150 YAML lines removed; one matrix to maintain (the implicit one inside the action) instead of four.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Secret token leaks in step logs when embedded in JSON | `core.setSecret(token)` on every parsed token; rely on substring masking. |
| ESM/ncc bundling fails | Fallback path documented in §6.1 (pin v3). |
| Provenance request fails on GHPR | Per-registry `provenance` default key, off for non-npmjs. |
| Discovery picks up an unintended `package.json` (e.g. transitive `node_modules`) | `ignore: ['**/node_modules/**']` + `private: true` filter. |
| Peer-dep cycle in the discovered set | Action fails loud, prints the cycle path — cycles are real bugs. |
| One bad package blocks others | Per-call `try/catch`; aggregate at the end. |
| Edge-cache lag means wave-N+1 publishes before wave-N's packuments propagate, breaking `npm install` for early consumers | Optional: post-wave `GET /:pkg/:version` poll with retry. Defer to v1.1 unless we see real failures. |

## 9. Out of scope (possible v1.1)

- Post-wave packument propagation polling (see §8).
- Registry-specific health checks (HEAD against the registry URL before publishing).
- Configurable `tag` (currently we publish to `latest` only).
- Reading from `.tgz` tarballs rather than directories.
- Honouring `publishConfig` in each package.json (lib already does this — verify and document).

## 10. Acceptance criteria

1. Running the action against `dist/libs` of `mintplayer-ng-bootstrap` (with 13 packages) publishes all of them to both configured registries in one job.
2. Re-running the workflow on the same commit produces a green step where every package is reported as **skipped (already published)**.
3. Adding a new library under `libs/` requires **zero workflow edits** — it is picked up automatically on the next release.
4. Removing `mintplayer-ng-bootstrap-snippets` from npmjs (or any single package) and re-running publishes only that one; the rest are skipped.
5. The step summary table renders correctly and lists every (package × registry) pair.
6. With `dry-run: true`, no registry receives a write but the summary shows what would have been published.
