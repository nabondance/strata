#!/usr/bin/env bash
# The GitHub Action's `image-branch` option, one command per step:
#
#   check    validates the setup before Strata runs, on every event
#   render   draws the image and badge from the pushed commit
#   publish  pushes them as the single commit of the branch
#   link     says in the job summary where the image is, on events that do not publish
#
# Only `publish` is given the token, but this is not isolation: Strata runs
# earlier in the same job, and a step can affect later ones. docs/pr-action.md
# says so. The branch is the only ref this script ever writes.

set -eo pipefail

fail() {
  # Workflow commands need %, CR, and LF escaped, or a value could end the message early.
  local message="${1//%/%25}"
  message="${message//$'\r'/%0D}"
  echo "::error title=Strata image::${message//$'\n'/%0A}"
  exit 1
}

check() {
  local branch="$STRATA_IMAGE_BRANCH" headers
  if ! [[ "$branch" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || ! git check-ref-format "refs/heads/$branch"; then
    fail "image-branch must be a plain branch name, such as strata-image, not '$branch'."
  fi
  if [ "$branch" = "$STRATA_DEFAULT_BRANCH" ]; then
    fail "image-branch cannot be the default branch ($branch): publishing replaces the branch's whole history. Use a dedicated branch, such as strata-image."
  fi
  # The value is a credential, so it is matched here and never printed.
  if headers="$(git -C "$GITHUB_WORKSPACE" config --get-regexp '^http\.(.*\.)?extraheader$' 2>/dev/null)" &&
    grep -qi 'authorization:' <<<"$headers"; then
    fail "With image-branch the job can write, so the checkout must not keep its credentials while Strata runs. Set persist-credentials: false on actions/checkout."
  fi
  # Without a repository this passes, and the compare step names the missing checkout.
  if [ "$(git -C "$GITHUB_WORKSPACE" rev-parse --is-shallow-repository 2>/dev/null)" = true ]; then
    fail "The image shows the whole history, but this checkout is shallow. Set fetch-depth: 0 on actions/checkout."
  fi
}

render() {
  local workspace="$GITHUB_WORKSPACE" head out pattern
  local ignore=()
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

image_url() {
  printf '%s/%s/raw/%s/strata.svg' "$GITHUB_SERVER_URL" "$GITHUB_REPOSITORY" "$STRATA_IMAGE_BRANCH"
}

# Adds the image's state to the job summary, after the delta. With `snippet`,
# also the Markdown to paste into a README.
summarize() {
  {
    printf '\n### README image\n\n%s\n' "$1"
    if [ "${2:-}" = snippet ]; then
      printf '\nTo show it in a README:\n\n```markdown\n![Agent context through time](%s)\n```\n' "$(image_url)"
    fi
  } >>"$GITHUB_STEP_SUMMARY"
}

link() {
  local branch="$STRATA_IMAGE_BRANCH" default="$STRATA_DEFAULT_BRANCH" state
  # A full checkout lists every branch, so this needs no token.
  if git -C "$GITHUB_WORKSPACE" rev-parse -q --verify "refs/remotes/origin/$branch^{commit}" >/dev/null; then
    state="Current image on \`$branch\`: [strata.svg]($(image_url)). The next push to \`$default\` updates it."
  else
    state="The next push to \`$default\` publishes the image to \`$branch\`."
  fi
  echo "$state"
  summarize "$state" snippet
}

# The commit the branch holds, or nothing when the branch does not exist.
remote_tip() {
  local lines id ref
  lines="$(git -C "$1" ls-remote --heads "$STRATA_IMAGE_REMOTE" "refs/heads/$STRATA_IMAGE_BRANCH")" || return 1
  # The pattern also matches a longer name that ends the same way, such as refs/heads/x/refs/heads/<branch>.
  while IFS=$'\t' read -r id ref; do
    if [ "$ref" = "refs/heads/$STRATA_IMAGE_BRANCH" ]; then
      printf '%s' "$id"
      return 0
    fi
  done <<<"$lines"
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
  local default="$STRATA_DEFAULT_BRANCH" source url work basic attempt current tip published now error
  source="$(git -C "$workspace" rev-parse HEAD)"
  url="$(image_url)"
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
    # The default branch as it is now decides which image is right. Without it,
    # the order of the commits is unknown, so nothing is pushed.
    git -C "$workspace" -c gc.auto=0 -c maintenance.auto=false fetch -q --no-tags --no-recurse-submodules "$remote" "refs/heads/$default" ||
      fail "Could not read the default branch ($default), so the image was not published."
    tip="$(git -C "$workspace" rev-parse FETCH_HEAD)"
    if ! git -C "$workspace" merge-base --is-ancestor "$source" "$tip"; then
      echo "::notice title=Strata image::Commit $source is no longer on $default, so its image was not published."
      summarize "Not published, because this commit is no longer on \`$default\`."
      return 0
    fi
    if [ -n "$current" ]; then
      git -C "$work" fetch -q --depth=2 --no-tags "$remote" "+refs/heads/$branch:refs/strata/published" ||
        fail "Could not fetch branch $branch from the repository."
      current="$(git -C "$work" rev-parse refs/strata/published)"
      require_image_branch "$work" "$current"
      # Runs can finish out of order: an older commit must not replace a newer
      # image. A published commit that left the default branch is not newer.
      published="$(git -C "$work" log -1 --format=%s "$current")"
      published="${published##* }"
      if [[ "$published" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] && [ "$published" != "$source" ] &&
        git -C "$workspace" cat-file -e "$published^{commit}" 2>/dev/null &&
        git -C "$workspace" merge-base --is-ancestor "$published" "$tip" &&
        git -C "$workspace" merge-base --is-ancestor "$source" "$published"; then
        echo "::notice title=Strata image::Branch $branch already shows a newer commit ($published), so it was left as it is."
        echo "image-url=$url" >>"$GITHUB_OUTPUT"
        summarize "\`$branch\` already shows a newer commit: [strata.svg]($url)." snippet
        return 0
      fi
      if [ "$(git -C "$work" rev-parse "$current^{tree}")" = "$(git -C "$work" rev-parse "HEAD^{tree}")" ]; then
        echo "The image on $branch is unchanged, so nothing was pushed."
        echo "image-url=$url" >>"$GITHUB_OUTPUT"
        summarize "Unchanged on \`$branch\`: [strata.svg]($url)." snippet
        return 0
      fi
    fi
    # The lease refuses the push if another run moved the branch since it was read.
    if error="$(git -C "$work" push -q --force-with-lease="refs/heads/$branch:$current" "$remote" "HEAD:refs/heads/$branch" 2>&1)"; then
      echo "Published the image to $branch."
      echo "image-url=$url" >>"$GITHUB_OUTPUT"
      summarize "Published to \`$branch\`: [strata.svg]($url)." snippet
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
link) link ;;
*) fail "Unknown image command: ${1:-none}." ;;
esac
