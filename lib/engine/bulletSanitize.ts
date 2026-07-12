/**
 * Deterministic bullet length cleanup (generation policy, not gate laundering).
 * Truncates each bullet to ≤ maxChars at a word boundary; preserves a trailing
 * claim-bearing `*` when present. The gate still re-validates afterwards.
 */
export function sanitizeBullets(bullets: string[], maxChars: number): string[] {
  return bullets.map((raw) => {
    const claimStar = raw.trimEnd().endsWith('*');
    let body = claimStar ? raw.trimEnd().slice(0, -1).trimEnd() : raw.trim();
    const budget = claimStar ? maxChars - 1 : maxChars;
    if (body.length <= budget) {
      return claimStar ? `${body}*` : body;
    }
    // Prefer cutting at the last space within budget
    let cut = body.slice(0, budget);
    const sp = cut.lastIndexOf(' ');
    if (sp >= Math.floor(budget * 0.6)) cut = cut.slice(0, sp);
    cut = cut.trimEnd().replace(/[,:;.-]+$/, '').trimEnd();
    return claimStar ? `${cut}*` : cut;
  });
}
