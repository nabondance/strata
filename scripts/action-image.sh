#!/usr/bin/env bash
# The GitHub Action's `image-branch` option, one command per step:
#
#   check    validates the branch name, on every event
#   render   draws the image and badge from the pushed commit; it has no token
#   publish  pushes them as the single commit of the branch; it runs only Git
#
# The token reaches `publish` alone, so no Strata or dependency code runs in a
# process that holds it. The branch is the only ref this script ever writes.

set -eo pipefail

fail() {
  # Workflow commands need %, CR, and LF escaped, or a value could end the message early.
  local message="${1//%/%25}"
  message="${message//$'\r'/%0D}"
  echo "::error title=Strata image::${message//$'\n'/%0A}"
  exit 1
}

check() {
  local branch="$STRATA_IMAGE_BRANCH"
  if ! [[ "$branch" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || ! git check-ref-format "refs/heads/$branch"; then
    fail "image-branch must be a plain branch name, such as strata-image, not '$branch'."
  fi
  if [ "$branch" = "$STRATA_DEFAULT_BRANCH" ]; then
    fail "image-branch cannot be the default branch ($branch): publishing replaces the branch's whole history. Use a dedicated branch, such as strata-image."
  fi
}

render() {
  local workspace="$GITHUB_WORKSPACE" head out pattern
  local ignore=()
  if [ "$(git -C "$workspace" rev-parse --is-shallow-repository)" = true ]; then
    fail "The image shows the whole history, but this checkout is shallow. Set fetch-depth: 0 on actions/checkout."
  fi
  head="$(git -C "$workspace" rev-parse HEAD)"
  if [ "$head" != "$GITHUB_SHA" ]; then
    fail "The image must show the pushed commit ($GITHUB_SHA), but the checkout is at $head."
  fi
  while IFS= read -r pattern; do
    pattern="${pattern#"${pattern%%[![:space:]]*}"}"
    pattern="${pattern%"${pattern##*[![:space:]]}"}"
    if [ -n "$pattern" ]; then ignore+=("--ignore=$pattern"); fi
  done < <(printf '%s\n' "$STRATA_IGNORE" | tr ',' '\n')
  out="$(mktemp -d "$RUNNER_TEMP/strata-image-XXXXXX")"
  node "$STRATA_DIST/cli.js" analyze "$workspace" --format svg --output "$out/strata.svg" --quiet "${ignore[@]}"
  node "$STRATA_DIST/cli.js" analyze "$workspace" --format badge --output "$out/strata-badge.json" --quiet "${ignore[@]}"
  {
    echo "image-file=$out/strata.svg"
    echo "image-dir=$out"
  } >>"$GITHUB_OUTPUT"
}

# The commit the branch holds, or nothing when the branch does not exist.
remote_tip() {
  local line
  line="$(git -C "$1" ls-remote --heads "$STRATA_IMAGE_REMOTE" "refs/heads/$STRATA_IMAGE_BRANCH")" || return 1
  printf '%s' "${line%%$'\t'*}"
}

# Strata's branch is one commit holding only the files it publishes. Anything
# else is someone's work, which a force push would destroy.
require_image_branch() {
  local work="$1" commit="$2" file ids=()
  read -r -a ids <<<"$(git -C "$work" rev-list --parents -n 1 "$commit")"
  if [ "${#ids[@]}" -ne 1 ]; then
    fail "Branch $STRATA_IMAGE_BRANCH has more than one commit, so it does not look like Strata's image branch and was left alone. Choose another image-branch."
  fi
  while IFS= read -r file; do
    case "$file" in
    strata.svg | strata-badge.json) ;;
    *) fail "Branch $STRATA_IMAGE_BRANCH holds other files, such as $file, so it was left alone. Choose another image-branch." ;;
    esac
  done < <(git -C "$work" ls-tree -r --name-only "$commit")
}

publish() {
  local branch="$STRATA_IMAGE_BRANCH" remote="$STRATA_IMAGE_REMOTE" workspace="$GITHUB_WORKSPACE"
  local source url work basic attempt current published now error
  source="$(git -C "$workspace" rev-parse HEAD)"
  url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/raw/$branch/strata.svg"
  # The token travels in the environment, not in a URL or on a command line.
  if [ -n "$STRATA_TOKEN" ]; then
    basic="$(printf 'x-access-token:%s' "$STRATA_TOKEN" | base64 | tr -d '\n')"
    echo "::add-mask::$basic"
    export GIT_CONFIG_COUNT=1
    export GIT_CONFIG_KEY_0="http.$GITHUB_SERVER_URL/.extraheader"
    export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $basic"
  fi
  work="$(mktemp -d "$RUNNER_TEMP/strata-publish-XXXXXX")"
  git -C "$work" init -q -b "$branch"
  cp "$STRATA_IMAGE_DIR/strata.svg" "$STRATA_IMAGE_DIR/strata-badge.json" "$work/"
  git -C "$work" add strata.svg strata-badge.json
  git -C "$work" -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    -c commit.gpgsign=false commit -q -m "Update Strata image for $source"

  for attempt in 1 2 3; do
    current="$(remote_tip "$work")" ||
      fail "Could not read branch $branch from the repository. Check the job's contents permission."
    if [ -n "$current" ]; then
      git -C "$work" fetch -q --depth=2 --no-tags "$remote" "+refs/heads/$branch:refs/strata/published" ||
        fail "Could not fetch branch $branch from the repository."
      current="$(git -C "$work" rev-parse refs/strata/published)"
      require_image_branch "$work" "$current"
      # Runs can finish out of order: an older commit must not replace a newer image.
      published="$(git -C "$work" log -1 --format=%s "$current")"
      published="${published##* }"
      if [[ "$published" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] && [ "$published" != "$source" ] &&
        git -C "$workspace" cat-file -e "$published^{commit}" 2>/dev/null &&
        git -C "$workspace" merge-base --is-ancestor "$source" "$published"; then
        echo "::notice title=Strata image::Branch $branch already shows a newer commit ($published), so it was left as it is."
        echo "image-url=$url" >>"$GITHUB_OUTPUT"
        return 0
      fi
      if [ "$(git -C "$work" rev-parse "$current^{tree}")" = "$(git -C "$work" rev-parse "HEAD^{tree}")" ]; then
        echo "The image on $branch is unchanged, so nothing was pushed."
        echo "image-url=$url" >>"$GITHUB_OUTPUT"
        return 0
      fi
    fi
    # The lease refuses the push if another run moved the branch since it was read.
    if error="$(git -C "$work" push -q --force-with-lease="refs/heads/$branch:$current" "$remote" "HEAD:refs/heads/$branch" 2>&1)"; then
      echo "Published the image to $branch."
      echo "image-url=$url" >>"$GITHUB_OUTPUT"
      return 0
    fi
    now="$(remote_tip "$work")" || now="$current"
    if [ "$now" = "$current" ]; then
      fail "Could not push to branch $branch. Give the job permissions: contents: write, and check that no rule protects the branch. Git said: $error"
    fi
  done
  fail "Branch $branch kept changing during the push, so the image was not published."
}

case "${1:-}" in
check) check ;;
render) render ;;
publish) publish ;;
*) fail "Unknown image command: ${1:-none}." ;;
esac
