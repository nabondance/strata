---
name: pr-screenshots
description: Capture before and after screenshots of a visible Strata change and post them to the pull request with gh --attach, each with a caption saying what changed. Use when a branch changes the HTML report, the SVG image, or README and brand images, or when asked to add screenshots to a pull request.
---

# Before and after screenshots on a Strata pull request

A reviewer should see what changed without checking out the branch. Show the same view twice, before (`origin/main`) and after (the branch), and say under each image what changed and where to look.

## 1. Build both versions

Work from the branch's worktree. Build the "before" version in a separate, detached worktree so the branch is not touched:

```sh
git fetch origin
git worktree add --detach .claude/worktrees/before-shots origin/main
(cd .claude/worktrees/before-shots && pnpm install && pnpm build)
pnpm build
```

## 2. Render the same input with each

Run both builds against the same repository with the same options, so only the code differs. Strata's own repository is the default target. Do not screenshot another private repository unless the user agrees; `--shareable` replaces repository names, paths, and commit IDs with aliases. Never modify the target repository.

```sh
mkdir -p /tmp/strata-shots
node .claude/worktrees/before-shots/dist/cli.js analyze . --output /tmp/strata-shots/before.html
node dist/cli.js analyze . --output /tmp/strata-shots/after.html
```

For the SVG image, use `--format svg` and `.svg` output names instead.

## 3. Capture at the same size and state

For a view that shows on load, use headless Chrome with the same window size for both:

```sh
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for v in before after; do
  "$CHROME" --headless=new --hide-scrollbars --window-size=1440,1000 \
    --screenshot=/tmp/strata-shots/$v.png file:///tmp/strata-shots/$v.html
done
```

On macOS, Chrome prints `task_policy_set` errors here; they are harmless.

For a state that needs interaction (a selected revision, an open panel, a hover), use browser automation, which `AGENTS.md` allows for visual checks. Reach the same state in both reports and use the same window size.

Crop to the changed area when the full page buries it (`sips --cropToHeightWidth <h> <w>` on macOS, applied identically to both). Open each image and check it shows the change before posting.

If the view is new and has no "before", post only the "after" image and say there was nothing to compare.

## 4. Write the captions

Each image gets a caption line above it and alt text. The caption names what changed and where in the image to look; the alt text summarizes it. With several changes, use one pair per change, or list them in the caption.

```markdown
## Screenshots

**Before.** The timeline legend (top right) lists every file; categories have no names.

![Before: the legend lists every file](./before.png)

**After.** The legend groups files by category, and the selected revision is outlined in the timeline.

![After: the legend groups files by category](./after.png)
```

## 5. Upload with gh --attach

Run `gh` from the directory holding the images, so the `./before.png` references in the body match the attached paths; `gh` uploads each file and rewrites the reference to the uploaded URL.

```sh
cd /tmp/strata-shots
gh pr create --body-file body.md --attach ./before.png --attach ./after.png   # new pull request
gh pr edit <number> --body-file body.md --attach ./before.png --attach ./after.png   # existing description
gh pr comment <number> --body-file body.md --attach ./before.png --attach ./after.png   # later round of changes
```

For `gh pr edit`, `body.md` must hold the whole description, not only the screenshots section. Afterwards, check with `gh pr view <number> --json body` that every image points at `https://github.com/user-attachments/...` and no `./` path is left.

Do not commit the images or link to a branch file to display them.

## 6. Clean up

```sh
git worktree remove .claude/worktrees/before-shots
rm -rf /tmp/strata-shots
```
