import type { RuleSet } from '@/lib/types';

/**
 * NON-BLOCKING rule-snapshot staleness signal.
 *
 * Amazon policy moves; a pack whose `verifiedAsOf` is older than
 * `staleAfterDays` should be re-verified. This is advisory ONLY — it is never
 * a gate failure and never touches `verified` (which stays exactly
 * gateResult.pass). Horizon and date both come from PACK DATA.
 */
export interface RuleStaleness {
  stale: boolean;
  ageDays: number | null;
  notice?: string;
}

const MS_PER_DAY = 86_400_000;

const parseDate = (iso: string | undefined): number =>
  iso ? Date.parse(`${iso}T00:00:00Z`) : Number.NaN;

/**
 * The OLDEST verification date that matters: the top-level snapshot date AND
 * every time-sensitive rule's own `verifiedAsOf`.
 *
 * Reading only the top-level date hid the real risk — a rule whose limit is
 * scheduled to change can be months staler than the snapshot header suggests.
 * A time-sensitive rule with no readable date is treated as unverified.
 */
function oldestVerification(rules: RuleSet): {
  date: string | undefined;
  ts: number;
  ruleId?: string;
  unreadableRuleId?: string;
} {
  let ts = parseDate(rules.verifiedAsOf);
  let date = rules.verifiedAsOf;
  let ruleId: string | undefined;
  let unreadableRuleId: string | undefined;
  for (const rule of rules.rules ?? []) {
    if (!rule.timeSensitive) continue;
    const parsed = parseDate(rule.verifiedAsOf);
    if (!Number.isFinite(parsed)) {
      unreadableRuleId ??= rule.id;
      continue;
    }
    if (!Number.isFinite(ts) || parsed < ts) {
      ts = parsed;
      date = rule.verifiedAsOf ?? date;
      ruleId = rule.id;
    }
  }
  return { date, ts, ruleId, unreadableRuleId };
}

export function rulesStaleness(rules: RuleSet, now: Date = new Date()): RuleStaleness {
  const horizon = rules.staleAfterDays;
  const topLevel = rules.verifiedAsOf;
  if (!Number.isFinite(parseDate(topLevel))) {
    return {
      stale: true,
      ageDays: null,
      notice:
        'Rule snapshot has no readable verifiedAsOf date — re-verify Amazon policy limits before relying on this run. This notice is advisory and does not affect the verify gate.',
    };
  }
  const oldest = oldestVerification(rules);
  if (oldest.unreadableRuleId) {
    return {
      stale: true,
      ageDays: null,
      notice: `Time-sensitive rule '${oldest.unreadableRuleId}' has no readable verifiedAsOf date (snapshot header says ${topLevel}) — re-verify the time-sensitive Amazon limits. This notice is advisory and does not affect the verify gate.`,
    };
  }
  const ageDays = Math.floor((now.getTime() - oldest.ts) / MS_PER_DAY);
  if (ageDays <= horizon) return { stale: false, ageDays };
  const source = oldest.ruleId
    ? `oldest time-sensitive rule '${oldest.ruleId}' verified ${oldest.date}; snapshot header ${topLevel}`
    : `snapshot header ${topLevel}`;
  return {
    stale: true,
    ageDays,
    notice: `Rule snapshot last verified ${oldest.date} (${source}) — ${ageDays} days ago, horizon ${horizon} days. Re-verify the time-sensitive Amazon limits. This notice is advisory and does not affect the verify gate.`,
  };
}
