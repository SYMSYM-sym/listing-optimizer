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

/**
 * NON-BLOCKING ATTRIBUTE-SCHEMA staleness signal — the same discipline
 * `rulesStaleness` applies to the rule snapshot, applied to the attribute
 * template.
 *
 * WHY IT IS SEPARATE. The two snapshots move for different reasons and are
 * re-verified by different work: policy limits change when Amazon announces a
 * policy, attribute templates change when a category's Listing Report changes.
 * Folding the schema date into `rulesStaleness` would let a fresh rule
 * snapshot mask a two-year-old attribute template.
 *
 * ADVISORY ONLY, exactly like `rulesStaleness`: it is never a gate failure and
 * never touches `verified`.
 *
 * A pack that ships NO schema meta (e.g. the generic pack, whose schema is
 * empty) is NOT stale — there is no template to have gone stale. A pack that
 * DOES declare a schema but whose date is unreadable IS stale: a schema
 * claiming no verification date is exactly the case worth reporting.
 */
export function attributeSchemaStaleness(
  meta: { verifiedAsOf?: string; staleAfterDays?: number } | undefined,
  now: Date = new Date(),
): RuleStaleness {
  if (!meta) return { stale: false, ageDays: null };
  const ts = parseDate(meta.verifiedAsOf);
  if (!Number.isFinite(ts)) {
    return {
      stale: true,
      ageDays: null,
      notice:
        'Attribute schema has no readable verifiedAsOf date — re-verify the category attribute template (Category Listing Report) before relying on this run. This notice is advisory and does not affect the verify gate.',
    };
  }
  const horizon = typeof meta.staleAfterDays === 'number' ? meta.staleAfterDays : 180;
  const ageDays = Math.floor((now.getTime() - ts) / MS_PER_DAY);
  if (ageDays <= horizon) return { stale: false, ageDays };
  return {
    stale: true,
    ageDays,
    notice: `Attribute schema last verified ${meta.verifiedAsOf} — ${ageDays} days ago, horizon ${horizon} days. Re-verify the category attribute template (Category Listing Report). This notice is advisory and does not affect the verify gate.`,
  };
}
