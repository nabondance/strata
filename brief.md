# Strata — project foundation

Captured on 2026-10-07 from the initial project discussion, before implementation.
Target repository: https://github.com/nabondance/strata

## Purpose

Make the settings and context of Claude Code, or any AI coding agent, visible through time, along with how they are structured. Strata should show instructions, skills, agents, rules, and other configuration growing, shrinking, appearing, disappearing, and being reorganized across Git history.

The user especially liked two ideas:

- The conceptual fit of **git-of-theseus**, a tool that charts how much of a codebase's code survives over time.
- Measuring configuration in **tokens**, the text units language models read and count.

The goal is to understand how an agent's configuration evolved, not only to animate file changes.

Suggested product description: “See how your agent context evolved.”
Suggested framing: context archaeology; an open-source observability tool for the evolution of AI coding-agent context. (Observability: tools that let you see and measure what a system is doing.)

## Confirmed choices and user direction

- An open-source project for historical visualization of AI-agent settings.
- Support more than Claude in the overall design.
- Token size is an especially interesting measurement.
- git-of-theseus is a strong inspiration.
- User approved the overall idea and requested discussion of the output format.
- User requested a project/repository/command name and npm availability checks.
- User created `nabondance/strata` on GitHub.
- First requested repository work: preserve the discussion and project information before implementation.

The assistant proposed the CLI and local web approach and the roadmap below. They are the working direction, but the user has not explicitly approved every feature and technical choice.

## User's starting questions

1. Is there an open-source project that visualizes Claude settings evolving, with skills, agents and Markdown instructions growing and shrinking over time?
2. Could generic Git evolution tools provide the historical visualization component?
3. What should the result be: a command producing an image, a local website, or something else?
4. What should the project, repository and command be named, and is the npm package available for npx?

## Proposed product form

A command-line tool first, with a local interactive website as the main report. The user runs a command in a Git repository. The tool rebuilds the configuration's history, calculates measurements, and opens an interactive report on localhost.

A shared timeline selects one historical revision (a commit). Selecting it updates the chart, the component counts, the file inventory, and the architecture view. For example, a user should be able to find the moment a large root instruction file was split into reusable skills.

Static exports remain useful for sharing:

- A self-contained interactive HTML report would work offline and as a CI artifact, without an application server.
- SVG/image export and JSON output are secondary options.

Earlier example commands used `agent-theseus` and then `context-strata`. These were examples, not implemented interfaces. The repository is now named `strata`, but the npm package name and command name still need a decision and a direct check against the npm registry.

## Proposed views

### Growth

A stacked chart of token history by component: root instructions, skills, agents, rules, and commands, plus configuration and tool categories where they mean something. Hovering over or selecting a revision shows the total, the total per category, and the counts.

### Architecture

The structure of the configuration at the selected revision. Nodes can reflect token size and change over time.

Show a relationship, such as an agent referring to a skill, only when the configuration or its content gives evidence for it. A file's place in a directory alone does not mean an agent uses it at runtime.

### Survival

An analysis, inspired by git-of-theseus, of how much configuration from an older point in history still remains later. This is deeper than comparing total token counts. It needs:

- A defined method for attributing text or lines to the point in history they came from.
- A way to handle instructions that were moved or copied.

### Changes

Additions, deletions, and token changes from one revision to the next: a new skill, a removed agent, root instructions shrinking, a possible reorganization. Treat a “refactor” label as inferred unless evidence establishes it.

## Measurements discussed

- Total stored configuration tokens.
- Tokens by category and file/component.
- Number of skills, agents, rules and commands.
- Average skill size and largest context files.
- Churn (how much text is added and removed) by week or month; additions and removals.
- Instruction age and survival.
- Root instructions versus modular skills.
- Potentially always-loaded, conditional, agent-specific and command context.

Example used in the discussion: an 18k-token CLAUDE.md becomes a 6k-token root instruction file plus 12k tokens spread across skills. These numbers, and all example totals in the discussion, were made up to illustrate the idea. They are not measurements of any repository.

### Token semantics

The size of the stored configuration is not the same as the tokens actually loaded in a session. Different providers and models also use different tokenizers (the rules that split text into tokens). Reports must therefore:

- Name the tokenizer or estimation method used.
- Use the same method across all historical comparisons.

“Always loaded,” “maximum reachable,” and “typical session” were ideas under exploration. What an agent actually loads depends on its behavior, the working directory, imports, triggers, and what happens in the session. A static Git report cannot establish what a typical session costs without more evidence. Do not present invented session estimates as measurements.

MCP and hook configuration can matter to the structure without being prompt context in the way Markdown instructions are. (MCP, the Model Context Protocol, connects an agent to outside tools; hooks run commands at set points in a session.) Do not silently treat their source size as equal to the tokens their tool definitions use at runtime.

## Ecosystem coverage discussed

One idea discussed: a generic internal model, with one adapter per agent's conventions. An adapter is the part that knows which files a given tool uses.

