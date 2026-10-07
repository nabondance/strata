# Strata — project foundation

Captured on 2026-10-07 from the initial project discussion, before implementation.
Target repository: https://github.com/nabondance/strata

## Purpose

Make the settings and context architecture of Claude Code or any AI coding agent visible through time. Show instructions, skills, agents, rules and other configuration growing, shrinking, appearing, disappearing and being reorganized across Git history.

The user particularly liked the conceptual fit of **git-of-theseus** and measuring configuration in **tokens**. The goal is to understand how an agent's configuration evolved, rather than only animate file changes.

Suggested product description: “See how your agent context evolved.”
Suggested framing: context archaeology; an open-source observability tool for the evolution of AI coding-agent context.

## Confirmed choices and user direction

- An open-source project for historical visualization of AI-agent settings.
- Support more than Claude in the overall design.
- Token size is an especially interesting measurement.
- git-of-theseus is a strong inspiration.
- User approved the overall idea and requested discussion of the output format.
- User requested a project/repository/command name and npm availability checks.
- User created `nabondance/strata` on GitHub.
- First requested repository work: preserve the discussion and project information before implementation.

The CLI/local-web approach and roadmap below were proposed by the assistant. They are the working direction, but individual features and technical choices have not all been explicitly approved.

## User's starting questions

1. Is there an open-source project that visualizes Claude settings evolving, with skills, agents and Markdown instructions growing and shrinking over time?
2. Could generic Git evolution tools provide the historical visualization component?
3. What should the result be: a command producing an image, a local website, or something else?
4. What should the project, repository and command be named, and is the npm package available for npx?

## Proposed product form

CLI-first, with a local interactive website as the main report. Run a command in a Git repository, reconstruct configuration history, calculate measurements, and open an interactive report on localhost.

A shared timeline selects a historical revision and updates the chart, component counts, file inventory and architecture view. Users should be able to inspect the moment a large root instruction file was split into reusable skills.

Static exports remain useful for sharing. A self-contained interactive HTML report would work offline and as a CI artifact, without requiring an application server. SVG/image export and JSON output are secondary options.

Earlier illustrative commands used `agent-theseus` and then `context-strata`. These were examples, not implemented interfaces. Since the repository is now named `strata`, the actual npm package name and binary name still need a decision and direct registry verification.

## Proposed views

### Growth

Stacked token history by component: root instructions, skills, agents, rules and commands, with configuration/tool categories where meaningful. Hover or select a revision to see the total, category totals and counts.

### Architecture

Configuration structure at the selected revision. Nodes can reflect token size and change over time. Relationships such as an agent referring to a skill should only be shown when supported by configuration or content evidence; directory membership alone is not a runtime dependency.

### Survival

Theseus-inspired analysis of how much configuration from an older point remains later. Requires a defined text/line attribution method and handling of moved or copied instructions. This is deeper analysis, not just comparing total token counts.

### Changes

Revision-to-revision additions, deletions and token deltas: new skill, removed agent, root instructions shrinking, and possible reorganization. A “refactor” label should be treated as inferred unless evidence establishes it.

## Measurements discussed

- Total stored configuration tokens.
- Tokens by category and file/component.
- Number of skills, agents, rules and commands.
- Average skill size and largest context files.
- Churn by week or month; additions and removals.
- Instruction age and survival.
- Root instructions versus modular skills.
- Potentially always-loaded, conditional, agent-specific and command context.

Illustrative example: an 18k-token CLAUDE.md becomes a 6k-token root instruction file plus 12k tokens distributed across skills. These numbers, and all example totals in the discussion, were fictional demonstrations rather than repository measurements.

### Token semantics

Stored configuration size is not the same as the tokens actually loaded in a session. Different providers and models use different tokenizers. Reports must label the tokenizer or estimation method and apply a consistent method across historical comparisons.

“Always loaded,” “maximum reachable” and “typical session” were exploratory ideas. Actual loading depends on agent behavior, working directory, imports, triggers and session activity. A static Git report cannot establish a typical session cost without additional evidence. Do not present invented session estimates as measurements.

MCP and hook configuration may be structurally important without representing prompt context in the same way as Markdown instructions. Their source size should not silently be equated with runtime tool-schema tokens.

## Ecosystem coverage discussed

A generic internal model with adapters for agent conventions:

| Ecosystem | Candidate configuration inputs |
| --- | --- |
| Claude Code | CLAUDE.md, .claude/agents, .claude/skills, commands, rules, settings, hooks, MCP configuration |
| Codex | AGENTS.md, .agents/skills, other supported configuration conventions |
| Cursor | .cursor/rules and related configuration |
| GitHub Copilot | Repository instructions and scoped instruction files |
| Gemini CLI | Instruction and configuration conventions |

