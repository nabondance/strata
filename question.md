# Decisions needed for remaining GitHub setup tasks

## Repository visibility and private vulnerability reporting

The `nabondance/strata` repository is private. GitHub does not offer its private vulnerability reporting setting for this repository, and the API returned 404 when checked. Making the repository public would expose its source, issues, and commit history. `SECURITY.md` already documents a safe fallback path.

Should the repository stay private with that fallback, or do you want to make it public to use GitHub's private vulnerability reporting feature? I have not changed visibility.

## Branch protection

GitHub's branch protection and ruleset APIs returned HTTP 403: this private repository needs GitHub Pro or public visibility for those controls. Should it stay private without branch protection, or should you upgrade the plan so I can enable protection for `main`? I have not changed plan or visibility.

## First npm release

The release tarball passed local checks, but `npm whoami` reports this environment is not authenticated. After you choose to proceed with the public `context-strata@0.1.0` release, I can start npm's browser login flow. Do not paste or record an npm token here.