| Ecosystem | Candidate configuration inputs |
| --- | --- |
| Claude Code | CLAUDE.md, .claude/agents, .claude/skills, commands, rules, settings, hooks, MCP configuration |
| Codex | AGENTS.md, .agents/skills, other supported configuration conventions |
| Cursor | .cursor/rules and related configuration |
| GitHub Copilot | Repository instructions and scoped instruction files |
| Gemini CLI | Instruction and configuration conventions |

Candidate categories: instructions, skills, subagents, rules, commands, tools/MCP, and hooks.

The rules for recognizing each provider's files still need checking against current documentation. Track only what is present in the repository's history. Git cannot recover a user's global configuration or files that were ignored or never committed.

## Extraction and reporting design ideas

- Rebuild the relevant files at each commit, or at a sample of commits.
- Keep reading history separate from the model the report is drawn from.
- Keep revision identifiers, timestamps, measurements per category, and the identity of each component.
- Use caching and sampling for larger histories. Document any gaps caused by shallow clones (copies with only recent history) or by sampling.
- Account for renames and deletions when comparing revisions.
- Keep analysis local. No telemetry or uploading of prompt content is required.
- Prefer a core built around adapters over building directly on Gource's rendering engine.

No implementation language, framework, tokenizer, graph library, cache layout, sampling policy, license or merge-history policy has been selected yet.

## Proposed progression

1. **v0:** CLI → local interactive history report, token growth/composition and revision inspection.
2. **v1:** Standalone HTML and SVG exports.
3. **v2:** GitHub Action providing pull-request configuration deltas.
4. **v3:** Historical reports, badges and optional CI thresholds.
5. **Later:** Hosted product only if there is demand.

A possible future pull-request report could show:

- The total token change, as a number and a percentage.
- Changes per category and per file.
- Skills added and rules removed.

This is an idea, not a built integration. A token increase on its own should not be treated as a quality failure.

## Research references from the conversation

These references and descriptions came from the earlier assistant's research. They have not been checked again independently for this document, and claims that a tool lacks a feature are provisional.

| Project | URL | Discussed relevance |
| --- | --- | --- |
| git-of-theseus | https://github.com/erikbern/git-of-theseus | Main conceptual inspiration: repository growth, cohorts, survival and composition |
| Gource | https://github.com/acaudwell/Gource | Animated file-tree history and custom event-log separation |
| Claude Code Flow Visualizer | https://github.com/oyekamal/claude-code-flow-visualizer | Claude-aware structure/graph inspiration; described as current-state focused |
| Claude Code View | https://github.com/rajnavakoti/claude-code-view | Configuration inventory and some Git analytics |
| CodeSee | https://github.com/Kaka-cheaper/codeSee | Semantic graph ideas and agent configuration integration |
| Agent Atlas | https://github.com/Pycomet/agent-atlas | Adjacent configuration inventory and analysis; avoid confusing naming |
| Agent Chronicle | https://github.com/detasar/agent-chronicle-community | Naming collision mentioned during exploration |

The earlier research did not establish that no competing tool exists. Review references and licenses before reusing code.

## Naming history

Initial working name: Agent Theseus. The assistant later recommended avoiding Theseus because unrelated AI projects already use that name.

Strata was proposed as a metaphor for the historical layers of agent context that build up over time. The name also matches stacked token charts and geological layers visually.

Shortlist:

| Product/package idea | Notes |
| --- | --- |
| Context Strata / context-strata | Assistant's preferred package/repo suggestion; Strata as short UI brand |
| Agent Strata / agent-strata | Explicit agent association |
| Prompt Strata / prompt-strata | Considered narrower than the full configuration scope |
| Agent Theseus / agent-theseus | Strong inspiration reference, crowded name |
| Context Archaeology / context-archaeology | Descriptive, long command |

Earlier search results reportedly found no npm packages named context-strata, agent-strata, or prompt-strata. That only means a search engine found none. It is **not a direct check of the npm registry, and not a reservation**. No npm package was claimed in this conversation. The user then created the repository under the shorter name `strata`.

## Open decisions

- npm package and command names; checking availability directly in the registry.
- Which ecosystems to support first, and the rules for recognizing their configuration.
- Tokenizer or estimation strategy, and how to label the model it matches.
- Every commit or a sample of commits; following only the first-parent line of history or the full merge graph.
- Skill boundary: count SKILL.md alone, or also the supporting files bundled with it, counted separately.
- Renames, copies, and tracing surviving instructions back to their origin.
- Which architecture relationships can be inferred reliably.
- Whether the first output should be a standalone HTML file or a local server.
- How exports handle file content and confidentiality, and options to include content explicitly.
- License, implementation stack, and supported Node and platform versions if using npx.
- Exact scope of the first minimum viable product (MVP), and its test fixtures.

## Immediate next steps

1. Commit this foundation to the existing repository, respecting any existing repository instructions and files.
2. Confirm access and inspect the repository's state before choosing the implementation layout.
3. Build a narrow end-to-end slice: scan real Git history, classify the first configuration types, measure labeled token sizes, and inspect them on an interactive timeline.
4. Verify it on a synthetic Git history built for testing, with additions, growth, reductions, a deletion, and a rename. Then verify it on a real repository.

This document preserves the project discussion. It does not claim implementation, npm publication, or validated competitor capabilities.
