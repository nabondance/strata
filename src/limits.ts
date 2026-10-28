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
  /** The number as typed, without `%`: at most 15 significant digits, so `Number(digits)` keeps it exactly. */
  digits: string;
  /** Only for increase limits: `digits` is a percentage of the base. */
  percent: boolean;
}

export interface LimitCheck {
  name: LimitName;
  /**
   * The agent whose session-start tokens were checked; null for the stored instructional text total,
   * or for a session-start limit without an agent that found no agent to apply to.
   */
  agent: SessionProvider | null;
  /** The limit as given; `percent` makes it a percentage of the base. */
  limit: number;
  percent: boolean;
  /** Tokens at the base; null when there is no base, as in `strata analyze`, or for `no-agent`. */
  before: number | null;
  /** Tokens at the head, or at the latest revision; null for `no-agent`. */
  after: number | null;
  /**
   * `unchecked`: a percentage limit on a figure that had no tokens at the base and grew.
   * `no-agent`: a session-start limit without an agent, when no agent reads stored text.
   */
  result: "within" | "over" | "unchecked" | "no-agent";
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
      // Beyond 15 significant digits a number no longer prints back as typed; padding zeros do not count.
      const [whole, fraction = ""] = number!.split(".");
      if ((whole! + fraction.replace(/0+$/, "")).replace(/^0+/, "").length > 15)
        throw new Error(`--${name} allows at most 15 significant digits, not ${raw}`);
      const agent = (agentName ?? null) as SessionProvider | null;
      // One token limit and one percentage limit may apply to the same figure: the token limit covers a zero base.
      if (limits.some((limit) => limit.name === name && limit.agent === agent && limit.percent === !!percent)) {
        throw new Error(
          `--${name} is set twice as ${percent ? "a percentage" : "a number of tokens"}${agent ? ` for ${agent}` : takesAgent(name) ? " for every agent" : ""}`,
        );
      }
      limits.push({ name, agent, digits: number!, percent: !!percent });
    }
  }
  return limits;
}

/** A decimal as a whole number over a power of ten, so comparisons with it are exact. */
function exact(digits: string): { units: bigint; scale: bigint } {
  const [whole, fraction = ""] = digits.split(".");
  return { units: BigInt(whole! + fraction), scale: 10n ** BigInt(fraction.length) };
}

/** A limit's number as plain digits, never exponent notation such as 1.5e-7. */
function plain(value: number): string {
  return value.toLocaleString("en", { maximumFractionDigits: 20, useGrouping: false });
}

function check(limit: Limit, agent: SessionProvider | null, figure: LimitFigure): LimitCheck {
  const { before, after } = figure;
  // Increase limits always have a base: `strata analyze`, which has none, does not accept them.
  const increase = after - (before ?? 0);
  const value = Number(limit.digits);
  let result: LimitCheck["result"];
  if (!isIncrease(limit.name)) result = after > value ? "over" : "within";
  else if (!limit.percent) result = increase > value ? "over" : "within";
  else if (!before) result = increase > 0 ? "unchecked" : "within";
  else {
    // Compare whole numbers built from the digits as typed, so 0.57% sits exactly on its boundary.
    const { units, scale } = exact(limit.digits);
    result = BigInt(increase) * 100n * scale > units * BigInt(before) ? "over" : "within";
  }
  return { name: limit.name, agent, limit: value, percent: limit.percent, before, after, result };
}

/**
 * Check each limit, tokens before percentages. A session-start limit without an agent applies to every
 * agent that reads stored text at either side, except one given its own limit of the same kind (tokens
 * or percentage); when no agent reads stored text it gives one `no-agent` entry, so it is never lost. A
 * limit for one agent is checked even when that agent reads nothing, as zero tokens.
 */
export function checkLimits(limits: readonly Limit[], figures: LimitFigures): LimitCheck[] {
  const checks: LimitCheck[] = [];
  for (const name of limitNames) {
    for (const percent of [false, true]) {
      const named = limits.filter((limit) => limit.name === name && limit.percent === percent);
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
      if (general && !figures.upFront.size) {
        const limit = Number(general.digits);
        checks.push({ name, agent: null, limit, percent, before: null, after: null, result: "no-agent" });
      }
    }
  }
  return checks;
}

function subject(check: LimitCheck): string {
  if (check.agent !== null) return `${sessionProviderNames[check.agent]} at session start`;
  return takesAgent(check.name) ? "every agent at session start" : "stored instructional text";
}

function setTo(check: LimitCheck): string {
  return `${plain(check.limit)}${check.percent ? "%" : ""}`;
}

/** The change as a share of the base, in percent times 10^decimals, rounded half away from zero. */
function shareUnits(check: LimitCheck, decimals: number): bigint {
  const before = BigInt(check.before ?? 0);
  const change = BigInt((check.after ?? 0) - (check.before ?? 0));
  const magnitude = (change < 0n ? -change : change) * 100n * 10n ** BigInt(decimals);
  const rounded = magnitude / before + ((magnitude % before) * 2n >= before ? 1n : 0n);
  return change < 0n ? -rounded : rounded;
}

/**
 * The fewest decimals, at least one, at which a percentage check's share does not contradict its
 * result, such as +10.05% rather than +10.1% within a 10.05% limit; one for every other check.
 */
