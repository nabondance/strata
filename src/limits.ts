import { signed } from "./format.js";
import { type SessionProvider, sessionProviderNames, sessionProviders } from "./up-front.js";

/**
 * Opt-in token limits for `strata diff` and `strata analyze`. A limit compares a stored-text figure
 * with a number of tokens the user chose; being over it says nothing about whether the configuration
 * got worse.
 */
export const limitNames = ["max-tokens", "max-increase", "max-up-front-tokens", "max-up-front-increase"] as const;
export type LimitName = (typeof limitNames)[number];

export interface Limit {
  name: LimitName;
  /** The one agent a session-start limit applies to; null applies it to every agent, or to the total. */
  agent: SessionProvider | null;
  /** Tokens. */
  value: number;
}

export interface LimitCheck {
  name: LimitName;
  /**
   * The agent whose session-start tokens were checked; null for the stored instructional text total,
   * or for a session-start limit without an agent that applied to no agent.
   */
  agent: SessionProvider | null;
  /** Tokens. */
  limit: number;
  /** Tokens at the base; null when there is no base, as in `strata analyze`, or for `unused`. */
  before: number | null;
  /** Tokens at the head, or at the latest revision; null for `unused`. */
  after: number | null;
  /**
   * `unused`: a session-start limit without an agent that applied to no agent, because no agent keeps
   * text at session start except those given their own limit of the same kind.
   */
  result: "within" | "over" | "unused";
}

/** Tokens at both sides; `before` is null when there is no base, as in `strata analyze`. */
export interface LimitFigure {
  before: number | null;
  after: number;
}

/** The figures limits are checked against, all in the run's measurement. */
export interface LimitFigures {
  total: LimitFigure;
  /** Session-start tokens of each agent that keeps text at session start at either side. */
  upFront: Map<SessionProvider, LimitFigure>;
}

const takesAgent = (name: LimitName) => name === "max-up-front-tokens" || name === "max-up-front-increase";
const isIncrease = (name: LimitName) => name === "max-increase" || name === "max-up-front-increase";

/** Read each flag's values, such as `8000` or `claude=8000`. Throws on a malformed or repeated limit. */
export function parseLimits(values: Partial<Record<LimitName, readonly string[] | undefined>>): Limit[] {
  const limits: Limit[] = [];
  for (const name of limitNames) {
    for (const raw of values[name] ?? []) {
      const match = /^(?:([a-z]+)=)?(\d{1,15})$/.exec(raw.trim());
      if (!match) {
        throw new Error(
          `--${name} must be a whole number of tokens${takesAgent(name) ? ", optionally after an agent name such as claude=" : ""}, not ${raw}`,
        );
      }
      const [, agentName, number] = match;
      if (agentName !== undefined && !takesAgent(name)) throw new Error(`--${name} does not take an agent name`);
      if (agentName !== undefined && !(sessionProviders as readonly string[]).includes(agentName)) {
        throw new Error(
          `Unknown agent ${agentName} in --${name}; use ${new Intl.ListFormat("en", { type: "disjunction" }).format(sessionProviders)}`,
        );
      }
      const agent = (agentName ?? null) as SessionProvider | null;
      if (limits.some((limit) => limit.name === name && limit.agent === agent)) {
        throw new Error(
          `--${name} is set twice${agent ? ` for ${agent}` : takesAgent(name) ? " for every agent" : ""}`,
        );
      }
      limits.push({ name, agent, value: Number(number) });
    }
  }
  return limits;
}

function check(limit: Limit, agent: SessionProvider | null, figure: LimitFigure): LimitCheck {
  const { before, after } = figure;
  // Increase limits always have a base: `strata analyze`, which has none, does not accept them.
  const measured = isIncrease(limit.name) ? after - (before ?? 0) : after;
  const result = measured > limit.value ? "over" : "within";
  return { name: limit.name, agent, limit: limit.value, before, after, result };
}

/**
 * Check each limit. A session-start limit without an agent applies to every agent that keeps text at
 * session start at either side, except one given its own limit of the same kind; when that leaves no
 * agent it gives one `unused` entry, so it is never lost. A limit for one agent is checked even when
 * that agent keeps nothing at session start, as zero tokens.
 */
export function checkLimits(limits: readonly Limit[], figures: LimitFigures): LimitCheck[] {
  const checks: LimitCheck[] = [];
  for (const name of limitNames) {
    const named = limits.filter((limit) => limit.name === name);
    if (!takesAgent(name)) {
      for (const limit of named) checks.push(check(limit, null, figures.total));
      continue;
    }
    const general = named.find((limit) => limit.agent === null);
    let applied = false;
    for (const agent of sessionProviders) {
      const limit =
        named.find((candidate) => candidate.agent === agent) ?? (figures.upFront.has(agent) ? general : undefined);
      if (!limit) continue;
      if (limit === general) applied = true;
      const figure = figures.upFront.get(agent) ?? { before: figures.total.before === null ? null : 0, after: 0 };
      checks.push(check(limit, agent, figure));
    }
    if (general && !applied) {
      checks.push({ name, agent: null, limit: general.value, before: null, after: null, result: "unused" });
    }
  }
  return checks;
}

