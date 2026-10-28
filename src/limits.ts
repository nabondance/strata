import { signed } from "./format.js";
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
  /** `value` as typed, digits only, so a percentage compares exactly. */
  digits: string;
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

/** Tokens at both sides; `before` is null when there is no base, as in `strata analyze`. */
export interface LimitFigure {
  before: number | null;
  after: number;
}

/** The figures limits are checked against, all in the run's measurement. */
export interface LimitFigures {
  total: LimitFigure;
  /** Session-start tokens of each agent that reads stored text at either side; their bases match the total's. */
  upFront: Map<SessionProvider, LimitFigure>;
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
      limits.push({ name, agent, value: Number(number), percent: !!percent, digits: number! });
    }
  }
  return limits;
}

function check(limit: Limit, agent: SessionProvider | null, figure: LimitFigure): LimitCheck {
  const { before, after } = figure;
  // Increase limits always have a base: `strata analyze`, which has none, does not accept them.
  const increase = after - (before ?? 0);
  let result: LimitCheck["result"];
  if (!isIncrease(limit.name)) result = after > limit.value ? "over" : "within";
  else if (!limit.percent) result = increase > limit.value ? "over" : "within";
  else if (!before) result = increase > 0 ? "unchecked" : "within";
  else {
    // Compare whole numbers built from the digits as typed, so 0.57% sits exactly on its boundary.
    const [whole, fraction = ""] = limit.digits.split(".");
    const percent = BigInt(whole + fraction);
    const scale = 10n ** BigInt(fraction.length);
    result = BigInt(increase) * 100n * scale > percent * BigInt(before) ? "over" : "within";
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
      const figure = figures.upFront.get(agent) ?? { before: figures.total.before === null ? null : 0, after: 0 };
      checks.push(check(limit, agent, figure));
    }
  }
  return checks;
}

function subject(check: LimitCheck): string {
  return check.agent === null ? "stored instructional text" : `${sessionProviderNames[check.agent]} at session start`;
}

function setTo(check: LimitCheck): string {
  // Plain digits, never exponent notation such as 1.5e-7.
  return `${check.limit.toLocaleString("en", { maximumFractionDigits: 20, useGrouping: false })}${check.percent ? "%" : ""}`;
}

/** The increase as a signed number, with its share of the base when the base had tokens. */
function increase(check: LimitCheck): string {
  return `${signed(check.after - (check.before ?? 0))}${share(check)}`;
}

/**
 * The change as a share of the base to one decimal, such as " (+12.5%)", or nothing when the base had
 * no tokens; the same figure as a comparison's `percentChange`. Growth checked against a percentage
 * rounds toward the result, in whole numbers, so a share over 10% never prints as 10%.
 */
function share(check: LimitCheck): string {
  const before = check.before ?? 0;
  if (before <= 0) return "";
  const thousandths = (check.after - before) * 1000;
  const tenths =
    check.percent && thousandths > 0
      ? Math.floor(thousandths / before) + (check.result === "over" && thousandths % before ? 1 : 0)
      : Math.round(thousandths / before);
  return ` (${signed(tenths / 10)}%)`;
}

/** One line per limit that was passed or could not be checked, for the terminal. */
export function limitMessages(checks: readonly LimitCheck[]): string[] {
  return checks.flatMap((check) => {
    const what = subject(check);
    if (check.result === "unchecked") {
      return [`Limit not checked: --${check.name} ${setTo(check)} for ${what}, which had no tokens at the base.`];
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
  const skipped = `${unchecked} not checked because the base had no tokens`;
  if (!over && !within)
    return `The ${count} set for this run ${unchecked === 1 ? "was" : "were"} not checked: the base had no tokens.`;
  const lead = over
    ? `Over ${over} of ${count}`
    : within === checks.length
      ? `Within ${checks.length === 1 ? "the" : "all"} ${count}`
      : `Within ${within} of ${count}`;
  return `${lead} set for this run${unchecked ? `; ${skipped}` : ""}.`;
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
