import { type SessionProvider, sessionProviderNames, sessionProviders } from "./up-front.js";

/**
 * Opt-in token limits for `strata diff` and `strata analyze`. A limit compares a stored-text figure
 * with a number the user chose; being over it says nothing about whether the configuration got worse.
 */
export const limitNames = ["max-tokens", "max-increase", "max-up-front-tokens", "max-up-front-increase"] as const;
export type LimitName = (typeof limitNames)[number];

export interface Limit {
  name: LimitName;
  /** The one agent a session-start limit applies to; null applies it to every agent, or to the total. */
  agent: SessionProvider | null;
  value: number;
  /** Only for increase limits: `value` is a percentage of the base. */
  percent: boolean;
}

export interface LimitCheck {
  name: LimitName;
  /** The agent whose session-start tokens were checked; null for the stored instructional text total. */
  agent: SessionProvider | null;
  limit: number;
  percent: boolean;
  /** Tokens at the base; null when there is no base, as in `strata analyze`. */
  before: number | null;
  /** Tokens at the head, or at the latest revision. */
  after: number;
  /** `unchecked`: a percentage limit on a figure that had no tokens at the base and grew. */
  result: "within" | "over" | "unchecked";
}

/** The figures limits are checked against, all in the run's measurement. */
export interface LimitFigures {
  total: { before: number | null; after: number };
  /** Session-start tokens of each agent that reads stored text at either side. */
  upFront: Map<SessionProvider, { before: number | null; after: number }>;
  /** Whether there is a base to compare with. */
  compared: boolean;
}

const takesAgent = (name: LimitName) => name === "max-up-front-tokens" || name === "max-up-front-increase";
const isIncrease = (name: LimitName) => name === "max-increase" || name === "max-up-front-increase";

/** Read each flag's values, such as `8000`, `10%`, or `claude=8000`. Throws on a malformed or repeated limit. */
export function parseLimits(values: Partial<Record<LimitName, readonly string[] | undefined>>): Limit[] {
  const limits: Limit[] = [];
  for (const name of limitNames) {
    for (const raw of values[name] ?? []) {
      const match = /^(?:([a-z]+)=)?(\d+(?:\.\d+)?)(%)?$/.exec(raw.trim());
      if (!match) {
        throw new Error(
          `--${name} must be a number of tokens${isIncrease(name) ? " or a percentage such as 10%" : ""}${takesAgent(name) ? ", optionally after an agent name such as claude=" : ""}, not ${raw}`,
        );
      }
      const [, agentName, number, percent] = match;
      if (agentName !== undefined && !takesAgent(name)) throw new Error(`--${name} does not take an agent name`);
      if (agentName !== undefined && !(sessionProviders as readonly string[]).includes(agentName)) {
        throw new Error(
          `Unknown agent ${agentName} in --${name}; use ${new Intl.ListFormat("en", { type: "disjunction" }).format(sessionProviders)}`,
        );
      }
      if (percent && !isIncrease(name)) throw new Error(`--${name} takes a number of tokens, not a percentage`);
      if (!percent && number!.includes(".")) throw new Error(`--${name} needs a whole number of tokens, not ${raw}`);
      const agent = (agentName ?? null) as SessionProvider | null;
      if (limits.some((limit) => limit.name === name && limit.agent === agent)) {
        throw new Error(
          `--${name} is set twice${agent ? ` for ${agent}` : takesAgent(name) ? " for every agent" : ""}`,
        );
      }
      limits.push({ name, agent, value: Number(number), percent: !!percent });
    }
  }
  return limits;
}

function check(limit: Limit, agent: SessionProvider | null, figure: LimitFigures["total"]): LimitCheck {
  const { before, after } = figure;
  let result: LimitCheck["result"];
  if (!isIncrease(limit.name)) {
    result = after > limit.value ? "over" : "within";
  } else {
    if (before === null) throw new Error(`--${limit.name} needs a base to compare with`);
    const increase = after - before;
    if (!limit.percent) result = increase > limit.value ? "over" : "within";
    else if (before === 0) result = increase > 0 ? "unchecked" : "within";
    else {
      // Compare in whole numbers so a percentage such as 0.57 sits exactly on its boundary.
      const [whole, fraction = ""] = String(limit.value).split(".");
      const scale = 10 ** fraction.length;
      result = increase * 100 * scale > Number(whole + fraction) * before ? "over" : "within";
    }
  }
  return { name: limit.name, agent, limit: limit.value, percent: limit.percent, before, after, result };
}

