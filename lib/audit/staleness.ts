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

export function rulesStaleness(rules: RuleSet, now: Date = new Date()): RuleStaleness {
  const verifiedAsOf = rules.verifiedAsOf;
  const horizon = rules.staleAfterDays;
  const parsed = verifiedAsOf ? Date.parse(`${verifiedAsOf}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return {
      stale: true,
      ageDays: null,
      notice:
        'Rule snapshot has no readable verifiedAsOf date — re-verify Amazon policy limits before relying on this run. This notice is advisory and does not affect the verify gate.',
    };
  }
  const ageDays = Math.floor((now.getTime() - parsed) / MS_PER_DAY);
  if (ageDays <= horizon) return { stale: false, ageDays };
  return {
    stale: true,
    ageDays,
    notice: `Rule snapshot last verified ${verifiedAsOf} (${ageDays} days ago, horizon ${horizon} days) — re-verify the time-sensitive Amazon limits. This notice is advisory and does not affect the verify gate.`,
  };
}
