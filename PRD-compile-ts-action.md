# PRD — `compile-ts-action`

**Status:** In progress
**Author:** Pieterjan De Clippel
**Date:** 2026-09-01
**Repo:** `MintPlayer/github-actions`
**Tracking issue:** [#7](https://github.com/MintPlayer/github-actions/issues/7)
**Branch:** `feat/compile-ts-action`

---

## 1. Problem

This repository builds six TypeScript actions into six committed `dist/<name>/index.js` bundles
through one root `package.json` (`npm run all` → `tsc` → six `ncc build --minify` invocations). That
pipeline exists only as the `steps:` block of `.github/workflows/publish.yml` — it cannot be reused,
and it has never been exercised anywhere else.

[MintPlayer.Spark#349](https://github.com/MintPlayer/MintPlayer.Spark/pull/349) moves the
`coverage-upload` **source** to `apps/CodeCoverage/action`, beside the API it talks to, while the
**build system** must stay here, unduplicated. That PR already references
`MintPlayer/github-actions/compile-ts-action@main`, so its `coverage-action` job fails until this
lands.

Extracting the pipeline also forces three latent defects into the open. They are fixed here rather
than carried over:

| # | Defect | Consequence |
|---|---|---|
| 1 | No `pull_request` workflow at all | The jest suite has **never** run in CI, and bundle staleness is never checked before merge |
| 2 | `git diff --name-only dist` compares tracked files only | On a first-ever build of a *new* action folder the bundle is untracked, the diff is empty, the commit is silently skipped, and the published action is an empty directory |
| 3 | `ad-m/github-push-action` with `tags: true, force: true` | Force-pushes **every tag in the repository** as a side effect of publishing a bundle |

Plus: `npm install` rather than `npm ci`, so the lockfile is not enforced for an artifact that ships
to consumers; and `node-version: 18.x` while `coverage-upload` and `publish-npm-packages` declare
`runs.using: node20`.

## 2. Goal

One composite action, `compile-ts-action`, owning the TypeScript → single `index.js` pipeline for
every node action in the org. Callers supply **where** and **what**, never **how**.

Two modes, one code path:

| mode | behaviour | used by |
|---|---|---|
| `verify` | rebuild, fail if the committed bundle differs | `pull_request` |
| `push` | rebuild, commit the bundle, push, move the tags consumers pin | `push` to `main` |

They must differ **only** in the last step, so that a green `verify` on a pull request is real
evidence that the later `push` produces the same bytes. §5.3 explains why this premise does not
survive the spec as originally written, and what it takes to restore it.

## 3. Non-goals

- **Deleting `coverage-upload/` from this repo.** Five repositories are still pinned at
  `MintPlayer/CodeCoverage/action@master` (an *archived* repo — the ref resolves, but that bundle can
  never be rebuilt). They must be repointed at
  `MintPlayer/MintPlayer.Spark/apps/CodeCoverage/action@coverage-upload-v1` **first**. Removing it
  here before that breaks their uploads. Tracked as M6/M7 of the Spark-side plan.
- **Tidying this repository's existing tags** (`v1`, `v2`, `v3`, `v1.0.4`–`v1.0.10`, and one named
  `remove`). Unmaintained; only `v1` has a release, from 2023-11-20. Note for §5.5: `v2` and `v3` are
  **annotated** tags, which is load-bearing.
- **Publishing `compile-ts-action` to the marketplace**, or giving it its own bundle. It is a
  composite action: no TypeScript, no `dist/` entry, no `pack:` script.
- **Migrating the other five actions off `runs.using: node16`.** Separate concern.

## 4. Public contract

### 4.1 `compile-ts-action/action.yml`

```yaml
name: 'Compile TS action'
description: 'Install, test and bundle a TypeScript GitHub Action, then either verify the committed
              bundle is current or commit and tag it'

inputs:
  working-directory:   # default '.'      — dir holding the action package
  output-dir:          # default 'dist'   — bundle dir, relative to working-directory
  node-version:        # default '20.x'   — should match the action.yml `runs.using` runtime
  install-command:     # default 'npm ci' — `npm ci` enforces the lockfile; `npm install` does not
  test-command:        # default 'npm test' — empty string skips testing, explicitly
  build-command:       # default 'npm run build' — must write the bundle into output-dir
  mode:                # default 'verify' — verify | push
  commit-message:      # default 'build: repack the action bundle'
  major-tag:           # default ''       — moving tag consumers pin, e.g. coverage-upload-v1
  version-tag-from:    # default ''       — package.json (repo-root-relative) whose version mints an immutable tag
  version-tag-prefix:  # default 'v'
  token:               # default ${{ github.token }}

outputs:
  changed:             # true when the rebuild produced a bundle different from the committed one
  version-tag:         # the immutable tag created, or empty
```

Full file as implemented; this table is the contract, not a copy.

### 4.2 Caller example — this repository, `pull_request`

```yaml
- uses: ./compile-ts-action        # verifies with its own copy, so a change to the compile
  with:                            # action is exercised by the pull request that makes it
    build-command: npm run all
    mode: verify
```

### 4.3 Caller example — MintPlayer.Spark

```yaml
- uses: MintPlayer/github-actions/compile-ts-action@main
  with:
    working-directory: apps/CodeCoverage/action
    mode: push
    major-tag: coverage-upload-v1
    version-tag-from: apps/CodeCoverage/action/package.json
    version-tag-prefix: coverage-upload-v
```

## 5. Behaviour, and the five places the spec in #7 is wrong

The issue body carries a complete draft of `action.yml` and `publish.sh`. An adversarial review of
that draft against the GitHub Actions runtime found defects that would have shipped. This section
records what changes and why; each is a deliberate deviation from #7, not an oversight.

### 5.1 The drift check must fail **closed** — it currently fails open

```bash
if [ -n "$(git status --porcelain -- "$target")" ]; then   # as drafted in #7
```

`git status --porcelain` returns **exit 0 with empty output** for a pathspec matching nothing, and a
failed command substitution inside `[ ... ]` does not abort under `bash -e`. So:

| condition | git says | `changed` | `verify` result |
|---|---|---|---|
| not a git repo | `fatal:` on stderr, exit 128 (swallowed) | `false` | **green** |
| `output-dir` typo'd, or the build wrote elsewhere | empty, exit 0 | `false` | **green** |
| `dist/` is gitignored in the consumer repo | empty, exit 0 | `false` | **green** |

The headline feature — a PR that edits `src/` without rebuilding fails `verify` — is defeated by a
typo, a missing checkout, or a `.gitignore`. A check that reports success by default is the worst
kind of CI bug.

**Resolution.** Assert the preconditions before trusting the answer: `git rev-parse
--is-inside-work-tree`, `test -d "$target"`, propagate git's exit status, and use
`--ignored=matching` so a gitignored bundle is a loud failure rather than a silent pass.

Note the asymmetry the draft creates: a gitignored `dist` makes `verify` pass silently but makes
`push` fail hard (`git add` on an ignored path exits 1). The two modes disagree about the same repo
— which contradicts the action's own "two modes, one code path" premise.

### 5.2 One drift decision, shared by both modes

The draft computes `changed` in the composite step (worktree `git status`) and then *re-decides it
independently* in `publish.sh` (index-based `git add` + `git diff --cached --quiet`), ignoring the
first answer in `push` mode. The two can disagree, so the action's public `changed` output is not a
reliable statement about whether a commit happened.

**Resolution.** A single `compile-ts-action/drift.sh` that both the composite step and `publish.sh`
source. "Two modes, one code path", made real rather than asserted.

### 5.3 The Node switch — measured, and it is a non-issue. The line endings are not.

The committed `dist/` was produced under `node-version: 18.x` with `npm install`
(`.github/workflows/publish.yml:13`, `:37`). Both new workflows build under `20.x` with `npm ci`.
`ncc` output is a function of the dependency tree the lockfile resolves and of the runtime it runs
under; byte-identical output across a major-version jump is not something to assume.

If it differs, the very PR that introduces `pull-request.yml` fails its own `verify` job, and the
failure reads as *"your bundle is stale"* rather than *"the toolchain moved."*

**Measured rather than assumed.** `npm ci && npm run all` on this machine, under **Node 24.15.0**,
against a `dist/` produced in CI by Node 18 with `npm install`:

```
IDENTICAL dist/cherry-pick/index.js          IDENTICAL dist/get-gpr-version/index.js
IDENTICAL dist/coverage-upload/index.js      IDENTICAL dist/get-npmjs-version/index.js
IDENTICAL dist/delay/index.js                IDENTICAL dist/publish-npm-packages/index.js
```

All six bundles are **byte-identical** (compared with `git hash-object`, not by size). `ncc` output
here is a function of the pinned `@vercel/ncc` version and the dependency tree, not of the Node major
running it. So the concern evaporates: no rebuild is needed, DoD #1 already holds, and the workflows
can move straight to **Node 24** — which is what they do, matching the version this repo is developed
on so a local build and a CI build agree.

**What the measurement actually turned up.** `git status --porcelain -- dist` reported all six files
as modified anyway. The cause is `core.autocrlf=true` (the Git-for-Windows default) with **no
`.gitattributes` in the repository**: the bundles are stored LF and checked out CRLF, so every one
looks rewritten while being byte-identical in content.

That is a live hazard for the feature being built. A Windows contributor who runs the build and
commits gets six 470 KB phantom diffs, and the new drift check fires on line endings rather than on a
real rebuild. It is invisible today only because nothing has ever checked `dist/` for drift.

**Resolution.** A `.gitattributes` pinning `* text=auto eol=lf`, so the bundles are LF on every
platform and drift means drift. DoD #1 is restated as *byte-identical when rebuilt from the same
lockfile*, which is the claim that actually proves the extraction faithful.

### 5.4 `inputs.token` is documented at length and wired to nothing

The draft declares `token` with a paragraph about PATs and workflow-retriggering, then passes it
nowhere. `publish.sh` pushes purely on the credentials `actions/checkout` persisted. A caller who
passes a PAT to get workflow-retriggering silently gets `GITHUB_TOKEN` behaviour instead — the exact
opposite of what the input promises.

**Resolution.** Wire it, the way `actions/checkout` does: a `http.<host>.extraheader` git config
entry carrying `AUTHORIZATION: basic <base64>`, set from the token, cleared by an `EXIT` trap. This
makes the action independent of the caller's `persist-credentials` setting rather than quietly
dependent on it.

**The token is never echoed, never a command-line argument** (process arguments are world-readable
via `/proc`), and never written to a file that outlives the step. It reaches `publish.sh` through the
environment only.

### 5.5 The immutable-tag guard is inert, and misfires on annotated tags

```bash
if existing="$(git rev-parse -q --verify "refs/tags/${version_tag}" 2>/dev/null)"; then
```

Two independent problems:

- **It consults only the local ref store.** The action does not own the checkout. With a default
  `actions/checkout` (depth 1, no tags) the lookup always misses, the script tags and pushes, and the
  *remote* rejects it — the run dies on git's raw `! [rejected] ... (already exists)` instead of the
  carefully worded "bump the version instead of moving a released tag." The guard's correctness would
  depend on an undocumented obligation on every caller.
- **Annotated tags compare wrong.** `git rev-parse refs/tags/T` on an annotated tag returns the *tag
  object* SHA, which never equals `git rev-parse HEAD`. A pre-existing annotated tag pointing **at
  HEAD** is therefore reported as a conflict and fails the run. This is not hypothetical here: `v2`
  and `v3` in this repository are annotated tag objects, and the commented-out "Update Major Tag"
  step in `publish.yml:88` used `git tag -afm`.

**Resolution.** `git fetch --tags --force origin` inside `publish.sh`, so the action stops depending
on the caller's checkout options, and peel both sides with `^{commit}`.

*(The one thing the draft got right in this block: `if existing="$(...)"` does **not** abort under
`set -e`. An assignment takes its command substitution's exit status, and a command used as an `if`
condition is exempt from `-e` regardless. Verified by execution. The construct stays.)*

### 5.6 Every input reaches bash through `env:`, never through `${{ }}` in `run:`

`${{ }}` is substituted into the script *text* before bash parses it. In the draft:

```bash
"${{ github.action_path }}/publish.sh" "${{ inputs.commit-message }}" ...
```

A commit message containing a double quote — `build: repack "dist"`, entirely reasonable —
terminates the argument and produces a malformed command line. The `echo "::error::... '${{
inputs.build-command }}' ..."` in the verify step breaks the same way on a build command containing a
quote, dying with a bash syntax error instead of printing the intended diagnostic.

**Resolution.** All inputs cross into bash via `env:`; `publish.sh` reads named environment variables
and takes **no positional arguments** (six positionals, several routinely empty, is its own hazard).

The three command inputs (`install-`, `test-`, `build-command`) remain deliberate arbitrary-code
inputs — that is what they are for — and are documented as trusted.

### 5.7 Smaller corrections

| # | Correction |
|---|---|
| a | `bash "$GITHUB_ACTION_PATH/publish.sh"`, not `"…/publish.sh"` as an executable — no dependence on an exec bit that a Windows checkout drops silently, and no `${{ }}` in `run:` |
| b | `push` mode refuses to run unless `GITHUB_REF_TYPE` is `branch`. `git push origin HEAD:$GITHUB_REF_NAME` on a tag-triggered or `workflow_dispatch`-on-a-tag run either creates a *branch* named `v1.2.0` or is rejected non-fast-forward |
| c | `node -p 'require(process.argv[1]).version' "$PWD/$version_tag_from"`, plus a guard — the draft interpolates the path into a single-quoted JS string (injection) and prints `undefined` for a package.json with no `version`, minting a permanent tag named `vundefined` |
| d | `publish.yml` loses `strategy.matrix.node-version: [18.x]` and the now-dead `env.DIST_FOLDER`. Left in place, a second matrix entry would run two publishers that both commit, both push, and both force-move the major tag |
| e | `concurrency:` on both workflows — queue (never cancel) on publish, cancel-in-progress on PR |
| f | `pull-request.yml` carries a comment: **never** convert to `pull_request_target`, never add a secret. On `pull_request` the checked-out merge commit contains the *fork's* `compile-ts-action/`, including three arbitrary `run:` commands. With `contents: read` and no secrets that is the accepted bargain; with `pull_request_target` it is not |

### 5.8 Pre-existing: every test in this repo runs twice

`tsconfig.json` does not exclude `*.test.ts`, so `tsc` emits the suite into `lib/`; `jest.config.js`
sets no `roots`/`testPathIgnorePatterns`, so jest collects both copies. Measured on this working
tree: `jest --listTests` returns 8 entries for 4 suites, and `npm test` reports **13 failed, 57
passed** where `npx jest src` reports **35 passed**.

CI passes today only by luck of ordering — `npm ci` gives a fresh tree with no `lib/`, and the
composite action deliberately runs Test *before* Build. Anything that warms the workspace (a
self-hosted runner, a `lib/` cache, a re-run) turns CI red for reasons unrelated to the change under
test.

This lands here because DoD #3 makes this PR the first-ever CI test run. One line in `jest.config.js`.

## 6. Implementation plan

```
compile-ts-action/
  action.yml          composite; no bundle, no pack: script
  drift.sh            the single drift decision, sourced by both modes  (§5.2)
  publish.sh          commit, push, tag                                 (§5.4, §5.5)
src/compile-ts-action/
  publish.test.ts     behavioural: bare origin + work clone in a temp dir
  metadata.test.ts    action.yml lint: inputs resolve, steps have shell:, outputs bind
.github/workflows/
  pull-request.yml    new
  publish.yml         converted
```

| M | Milestone | Commit |
|---|---|---|
| M0 | This PRD | `docs: PRD for compile-ts-action` |
| M1 | `jest.config.js` test-path fix (§5.8); `.gitattributes` (§5.3); `yaml` devDependency for the metadata test | `fix(test): stop running every suite twice; pin bundles to LF` |
| M2 | `action.yml`, `drift.sh`, `publish.sh` | `feat: compile-ts-action` |
| M3 | Both test suites | `test: cover publish.sh and the action metadata` |
| M4 | Both workflows, on Node 24 | `ci: verify bundles on PR; publish via compile-ts-action` |
| M5 | README | `docs: document compile-ts-action` |

### 6.1 How `publish.sh` is tested

Not mocked. A jest fixture creates a bare `origin.git` and a work clone in `mkdtempSync`, sets
`GITHUB_REF_NAME` / `GITHUB_OUTPUT` / `GITHUB_REF_TYPE`, runs the real script, and asserts on the
**origin's** log and tags. Covered: commits and pushes drift; mints both tags; refuses to move an
existing version tag and leaves it pointing where it did; no-ops when there is no drift; force-moves
the major tag onto a newer release; peels an annotated tag correctly (§5.5).

**`bash` on PATH is WSL on this machine**, not Git Bash — verified, and it cannot see `C:\` paths
(`/bin/bash: C:UserspieteAppData...: No such file or directory`). The helper resolves Git Bash off
`git --exec-path` and invokes it with `--noprofile --norc`. Fixture repos set `core.autocrlf=false`
(otherwise every `git add` writes a CRLF warning to stderr that assertions trip over) and disable
`commit.gpgsign` / `core.hooksPath`, which a temp repo would otherwise inherit from global config and
hang on a passphrase prompt.

Tests live in `src/compile-ts-action/`, not beside the script: `tsconfig.json` has `rootDir: ./src`
with `include: ["**/*.ts"]`, so a `.ts` file outside `src/` fails the build with TS6059.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| ~~Node 18→20 moves the bundle bytes; the PR fails its own verify~~ | **Closed.** Measured byte-identical across 18→24 (§5.3) |
| A Windows contributor's CRLF checkout makes the drift check fire on line endings | `.gitattributes` pins `eol=lf` (§5.3) |
| A consumer without a `test` script gets a red build from the `npm test` default | Documented; `apps/CodeCoverage/action` must ship a `test` script or pass `test-command: ''` explicitly |
| `push` mode holds `contents: write` and runs three caller-supplied commands | Inherent to the job; mitigated by never granting it on `pull_request` (§5.7f) |
| The token rework diverges from what `actions/checkout` persisted | `extraheader` is exactly checkout's own mechanism; trap-cleared (§5.4) |
| `node-version: 24.x` resolves to the newest 24 at run time, so a future patch could in principle move the bytes | Bundles proved insensitive to the Node major (§5.3); if it ever happens, `verify` catches it on the next PR rather than shipping it |

## 8. Acceptance criteria

1. `delay`'s `dist/index.js` is byte-identical after a `mode: push` run **rebuilt under the same Node
   version** (§5.3).
2. A pull request that edits `src/` without rebuilding fails the new `verify` job — *and* a PR that
   points `output-dir` at a nonexistent directory fails it too, rather than passing (§5.1).
3. `npm test` appears in a workflow log, for the first time in this repository.
4. The `coverage-action` job in MintPlayer.Spark#349 goes green.
5. `coverage-upload/` is still present and still working.
6. `npx jest --listTests` returns one entry per suite (§5.8).