function decimalsFor(check: LimitCheck): number {
  if (!check.percent || !check.before || (check.result !== "over" && check.result !== "within")) return 1;
  const { units, scale } = exact(plain(check.limit));
  for (let decimals = 1; decimals < 20; decimals++) {
    const shown = shareUnits(check, decimals) * scale;
    const limit = units * 10n ** BigInt(decimals);
    if (check.result === "over" ? shown > limit : shown <= limit) return decimals;
  }
  return 20;
}

/**
 * The change as a share of the base, such as " (+12.5%)", or nothing when the base had no tokens: the
 * same figure as a comparison's `percentChange`. Every check of one figure prints it with the same
 * decimals, enough that no percentage check's share contradicts its result.
 */
function share(check: LimitCheck, checks: readonly LimitCheck[]): string {
  if (!check.before || check.after === null) return "";
  const decimals = Math.max(
    ...checks
      .filter((other) => other.name === check.name && other.agent === check.agent && other.before)
      .map(decimalsFor),
  );
  const units = shareUnits(check, decimals);
  const magnitude = units < 0n ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const fraction = (magnitude % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const text = `${magnitude / scale}${fraction ? `.${fraction}` : ""}`;
  return ` (${units > 0n ? "+" : units < 0n ? "-" : ""}${text}%)`;
}

function increase(check: LimitCheck, checks: readonly LimitCheck[]): string {
  return `${signed((check.after ?? 0) - (check.before ?? 0))}${share(check, checks)}`;
}

interface LimitNote {
  over: boolean;
  text: string;
}

/** What to say about each limit passed or not checked; nothing for those within. */
function limitNotes(checks: readonly LimitCheck[]): LimitNote[] {
  return checks.flatMap((check): LimitNote[] => {
    const what = subject(check);
    const flag = `--${check.name} ${setTo(check)}`;
    switch (check.result) {
      case "no-agent":
        return [{ over: false, text: `no agent reads stored text, so ${flag} had nothing to check.` }];
      case "unchecked":
        return [{ over: false, text: `${flag} for ${what}, which had no tokens at the base.` }];
      case "over":
        return [
          {
            over: true,
            text: isIncrease(check.name)
              ? `${what} grew by ${(check.after ?? 0) - (check.before ?? 0)} tokens${share(check, checks)}, more than the ${setTo(check)} set with --${check.name}.`
              : `${what} is ${check.after} tokens, more than the ${setTo(check)} set with --${check.name}.`,
          },
        ];
      default:
        return [];
    }
  });
}

/** One line per limit that was passed or could not be checked, for the terminal. */
export function limitMessages(checks: readonly LimitCheck[]): string[] {
  return limitNotes(checks).map(({ over, text }) => `${over ? "Over limit" : "Limit not checked"}: ${text}`);
}

/**
 * The same notes as GitHub Actions workflow commands: an error, or a warning under `--on-exceed warn`,
 * for each limit passed, and a warning for each limit not checked.
 */
export function limitAnnotations(checks: readonly LimitCheck[], level: "error" | "warning"): string[] {
  const command = (text: string) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return limitNotes(checks).map(({ over, text }) =>
    over
      ? `::${level} title=Strata context limit::${command(text)}`
      : `::warning title=Strata context limit not checked::${command(text)}`,
  );
}

/** A one-line summary of the checks, such as "Over 1 of 3 limits set for this run." */
export function limitSummary(checks: readonly LimitCheck[]): string {
  const count = (result: LimitCheck["result"]) => checks.filter((check) => check.result === result).length;
  const over = count("over");
  const within = count("within");
  const unchecked = count("unchecked");
  const noAgent = count("no-agent");
  const limits = `${checks.length} limit${checks.length === 1 ? "" : "s"}`;
  const lead = over
    ? `Over ${over} of ${limits} set for this run`
    : within === checks.length
      ? `Within ${checks.length === 1 ? "the" : "all"} ${limits} set for this run`
      : within
        ? `Within ${within} of ${limits} set for this run`
        : checks.length === 1
          ? "The 1 limit set for this run could not be checked"
          : `None of the ${limits} set for this run could be checked`;
  const reasons = [
    ...(unchecked ? [`${unchecked} not checked because the base had no tokens`] : []),
    ...(noAgent ? [`${noAgent} had nothing to check because no agent reads stored text`] : []),
  ];
  // A lone limit that could not be checked needs only its reason.
  if (!over && !within && checks.length === 1) {
    return `${lead}: ${unchecked ? "the base had no tokens" : "no agent reads stored text"}.`;
  }
  return `${lead}${reasons.length ? `; ${reasons.join("; ")}` : ""}.`;
}

/** The Markdown table of checks for `strata diff`. */
export function limitLines(checks: readonly LimitCheck[]): string[] {
  if (!checks.length) return [];
  const over = checks.some((check) => check.result === "over");
  const summary = limitSummary(checks);
  const results: Record<LimitCheck["result"], string> = {
    over: "**Over**",
    within: "Within",
    unchecked: "Not checked: none at base",
    "no-agent": "Not checked: no agent reads stored text",
  };
  const rows = checks.map((check) => {
    const what = subject(check);
    const label = `${what[0]!.toUpperCase()}${what.slice(1)}${isIncrease(check.name) ? ", increase" : ""}`;
    const measured =
      check.after === null
        ? "—"
        : isIncrease(check.name)
          ? increase(check, checks)
          : check.before === null
            ? String(check.after)
            : `${check.before} → ${check.after}`;
    return `| ${label} | ${measured} | ${setTo(check)} | ${results[check.result]} |`;
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
