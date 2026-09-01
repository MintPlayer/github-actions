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
