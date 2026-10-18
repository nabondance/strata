---
name: pr-screenshots
description: Capture before and after screenshots of a visible Strata change and post them to the pull request with gh --attach, each with a caption saying what changed. Use when a branch changes the HTML report, the SVG image, or README and brand images, or when asked to add screenshots to a pull request.
---

# Before and after screenshots on a Strata pull request

A reviewer should see what changed without checking out the branch. Show the same view twice, before (`origin/main`) and after (the branch), and say under each image what changed and where to look.

Keep everything under `.strata-output/` in the branch's worktree. Git ignores it, each worktree has its own, and `gh` can be run from there, so no step leaves the worktree and parallel sessions do not overwrite each other's images.

## 1. Build both versions

From the branch's worktree, build the "before" version in a detached worktree of `origin/main` so the branch is not touched. The first line clears what an interrupted earlier run left behind.

```sh
git worktree remove --force .strata-output/before 2>/dev/null; rm -rf .strata-output/shots
git fetch origin
git worktree add --detach .strata-output/before origin/main
(cd .strata-output/before && pnpm install --frozen-lockfile && pnpm build)
pnpm build
mkdir -p .strata-output/shots
```

## 2. Render the same input with each

Run both builds against the same repository with the same options, so only the code differs. Strata's own repository is the default target. Do not screenshot another private repository unless the user agrees; `--shareable` replaces repository names, paths, and commit IDs with aliases. Never modify the target repository.

```sh
node .strata-output/before/dist/cli.js analyze . --output .strata-output/shots/before.html
node dist/cli.js analyze . --output .strata-output/shots/after.html
```

For the SVG image, use `--format svg` and `.svg` output names instead.

## 3. Capture at the same size and state

For a view that shows on load, use headless Chrome or Chromium with the same window size for both. If it is not found on `PATH`, set `CHROME` to the binary; on macOS it is inside the app bundle, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

```sh
CHROME="${CHROME:-$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser)}"
if [ -z "$CHROME" ]; then echo "Set CHROME to a Chrome or Chromium binary"; else
  for v in before after; do
    "$CHROME" --headless=new --hide-scrollbars --window-size=1440,1000 --virtual-time-budget=5000 \
      --screenshot="$PWD/.strata-output/shots/$v.png" "file://$PWD/.strata-output/shots/$v.html"
  done
fi
```

Chrome may print `task_policy_set` or GPU errors here; they are harmless if the PNG is written.

For a state that needs interaction (a selected revision, an open panel, a hover), use browser automation, which `AGENTS.md` allows for visual checks. Reach the same state in both reports and use the same window size.

Crop to the changed area when the full page buries it (with any image tool, such as ImageMagick's `magick in.png -crop <w>x<h>+<x>+<y> out.png`, applied identically to both). Open each image and check it shows the change before posting.

If the view is new and has no "before", post only the "after" image and say there was nothing to compare.

## 4. Write the captions

Write the description, or the comment, to `.strata-output/shots/body.md`. Each image gets a caption line above it and alt text. The caption names what changed and where in the image to look; the alt text summarizes it. With several changes, use one pair per change, or list them in the caption. Reference each image by the same path you will pass to `--attach`:

```markdown
## Screenshots

**Before.** The timeline legend (top right) lists every file; categories have no names.

![Before: the legend lists every file](./.strata-output/shots/before.png)

**After.** The legend groups files by category, and the selected revision is outlined in the timeline.

![After: the legend groups files by category](./.strata-output/shots/after.png)
```

## 5. Upload with gh --attach

Run `gh` from the branch's worktree, so it knows the repository and branch. It uploads each attached file and rewrites the matching reference in the body to the uploaded URL.

```sh
B=.strata-output/shots
gh pr create --body-file $B/body.md --attach ./$B/before.png --attach ./$B/after.png   # new pull request
gh pr edit <number> --body-file $B/body.md --attach ./$B/before.png --attach ./$B/after.png   # existing description
gh pr comment <number> --body-file $B/body.md --attach ./$B/before.png --attach ./$B/after.png   # later round of changes
```

For `gh pr edit`, `body.md` must hold the whole description, not only the screenshots section. Afterwards, check with `gh pr view <number> --json body` that every image points at `https://github.com/user-attachments/...` and no `./` path is left.

Do not commit the images or link to a branch file to display them.

## 6. Clean up

```sh
git worktree remove --force .strata-output/before
rm -rf .strata-output/shots
```
