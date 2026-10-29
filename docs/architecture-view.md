# Evidence for an architecture view

Evaluated 2026-10-08. This page asks which relationships between configuration files a report can draw from Git history alone, without claiming more than the history shows.

**Outcome.** The report now draws the configuration map this evaluation proposed. It shows only two kinds of relationship: which folder holds which file, and resolved Claude imports. See [Configuration map](decisions.md#configuration-map).

**Starting point.** The report has a treemap: a chart of nested rectangles that shows the report's composition, grouped by category. A treemap shows composition, not dependencies.

**What is safe to show.** A **file/directory hierarchy at a selected revision** needs only tracked paths and their measured sizes. A line from a file to the directory that holds it means containment. It does not mean that the agent loads or calls the file.

An *edge* is a line between two files in a graph. A *component* is one tracked file in the report.

| Candidate relationship | Evidence available from Git | Safe label | Current decision |
| --- | --- | --- | --- |
| Directory contains a file | Exact tracked path at the selected revision | `contains` | Drawn as the configuration map's folder tree. |
| Markdown links to another tracked file | Link text plus a resolved path at the same revision | `links to` | Claude `@path` imports are resolved per revision (schema version 16; see [Claude imports](decisions.md#claude-imports)). `importLinks` derives each edge with its source, target, line, hop count, status, and whether it points outside the repository, and lists unresolved imports separately. The configuration map draws resolved imports as lines. Ordinary Markdown links are not resolved. Not a runtime edge. |
| A rule mentions a skill or agent by name | Free-form prose, possibly ambiguous | `mentions` | Do not turn into a dependency. If explored, keep the quoted evidence, stored locally, and report uncertainty. |
| A skill resource sits beside `SKILL.md` | Shared skill directory | `bundled with` | Already represented by each component's `skill.root`; not proof that the resource was read. |
| Rule frontmatter or glob targets files | Conditional configuration plus path patterns | `configured for` | Needs provider-specific parsing and evidence about the referenced files. Not equivalent to session loading. |
| Agent invokes skill, command, MCP tool, or another agent | No invocation trace in Git history | none | Cannot be established from a static report. |

## Proposed first view

The first useful view should be a **configuration map** the reader can move between revisions. It would show:

- grouping by provider and category;
- the path hierarchy;
- node area based on the report's labeled stored-text measure;
- a distinct marker for source-only files, which have a size but no token count.

It can reuse the inventory rebuilt from `components` and `changes`, with its skill grouping. That needs no re-reading of source and no change to the JSON schema.

Design notes:

- Use the same revision selection as the timeline.
- Keep a text inventory as an alternative.
- Show a clear legend for size and containment.

The treemap remains the compact composition view. The hierarchy would help locate where configuration moved between directories.

## Before drawing links from file content

- Define a versioned edge model containing `kind`, source and target paths, the revision, and the evidence type.
- Resolve references against Git trees.
- Test ambiguous names, relative paths, deletions, and renames in a synthetic fixture.
- Keep source excerpts out of default exports.
- Report unresolved references separately rather than drawing guessed edges.

A graph with only directory containment should be called a configuration map, not an agent execution architecture.
