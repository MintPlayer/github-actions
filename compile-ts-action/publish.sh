#!/usr/bin/env bash
# Commits the rebuilt bundle and moves the tags consumers pin.
#
# Every parameter arrives through the ENVIRONMENT, never as a positional argument and
# never as ${{ }} pasted into a run: block. Two reasons: a commit message containing a
# double quote would otherwise break the command line it was pasted into, and a token
# passed as an argument is world-readable through /proc for the life of the process.
set -euo pipefail

: "${WORKING_DIRECTORY:?WORKING_DIRECTORY is required}"
: "${OUTPUT_DIR:?OUTPUT_DIR is required}"
: "${COMMIT_MESSAGE:?COMMIT_MESSAGE is required}"

major_tag="${MAJOR_TAG:-}"
version_tag_from="${VERSION_TAG_FROM:-}"
version_tag_prefix="${VERSION_TAG_PREFIX:-v}"
github_output="${GITHUB_OUTPUT:-/dev/null}"
target="${WORKING_DIRECTORY}/${OUTPUT_DIR}"

# `git push origin HEAD:$GITHUB_REF_NAME` is only correct on a branch. On a tag-triggered
# run or a workflow_dispatch against a tag, GITHUB_REF_NAME is the tag name -- which either
# creates a BRANCH called v1.2.0 or is rejected non-fast-forward.
if [ "${GITHUB_REF_TYPE:-branch}" != 'branch' ]; then
  echo "::error::push mode needs a branch ref, but this run is on ${GITHUB_REF_TYPE:-}/${GITHUB_REF_NAME:-}." >&2
  exit 1
fi
: "${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"

# -- credentials --------------------------------------------------------------
# An extraheader entry, exactly as actions/checkout persists one. Wiring the token here
# rather than relying on whatever the caller's checkout left behind is what makes the
# `token` input mean something -- and makes the action work under persist-credentials:
# false. The value is never echoed and never outlives the step.
server_host="${GITHUB_SERVER_URL:-https://github.com}"
credential_key="http.${server_host}/.extraheader"

clear_credential() {
  git config --local --unset-all "$credential_key" 2>/dev/null || true
}

if [ -n "${GH_TOKEN:-}" ]; then
  trap clear_credential EXIT
  clear_credential
  git config --local --add "$credential_key" \
    "AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
fi

# -- the bundle ---------------------------------------------------------------
# shellcheck source=./drift.sh
. "$(dirname "${BASH_SOURCE[0]}")/drift.sh"

changed="$(detect_drift "$target")"
echo "changed=${changed}" >> "$github_output"

if [ "$changed" = 'true' ]; then
  git config --local user.name 'github-actions[bot]'
  git config --local user.email '41898282+github-actions[bot]@users.noreply.github.com'

  git add -- "$target"
  git commit -q -m "$COMMIT_MESSAGE"

  # Not a force push: this branch carries other people's work. A non-fast-forward here
  # means somebody pushed while we were building, and failing is the correct answer.
  git push origin "HEAD:${GITHUB_REF_NAME}"
  echo "Pushed a rebuilt ${target}."
else
  echo "Bundle unchanged; nothing to commit."
fi

# -- the immutable tag --------------------------------------------------------
version_tag=''
if [ -n "$version_tag_from" ]; then
  # The path goes in through argv, not spliced into the JS source: a single quote in it
  # would otherwise escape the string literal and run as code.
  version="$(node -p 'require(process.argv[1]).version' "${PWD}/${version_tag_from}")"
  if [ -z "$version" ] || [ "$version" = 'undefined' ]; then
    echo "::error::${version_tag_from} has no \"version\" field; refusing to cut a tag named ${version_tag_prefix}undefined." >&2
    exit 1
  fi
  version_tag="${version_tag_prefix}${version}"

  # The guard below is only meaningful against the REMOTE's refs. This action does not own
  # the checkout, and a default actions/checkout fetches no tags -- so without this the
  # lookup always misses, the push is rejected, and the run dies on git's raw "! [rejected]"
  # instead of the explanation underneath.
  git fetch --tags --force --quiet origin

  # ^{commit} peels an annotated tag to the commit it points at. Without it, an annotated
  # tag's own object SHA never equals HEAD, so a tag already pointing at the right commit
  # reads as a conflict. This repo has annotated tags (v2, v3), so that is not theoretical.
  #
  # The assignment lives inside the `if` on purpose: an assignment takes its command
  # substitution's exit status, and `set -e` is suspended in a tested context. Hoisting it
  # out would kill the script on the normal "tag does not exist yet" path.
  if existing="$(git rev-parse -q --verify "refs/tags/${version_tag}^{commit}" 2>/dev/null)"; then
    if [ "$existing" = "$(git rev-parse HEAD)" ]; then
      echo "${version_tag} already points here."
    else
      # An immutable tag that moves is worse than no tag: anything pinned to it stops
      # being reproducible.
      echo "::error::${version_tag} already exists on ${existing}. Bump the version in ${version_tag_from} instead of moving a released tag." >&2
      exit 1
    fi
  else
    git tag "$version_tag"
    git push origin "refs/tags/${version_tag}"
    echo "Cut ${version_tag}."
  fi
fi
echo "version-tag=${version_tag}" >> "$github_output"

# -- the moving major tag -----------------------------------------------------
# Force, and ONLY for this one tag. The workflow this replaces force-pushed every tag in
# the repository as a side effect of publishing a bundle.
if [ -n "$major_tag" ]; then
  git tag -f "$major_tag"
  git push -f origin "refs/tags/${major_tag}"
  echo "Moved ${major_tag} to $(git rev-parse --short HEAD)."
fi
