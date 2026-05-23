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