const tokens = (count: number) => `${count} token${count === 1 ? "" : "s"}`;

function subject(check: LimitCheck): string {
  if (check.agent !== null) return `${sessionProviderNames[check.agent]} at session start`;
  return takesAgent(check.name) ? "every agent at session start" : "stored instructional text";
}

/** The change as a share of the base, such as " (+10.1%)", or nothing when the base had no tokens. */
function share(check: LimitCheck): string {
  const before = check.before ?? 0;
  if (before <= 0) return "";
  return ` (${signed(Math.round((((check.after ?? 0) - before) * 1000) / before) / 10)}%)`;
}

interface LimitNote {
  over: boolean;
  text: string;
}

/** What to say about each limit passed or applied to no agent; nothing for those within. */
function limitNotes(checks: readonly LimitCheck[]): LimitNote[] {
  return checks.flatMap((check): LimitNote[] => {
    if (check.result === "within") return [];
    if (check.result === "unused") {
      return [
        {
          over: false,
          text: `--${check.name} ${check.limit} applied to no agent: none keeps text at session start without its own limit.`,
        },
      ];
    }
    const what = subject(check);
    const delta = (check.after ?? 0) - (check.before ?? 0);
    return [
      {
        over: true,
        text: isIncrease(check.name)
          ? `${what} grew by ${tokens(delta)}${share(check)}, more than the ${check.limit} set with --${check.name}.`
          : `${what} is ${tokens(check.after ?? 0)}, more than the ${check.limit} set with --${check.name}.`,
      },
    ];
  });
}

/** One line per limit that was passed or applied to no agent, for the terminal. */
export function limitMessages(checks: readonly LimitCheck[]): string[] {
  return limitNotes(checks).map(({ over, text }) => `${over ? "Over limit" : "Limit not applied"}: ${text}`);
}

/**
 * The same notes as GitHub Actions workflow commands: an error, or a warning under `--on-exceed warn`,
 * for each limit passed, and a warning for each limit applied to no agent.
 */
export function limitAnnotations(checks: readonly LimitCheck[], level: "error" | "warning"): string[] {
  const command = (text: string) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return limitNotes(checks).map(({ over, text }) =>
    over
      ? `::${level} title=Strata context limit::${command(text)}`
      : `::warning title=Strata context limit not applied::${command(text)}`,
  );
}

/** A one-line summary of the checks, such as "Over 1 of 3 limits set for this run." */
export function limitSummary(checks: readonly LimitCheck[]): string {
  const over = checks.filter((check) => check.result === "over").length;
  const unused = checks.filter((check) => check.result === "unused").length;
  const within = checks.length - over - unused;
  const limits = `${checks.length} limit${checks.length === 1 ? "" : "s"}`;
  const lead = over
    ? `Over ${over} of ${limits}`
    : within === checks.length
      ? `Within ${checks.length === 1 ? "the" : "all"} ${limits}`
      : `Within ${within} of ${limits}`;
  return `${lead} set for this run${unused ? `; ${unused} applied to no agent` : ""}.`;
}

/** The Markdown table of checks for `strata diff`. */
export function limitLines(checks: readonly LimitCheck[]): string[] {
  if (!checks.length) return [];
  const over = checks.some((check) => check.result === "over");
  const summary = limitSummary(checks);
  const results: Record<LimitCheck["result"], string> = {
    over: "**Over**",
    within: "Within",
    unused: "Not applied: no agent without its own limit",
  };
  const rows = checks.map((check) => {
    const what = subject(check);
    const label = `${what[0]!.toUpperCase()}${what.slice(1)}${isIncrease(check.name) ? ", increase" : ""}`;
    const measured =
      check.after === null
        ? "—"
        : isIncrease(check.name)
          ? `${signed(check.after - (check.before ?? 0))}${share(check)}`
          : check.before === null
            ? String(check.after)
            : `${check.before} → ${check.after}`;
    return `| ${label} | ${measured} | ${check.limit} | ${results[check.result]} |`;
  });
  return [
    over ? `**${summary}**` : summary,
    "",
    "| Limit | Measured | Set to | Result |",
    "| --- | ---: | ---: | --- |",
    ...rows,
    "",
    "These limits were set for this run. Being over one means a figure passed the number chosen for it, not that the configuration got worse.",
    "",
  ];
}
