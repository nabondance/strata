# Changelog

## [0.5.0](https://github.com/nabondance/strata/compare/v0.4.1...v0.5.0) (2026-10-24)


### Features

* accept analyse as an alias for the analyze command ([#40](https://github.com/nabondance/strata/issues/40)) ([c81eebf](https://github.com/nabondance/strata/commit/c81eebfb1c3e6cdd5107bc31ad125cace6b2565d))
* draw a configuration map of paths and Claude imports ([#45](https://github.com/nabondance/strata/issues/45)) ([951a459](https://github.com/nabondance/strata/commit/951a4596787548f0dfa16d25d22f023a58c4144e))
* list the MCP servers tracked files define ([#42](https://github.com/nabondance/strata/issues/42)) ([0f4cb52](https://github.com/nabondance/strata/commit/0f4cb52b16538739d8fdb2b66d3a12b5058041a6))
* report instruction age and survival ([#44](https://github.com/nabondance/strata/issues/44)) ([46ea5e1](https://github.com/nabondance/strata/commit/46ea5e1333fdfcb19539d211b1cdc8cdfef66af4))


### Bug Fixes

* bring the bundled interpretation skill up to date with the report ([#49](https://github.com/nabondance/strata/issues/49)) ([15fe0dc](https://github.com/nabondance/strata/commit/15fe0dc45cbbca3d5263bb5dc9f97ca878d717b0))
* make muted report text easier to read in dark mode ([#46](https://github.com/nabondance/strata/issues/46)) ([5629399](https://github.com/nabondance/strata/commit/5629399ef483b432f8b4b184daa920eef3226d03))
* say when an import past the depth limit points outside the repository ([#50](https://github.com/nabondance/strata/issues/50)) ([b9e007e](https://github.com/nabondance/strata/commit/b9e007e14d1493c289c7d18e465ab3a186f110d6))
* stop shipping README images and keep version pins current on release ([#43](https://github.com/nabondance/strata/issues/43)) ([3c5d6fa](https://github.com/nabondance/strata/commit/3c5d6fa4475c1faba3e17660476508694c3fa01a))

## [0.4.1](https://github.com/nabondance/strata/compare/v0.4.0...v0.4.1) (2026-10-18)


### Bug Fixes

* clean up timeline selection, add arrow-key navigation, and fix the edited legend mark ([#38](https://github.com/nabondance/strata/issues/38)) ([4b6fdae](https://github.com/nabondance/strata/commit/4b6fdaeb75950ed0b86e5765a332af759d8aee69))

## [0.4.0](https://github.com/nabondance/strata/compare/v0.3.0...v0.4.0) (2026-10-18)


### Features

* add a Cursor configuration adapter ([#30](https://github.com/nabondance/strata/issues/30)) ([0a82ab5](https://github.com/nabondance/strata/commit/0a82ab5c95b8ffaa2a5a2d48086537993adab027))
* add a GitHub Copilot configuration adapter ([#32](https://github.com/nabondance/strata/issues/32)) ([38bedfa](https://github.com/nabondance/strata/commit/38bedfa3f481f261f01266633b7699155ce394c5))
* draw the treemap as named category layers that move between revisions ([#33](https://github.com/nabondance/strata/issues/33)) ([42e5438](https://github.com/nabondance/strata/commit/42e5438fe8ec66b95c9420ea31ccf3bd1314ea47))
* measure the skill name and description agents list before use ([#26](https://github.com/nabondance/strata/issues/26)) ([93f48ca](https://github.com/nabondance/strata/commit/93f48ca985b193918592579edb63e97b89f35bc3))
* name submodules that hold agent configuration Strata did not analyze ([#27](https://github.com/nabondance/strata/issues/27)) ([049f47c](https://github.com/nabondance/strata/commit/049f47c086121282c65563d1de60af357bc4e563))
* resolve Claude [@path](https://github.com/path) imports against the Git tree ([#31](https://github.com/nabondance/strata/issues/31)) ([75084d4](https://github.com/nabondance/strata/commit/75084d40d0e1b69403dec48ffac0bd51c4c84d60))
* separate what each agent reads at session start from on-demand context ([#35](https://github.com/nabondance/strata/issues/35)) ([6f97670](https://github.com/nabondance/strata/commit/6f97670a6af44999b1c438c519611523799ca3eb))

## [0.3.0](https://github.com/nabondance/strata/compare/v0.2.2...v0.3.0) (2026-10-16)


### Features

* count tokens precisely with one `--precise` flag and no API key: a signed-in `ant` or `gcloud` account, then an API key, then a local tokenizer, then the estimate, saying what was sent where ([#25](https://github.com/nabondance/strata/issues/25)) ([b11dbcc](https://github.com/nabondance/strata/commit/b11dbcce9e785db47d40c299645a741ca7f094f8))
* follow what Gemini CLI reads for AGENTS.md and .agents/skills ([#23](https://github.com/nabondance/strata/issues/23)) ([0a2b528](https://github.com/nabondance/strata/commit/0a2b528b34298713f4b7c6861c4715ba72cb0902))
* add a shields.io badge output with the latest token total ([#20](https://github.com/nabondance/strata/issues/20)) ([b324bdd](https://github.com/nabondance/strata/commit/b324bdd208284988108924a09ed91f02dcc3e0e4))
* add the Fault line brand, a repository-first report masthead, and dark mode, and trim the report to its core panels ([#18](https://github.com/nabondance/strata/issues/18)) ([0fbac81](https://github.com/nabondance/strata/commit/0fbac81ee002a254e4d6785578842410fedfe107))
* add a minimal SVG image with only the layers, and drop the total outline from the full image ([#16](https://github.com/nabondance/strata/issues/16)) ([357e56e](https://github.com/nabondance/strata/commit/357e56e02b73d7e592873397885001f5df0ada8e))


### Bug Fixes

* open the file table when provider counts are present ([#18](https://github.com/nabondance/strata/issues/18)) ([47d2b7f](https://github.com/nabondance/strata/commit/47d2b7fa7be9fc17f821e68faa722eef87d6855d))
* install pnpm with npm in the composite Action ([#19](https://github.com/nabondance/strata/issues/19)) ([ed0f0fa](https://github.com/nabondance/strata/commit/ed0f0fa7d93973edbf70453c1f42fff0f212bd1f))

## [0.2.2](https://github.com/nabondance/strata/compare/v0.2.1...v0.2.2) (2026-10-12)


### Bug Fixes

* serve README screenshots from the published package ([34cd1d5](https://github.com/nabondance/strata/commit/34cd1d56f80489235ee47e246974a1e88f61ec8d))
* serve README screenshots from the published package ([1c74dd7](https://github.com/nabondance/strata/commit/1c74dd75ba76326baedb7f956a1efd6b69888dcd))

## [0.2.1](https://github.com/nabondance/strata/compare/v0.1.0...v0.2.1) (2026-10-11)

First release published by GitHub Actions. Version 0.2.0 was never published to npm: its publish job failed, so its changes ship here.


### Features

* add SVG image export for READMEs ([268cf7c](https://github.com/nabondance/strata/commit/268cf7c4f7b52ae08c53ec247467a1e2d53ed6ef))


### Bug Fixes

* address review findings on the SVG image and CI guide ([1586237](https://github.com/nabondance/strata/commit/1586237f2f64e68c1dc698a2b30aca8db619a760))
* run release-please from the CLI under the Actions allowlist ([e3a0d6a](https://github.com/nabondance/strata/commit/e3a0d6ac3ed28f54dbfeafc8f5ecb59ab862f9f2))
* publish the release tarball by explicit path ([de3fd09](https://github.com/nabondance/strata/commit/de3fd09079e8dfeb60f5dd7c1ed8786312bff145))