/**
 * Check each limit. A session-start limit without an agent applies to every agent that reads stored
 * text at either side, except one given its own limit of the same kind; a limit for one agent is
 * checked even when that agent reads nothing, as zero tokens.
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
    for (const agent of sessionProviders) {
      const limit =
        named.find((candidate) => candidate.agent === agent) ?? (figures.upFront.has(agent) ? general : undefined);
      if (!limit) continue;
      const figure = figures.upFront.get(agent) ?? { before: figures.compared ? 0 : null, after: 0 };
      checks.push(check(limit, agent, figure));
    }
  }
  return checks;
}

const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

function subject(check: LimitCheck): string {
  return check.agent === null ? "stored instructional text" : `${sessionProviderNames[check.agent]} at session start`;
}

function setTo(check: LimitCheck): string {
  return `${check.limit}${check.percent ? "%" : ""}`;
}

/** The increase as a signed number, with its share of the base when the base had tokens. */
function increase(check: LimitCheck): string {
  return `${signed(check.after - (check.before ?? 0))}${share(check)}`;
}

/**
 * The increase as a share of the base, such as " (+12.5%)", or nothing when the base had no tokens.
 * Against a percentage limit it rounds toward the result, so a share over 10% never prints as 10%.
 */
function share(check: LimitCheck): string {
  const before = check.before ?? 0;
  if (before <= 0) return "";
  const tenths = ((check.after - before) * 1000) / before;
  const rounded = !check.percent
    ? Math.round(tenths)
    : check.result === "over"
      ? Math.ceil(tenths)
      : Math.floor(tenths);
  return ` (${signed(rounded / 10)}%)`;
}

/** One line per limit that was passed or could not be checked, for the terminal. */
export function limitMessages(checks: readonly LimitCheck[]): string[] {
  return checks.flatMap((check) => {
    const what = subject(check);
    if (check.result === "unchecked") {
      return [`Note: --${check.name} ${setTo(check)} was not checked for ${what}: it had no tokens at the base.`];
    }
    if (check.result === "within") return [];
    return [
      isIncrease(check.name)
        ? `Over limit: ${what} grew by ${check.after - (check.before ?? 0)} tokens${share(check)}, more than the ${setTo(check)} set with --${check.name}.`
        : `Over limit: ${what} is ${check.after} tokens, more than the ${setTo(check)} set with --${check.name}.`,
    ];
  });
}

/** A one-line summary of the checks, such as "Over 1 of 3 limits set for this run." */
export function limitSummary(checks: readonly LimitCheck[]): string {
  const over = checks.filter((check) => check.result === "over").length;
  const unchecked = checks.filter((check) => check.result === "unchecked").length;
  const within = checks.length - over - unchecked;
  const count = `${checks.length} limit${checks.length === 1 ? "" : "s"}`;
  const lead = over
    ? `Over ${over} of ${count}`
    : within === checks.length
      ? `Within ${checks.length === 1 ? "the" : "all"} ${count}`
      : `Within ${within} of ${count}`;
  return `${lead} set for this run${unchecked ? `; ${unchecked} not checked because the base had no tokens` : ""}.`;
}

/** The Markdown table of checks for `strata diff`. */
export function limitLines(checks: readonly LimitCheck[]): string[] {
  if (!checks.length) return [];
  const over = checks.some((check) => check.result === "over");
  const summary = limitSummary(checks);
  const rows = checks.map((check) => {
    const what = subject(check);
    const label = `${what[0]!.toUpperCase()}${what.slice(1)}${isIncrease(check.name) ? ", increase" : ""}`;
    const measured = isIncrease(check.name)
      ? increase(check)
      : check.before === null
        ? String(check.after)
        : `${check.before} → ${check.after}`;
    const result =
      check.result === "over" ? "**Over**" : check.result === "within" ? "Within" : "Not checked: none at base";
    return `| ${label} | ${measured} | ${setTo(check)} | ${result} |`;
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
