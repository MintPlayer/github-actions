# GitHub Actions
This repository contains several GitHub Actions to help organize git repositories.

## delay
### Usage

    - uses: MintPlayer/github-actions/delay@main
      with:
        milliseconds: '1000'

## cherry-pick-action
### Usage

    - uses: MintPlayer/github-actions/cherry-pick@main
      with:
        milliseconds: '1000'


## compile-ts-action
The TypeScript → single `index.js` pipeline every node action in this org needs, as one
composite action. Callers supply where and what, never how.

Two modes, one code path. They differ only in the last step, so a green `verify` on a pull
request is real evidence that the later `push` produces the same bytes:

| mode | behaviour |
|---|---|
| `verify` | rebuild, and fail if the committed bundle differs. For pull requests. |
| `push` | rebuild, commit the bundle, push, and move the tags consumers pin. |

### Usage — verify on a pull request

    - uses: MintPlayer/github-actions/compile-ts-action@main
      with:
        working-directory: apps/CodeCoverage/action
        node-version: 20.x
        mode: verify

### Usage — publish on a push to the default branch

    - uses: actions/checkout@v4
      with:
        fetch-depth: 0
        fetch-tags: true

    - uses: MintPlayer/github-actions/compile-ts-action@main
      with:
        working-directory: apps/CodeCoverage/action
        mode: push
        commit-message: 'build: repack the coverage-upload bundle'
        major-tag: coverage-upload-v1
        version-tag-from: apps/CodeCoverage/action/package.json
        version-tag-prefix: coverage-upload-v

The job needs `permissions: contents: write` in `push` mode.

### Inputs

| Input | Default | Notes |
|---|---|---|
| `working-directory` | `.` | Directory holding the action package (its own `package.json` and lockfile). |
| `output-dir` | `dist` | Bundle directory, relative to `working-directory`. |
| `node-version` | `20.x` | Used to build. Should match the action's `runs.using` runtime. |
| `install-command` | `npm ci` | `npm ci` enforces the lockfile; `npm install` does not. |
| `test-command` | `npm test` | Runs **before** the build, so a failing suite cannot produce a published bundle. Empty string skips it — explicitly. |
| `build-command` | `npm run build` | Must write the bundle into `output-dir`. |
| `mode` | `verify` | `verify` or `push`. |
| `commit-message` | `build: repack the action bundle` | `push` mode only. |
| `major-tag` | — | Moving tag force-updated to the commit just pushed, e.g. `coverage-upload-v1`. This is what consumers pin. Empty means do not tag. |
| `version-tag-from` | — | `package.json` whose `version` mints an immutable tag. Relative to the **repository root**, not to `working-directory`. |
| `version-tag-prefix` | `v` | e.g. `coverage-upload-v` → `coverage-upload-v1.2.0`. |
| `token` | `${{ github.token }}` | Applied as a git extraheader, so `push` mode works regardless of the caller's `persist-credentials` setting. |

### Outputs

| Output | Notes |
|---|---|
| `changed` | `true` when the rebuild produced a bundle different from the committed one. |
| `version-tag` | The immutable tag created, or empty. |

### Two tag levels, only one of which moves

| Tag | Moves? | Who uses it |
|---|---|---|
| `coverage-upload-v1.2.0` | never; cut once, on one commit | anyone needing a reproducible pin |
| `coverage-upload-v1` | force-updated to the latest compatible commit | all consumers, by default |

`push` mode **refuses** to move an existing version tag — an immutable tag that moves is
worse than no tag, because anything pinned to it stops being reproducible. Bump the version
instead. The major tag is the only ref that is ever force-pushed.

### Notes

- `install-command`, `test-command` and `build-command` are arbitrary shell, by design.
  Never wire an untrusted value (a PR title, a branch name, an issue body) into them — in
  `push` mode this action holds `contents: write`.
- `push` mode only runs on a branch. On a tag-triggered run `GITHUB_REF_NAME` is the tag
  name, and pushing `HEAD` to it would create a branch named after a tag.
- The drift check fails **closed**: a missing checkout, a typo'd `output-dir`, or a
  gitignored bundle is an error, not a silent pass. `git status --porcelain` exits 0 with
  empty output for a pathspec that matches nothing, so the naive check reports "no drift"
  in exactly the cases where it knows least.

