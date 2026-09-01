#!/usr/bin/env bash
# The single drift decision, shared by `verify` and `push` so the two modes cannot
# disagree about whether the committed bundle is current.
#
# Fails CLOSED, deliberately. `git status --porcelain` exits 0 with EMPTY output for a
# pathspec that matches nothing, so the obvious one-liner
#
#     [ -n "$(git status --porcelain -- "$target")" ] && changed=true
#
# quietly reports "no drift" when there is no checkout, when output-dir is typo'd, when
# the build wrote somewhere else, or when the bundle is gitignored -- a verify job that
# passes while checking nothing. Each of those is an error here instead.

# Echoes `true` or `false` for the bundle at $1; returns non-zero if the question
# cannot be answered honestly.
detect_drift() {
  local target="$1"

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "::error::${PWD} is not a git work tree, so there is nothing to compare ${target} against. Is actions/checkout missing?" >&2
    return 1
  fi

  if [ ! -d "$target" ]; then
    echo "::error::${target} does not exist. The build command must write the bundle there -- check output-dir and working-directory." >&2
    return 1
  fi

  # A gitignored bundle can never be committed, so treating it as "unchanged" would
  # make verify green forever and push fail hard. Same repo, opposite answers.
  local ignored
  ignored="$(git ls-files --others --ignored --exclude-standard -- "$target")"
  if [ -n "$ignored" ]; then
    echo "::error::${target} is gitignored, so its bundle can never be committed. Un-ignore it or point output-dir elsewhere." >&2
    return 1
  fi

  # --porcelain covers untracked files too. `git diff` does not, which is why a
  # first-ever build of a new action folder used to commit nothing at all.
  local status
  status="$(git status --porcelain -- "$target")" || return 1

  if [ -n "$status" ]; then
    echo true
  else
    echo false
  fi
}
