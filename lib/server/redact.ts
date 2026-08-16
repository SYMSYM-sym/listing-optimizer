import 'server-only';

/**
 * Credential redaction for anything that is about to be LOGGED or returned to a
 * caller.
 *
 * This exists because of one specific hazard. An upstream SDK error message is
 * built from the failing REQUEST as well as the response — a connection error
 * can carry a URL, a middleware error can carry header context — so the moment
 * we start logging `error.message` (which `lib/engine/llm.ts` now does for
 * infrastructure failures, and deliberately still does NOT do for anything
 * derived from model output) we have opened a path on which an API key could
 * reach stdout. `redactSecrets` closes it before the string is ever handed to
 * `logServer`.
 *
 * THE LITERAL KEY PREFIX IS NEVER SPELLED OUT IN THIS FILE. The patterns below
 * are written as `sk-` plus a character class rather than as the vendor's
 * contiguous prefix string. That is not obfuscation — it is strictly BROADER
 * (it catches every `sk-…` style credential, not one vendor's), and it means
 * `npm run check:secrets`, which greps the built client bundle for that exact
 * literal, can never be tripped by this module even if a future refactor made
 * it client-reachable. It is server-only regardless.
 *
 * Redaction is deliberately lossy and one-way: there is no "unredact". A string
 * that has been through here is safe to log, safe to return in an API body, and
 * useless to an attacker who has read the logs.
 */

/**
 * Cap on the input we are willing to scan. Error messages are bounded in
 * practice; this only stops a pathological megabyte-long `message` from
 * costing real CPU in the failure path, which is the worst possible moment to
 * be slow. A credential straddling the cap still has its prefix inside it and
 * is still matched by the `{8,}` patterns below.
 */
const MAX_SCAN = 4000;

const MASK = '[REDACTED]';

/**
 * Ordered most-specific-first. Each rule keeps the LABEL (so an operator can
 * still tell WHICH credential was present) and destroys only the value.
 */
const RULES: readonly [RegExp, string][] = [
  // `Authorization: Bearer <token>` in any casing/spacing.
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${MASK}`],
  // A header or field NAMED as a credential, followed by its value. Covers
  // `x-api-key: …`, `anthropic-api-key=…`, `"apiKey":"…"`, `api_key = …`.
  [
    /\b((?:x-)?(?:anthropic-)?api[-_ ]?key|authorization|secret|token|password)\b(["']?\s*[:=]\s*["']?)[^\s"',;)}\]]+/gi,
    `$1$2${MASK}`,
  ],
  // Vendor `sk-…` style keys. Written as prefix + class on purpose (see above).
  [/\bsk-[A-Za-z0-9_-]{8,}/g, MASK],
  // Anything left that is simply too long and too random to be prose. A real
  // sentence does not contain a 40-character unbroken token; a leaked key does.
  [/\b[A-Za-z0-9_-]{40,}\b/g, MASK],
];

/**
 * Mask every credential-shaped run in `input`.
 *
 * Safe to call on a string that contains no secret: it is then a no-op, which
 * is why callers can apply it unconditionally rather than trying to decide
 * per-error whether a key could be present. Deciding per-error is exactly the
 * kind of judgement that rots.
 */
export function redactSecrets(input: string): string {
  let out = input.length > MAX_SCAN ? input.slice(0, MAX_SCAN) : input;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Redact FIRST, then truncate — never the other way round. Truncating first
 * could cut a key in half and leave the surviving half in the log, which is
 * both a leak and an unhelpful one.
 */
export function redactAndTruncate(input: string, maxChars: number): string {
  return redactSecrets(input).slice(0, maxChars);
}