## coverage-upload
Uploads coverage reports to a self-hosted [Coverage](https://coverage.mintplayer.com)
instance and, optionally, waits for the server to finalize the build so a CI job can gate
on the result. Moved here from `MintPlayer/CodeCoverage`; the server itself now lives in
`MintPlayer/MintPlayer.Spark` under `apps/CodeCoverage`.

### Usage

    - uses: MintPlayer/github-actions/coverage-upload@main
      with:
        url: https://coverage.mintplayer.com
        token: ${{ secrets.COVERAGE_TOKEN }}
        files: |
          tests/*/coverage/**/coverage.cobertura.xml
        flags: dotnet
        finish: true

On a pull request, declare that the run measured only part of the workspace so the server
compares like for like instead of reading the totals as a collapse:

    - uses: MintPlayer/github-actions/coverage-upload@main
      with:
        url: https://coverage.mintplayer.com
        token: ${{ secrets.COVERAGE_TOKEN }}
        files: tests/*/coverage/**/coverage.cobertura.xml
        partial: true
        base-sha: ${{ github.event.pull_request.base.sha }}
        finish: true

Inside a GitHub Actions workflow you can drop `token` entirely and authenticate with the
job's OIDC identity, provided the job requests `id-token: write`:

    - uses: MintPlayer/github-actions/coverage-upload@main
      with:
        url: https://coverage.mintplayer.com
        use-oidc: true

### Inputs
`url` is the only required input.

- `url` (**required**) — base URL of the Coverage server.
- `token` — upload token. Omit when using `use-oidc`.
- `use-oidc` (default `false`) — authenticate with the job's OIDC token instead of `token`.
  Needs `permissions: id-token: write`.
- `files` — newline-separated globs of coverage reports. Cobertura and lcov are both accepted.
- `directory` — directory to search when `files` is not given.
- `disable-search` (default `false`) — do not auto-detect reports. Recommended: a glob that
  matches nothing then uploads nothing, rather than sweeping up stray unparsable files.
- `flags` — label for this upload, so several partial uploads on one commit stay distinguishable
  (`dotnet`, `angular`, …).
- `partial` (default `false`) — this run measured only a subset. Pair with `base-sha`.
- `base-sha` — the commit to compare against.
- `name` — display name for the upload.
- `finish` (default `false`) — signal that no further uploads are coming for this build.
- `fail-ci-if-error` (default `false`) — fail the step when the upload fails.
- `wait-for-finalize` (default `false`) — block until the server finalizes the build, so the
  job can gate on `state`.
- `wait-timeout` (default `1800`) and `wait-poll-interval` (default `5`) — seconds.

### Outputs
26 outputs, useful mainly with `wait-for-finalize: true`. The ones most jobs read:

- `state` — `Complete`, `CompleteWithErrors` or `InFlight`.
- `build-id`, `session-id`, `build-status`, `finalize-reason`, `commit-url`.
- Totals: `lines-covered`, `lines-coverable`, `line-rate`, `branches-covered`, `branches-total`,
  `branch-rate`, `files-count`.
- Patch coverage: `patch-lines-covered`, `patch-lines-coverable`, `patch-rate`,
  `patch-diff-truncated`.
- Baseline comparison: `base-resolution`, `resolved-base-sha`, `baseline-sha`,
  `baseline-lines-covered`, `baseline-lines-coverable`, `baseline-line-rate`.
- Projection, while a partial upload is still incomplete: `projection-line-rate`,
  `projection-complete`, `projection-incomplete-reasons`.

The upload API these map onto is documented in
[`docs/code-coverage/upload-api.md`](https://github.com/MintPlayer/MintPlayer.Spark/blob/master/docs/code-coverage/upload-api.md)
and is stable: fields are added, never removed.

## publish-npm-packages
Auto-discovers every publishable `package.json` under a folder and publishes
each one to one or more npm-protocol registries. Honours peer-dependency
ordering, skips already-published versions, and reports per-(package,
registry) status in the step summary.

### Usage

    - uses: MintPlayer/github-actions/publish-npm-packages@main
      with:
        folder: dist/libs
        registries: |
          [
            { "url": "https://registry.npmjs.org", "token": "${{ secrets.PUBLISH_TO_NPMJS }}" },
            { "url": "https://npm.pkg.github.com", "token": "${{ github.token }}" }
          ]

### Inputs
- `folder` (required) — folder to scan recursively for `package.json`.
- `registries` (required) — JSON array of `{ url, token, access?, skipDuplicate?, provenance? }`.
- `order` (optional) — JSON array-of-arrays of package-name globs to override the
  computed topological order.
- `concurrency` (optional, default `4`) — max packages published in parallel per wave.
- `dry-run` (optional, default `false`).

`provenance` defaults to `true` on `https://registry.npmjs.org` and `false`
elsewhere (GitHub Packages does not currently accept Sigstore provenance).