Candidate categories: instructions, skills, subagents, rules, commands, tools/MCP and hooks. Provider-specific recognition rules still require verification against current documentation. Track only what is present in the repository history; global user configuration and ignored/untracked files are not recoverable from Git.

## Extraction and reporting design ideas

- Reconstruct relevant files at each commit or sampled commits.
- Separate history extraction from the visualization/report model.
- Retain revision identifiers, timestamps, category measurements and component identity.
- Use caching and sampling for larger histories; document any gaps caused by shallow clones or sampling.
- Account for renames/deletions when comparing revisions.
- Keep analysis local; no telemetry or uploading of prompt content is required.
- Prefer an adapter-based core over building directly on Gource's rendering engine.

No implementation language, framework, tokenizer, graph library, cache layout, sampling policy, license or merge-history policy has been selected yet.

## Proposed progression

1. **v0:** CLI → local interactive history report, token growth/composition and revision inspection.
2. **v1:** Standalone HTML and SVG exports.
3. **v2:** GitHub Action providing pull-request configuration deltas.
4. **v3:** Historical reports, badges and optional CI thresholds.
5. **Later:** Hosted product only if there is demand.

Example future PR report: total token delta and percentage; per-category/file changes; skills added and rules removed. This is an idea, not a built integration. Token increases alone should not be treated as a quality failure.

## Research references from the conversation

These references and descriptions came from the earlier assistant's research. They have not been independently revalidated for this document, and claims about missing features are provisional.

| Project | URL | Discussed relevance |
| --- | --- | --- |
| git-of-theseus | https://github.com/erikbern/git-of-theseus | Main conceptual inspiration: repository growth, cohorts, survival and composition |
| Gource | https://github.com/acaudwell/Gource | Animated file-tree history and custom event-log separation |
| Claude Code Flow Visualizer | https://github.com/oyekamal/claude-code-flow-visualizer | Claude-aware structure/graph inspiration; described as current-state focused |
| Claude Code View | https://github.com/rajnavakoti/claude-code-view | Configuration inventory and some Git analytics |
| CodeSee | https://github.com/Kaka-cheaper/codeSee | Semantic graph ideas and agent configuration integration |
| Agent Atlas | https://github.com/Pycomet/agent-atlas | Adjacent configuration inventory and analysis; avoid confusing naming |
| Agent Chronicle | https://github.com/detasar/agent-chronicle-community | Naming collision mentioned during exploration |

Earlier research did not establish that no competing tool exists. Review references and licenses before reusing code.

## Naming history

Initial working name: Agent Theseus. The assistant later recommended avoiding Theseus because of unrelated AI projects with that name.

Strata was proposed as the metaphor for historical layers of accumulated agent context. The name also connects visually to stacked token charts and geological layers.

Shortlist:

| Product/package idea | Notes |
| --- | --- |
| Context Strata / context-strata | Assistant's preferred package/repo suggestion; Strata as short UI brand |
| Agent Strata / agent-strata | Explicit agent association |
| Prompt Strata / prompt-strata | Considered narrower than the full configuration scope |
| Agent Theseus / agent-theseus | Strong inspiration reference, crowded name |
| Context Archaeology / context-archaeology | Descriptive, long command |

Earlier search results reportedly found no npm packages for context-strata, agent-strata or prompt-strata. This was search-engine absence, **not direct npm registry verification or a reservation**. No npm package was claimed in this conversation. The user subsequently created the repository under the shorter name `strata`.

## Open decisions

- npm package and executable names; direct registry availability.
- Initial ecosystem support and configuration recognition rules.
- Tokenizer/estimation strategy and model labeling.
- Per-commit versus sampled history; first-parent versus full graph handling.
- Skill boundary: SKILL.md alone or bundled supporting resources, with separate accounting.
- Renames, copies and instruction survival attribution.
- What architecture edges can be inferred reliably.
- Whether initial output should be standalone HTML or a local server.
- Handling file content in exports, confidentiality and explicit inclusion options.
- License, implementation stack and supported Node/platform versions if using npx.
- Exact initial MVP scope and test fixtures.

## Immediate next steps

1. Commit this foundation to the existing repository, respecting any existing repository instructions and files.
2. Confirm access and inspect repository state before choosing the implementation layout.
3. Implement a narrow end-to-end slice: scan real Git history, classify initial configuration types, measure labeled token sizes, and inspect an interactive timeline.
4. Verify on a synthetic Git fixture that includes additions, growth, reductions, deletion and a rename, then on a real repository.

This document preserves the project discussion; it does not claim implementation, npm publication or validated competitor capabilities.
