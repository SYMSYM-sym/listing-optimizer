import type { BulletFormatRules, Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { arr, normalize, subtractDisclaimers } from '../util';
import { titleContentTokens } from './c-length';
import { disclaimerVariantsOf, fail } from './shared';

/**
 * C31 — BULLET FORMAT (WS10, playbook R4 + R6).
 *
 * TWO RULES, and only two, because these are the two the playbook states that
 * a machine can decide without guessing:
 *
 *  R6 COLON HEADER. The marketplace's own documented bullet pattern is a
 *     header fragment, a colon, then the body. A bullet with no header is a
 *     sentence in a list: it loses the scannable label a mobile reader
 *     actually reads, and the copy stops matching the canonical shape the
 *     marketplace's own rewrite pass looks for.
 *
 *  R4 WORD REPETITION inside one bullet. Stuffing lowers the assistant's trust
 *     score, and the same content word four times in one sentence is stuffing
 *     rather than copy.
 *
 * WHAT IS DELIBERATELY NOT HERE. Title Case per word and "write numbers under
 * ten as words" are both in the playbook and both stay PROMPT-GUIDED, because
 * each has a legitimate exception this system cannot distinguish from a
 * violation: a registered ingredient mark keeps its own registered casing, and
 * a measurement stays numeric. A check that cannot tell the exception from the
 * violation is a check that fails lawful copy, and over-blocking is as severe
 * as a bypass. The playbook left them unenforced for the same reason.
 *
 * PACK-DRIVEN, AND FAIL-CLOSED WITH IT: the cap, the header window and the
 * stopword list all come from `rules.bulletFormat` — and that block, its
 * `requireColonHeader` switch and its `wordRepetitionMax` cap are
 * `REQUIRED_PACK_PIECES` rows, so a compliance-bearing pack cannot disarm this
 * check by deleting or zeroing the data it reads.
 */
const CHECK_ID = 'C31';

export function c31BulletFormat(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const rules: BulletFormatRules | undefined = pack.rules?.bulletFormat;
  // Not a silent pass. `rules.bulletFormat`, `.requireColonHeader` and
  // `.wordRepetitionMax` are all `REQUIRED_PACK_PIECES` rows (F5), because
  // deleting the block disarms BOTH legs of this check and zeroing the cap
  // disarms R4 — which is precisely the manifest's membership test. A
  // compliance-bearing pack that ships none therefore already fails CLOSED at
  // PACK before this early return is ever reached; the return only keeps a
  // non-compliance pack from crashing.
  if (!rules) return [];

  const out: Failure[] = [];
  const bullets = arr<unknown>(l.bullets);
  // REQUIRED legal text is subtracted before both rules, exactly as C17 does:
  // a bullet that carries the verbatim disclaimer must not be failed for the
  // shape of a sentence the law obliges it to contain.
  const disclaimers = [pack.compliancePack, ...(pack.crossCheckCompliancePacks ?? [])]
    .filter((cp): cp is NonNullable<typeof cp> => !!cp)
    .flatMap((cp) => disclaimerVariantsOf(cp))
    .map(normalize);

  bullets.forEach((raw, i) => {
    const text = subtractDisclaimers(
      normalize(typeof raw === 'string' ? raw : raw == null ? '' : String(raw)),
      disclaimers,
    ).trim();
    // An empty/degenerate bullet is C2's failure, not this check's — reporting
    // it twice tells the operator to fix two things when there is one.
    if (!text || !/[a-z]/i.test(text)) return;

    // --- R6: the colon header ---
    if (rules.requireColonHeader) {
      const colon = text.indexOf(':');
      const window = rules.headerMaxChars ?? 60;
      const min = rules.headerMinChars ?? 3;
      if (colon === -1 || colon > window) {
        out.push(
          fail(
            CHECK_ID,
            `bullets[${i}]`,
            text.slice(0, 60),
            `Open the bullet with a short header fragment followed by a colon, inside the first ${window} characters ("Header fragment: body text") — the marketplace's own documented bullet pattern`,
          ),
        );
      } else {
        const header = text.slice(0, colon).trim();
        if (header.length < min || !/[a-z]/i.test(header)) {
          out.push(
            fail(
              CHECK_ID,
              `bullets[${i}]`,
              `header '${header}'`,
              `The header fragment before the colon must be real words, at least ${min} characters`,
            ),
          );
        }
      }
    }

    // --- R4: word repetition inside the bullet ---
    const max = rules.wordRepetitionMax ?? 0;
    if (max > 0) {
      const counts = new Map<string, number>();
      // The SAME tokenizer C1 uses on the title: stemmed, stopword-filtered,
      // so "capsule" and "capsules" are one word on both surfaces.
      for (const token of titleContentTokens(text, rules.stopwords ?? [])) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
      for (const [word, n] of counts) {
        if (n > max) {
          out.push(
            fail(
              CHECK_ID,
              `bullets[${i}]`,
              `'${word}' x${n}`,
              `No word may appear more than ${max}x in one bullet — replace the repeats of '${word}'; the same word four times in a sentence reads as stuffing, not as copy`,
            ),
          );
        }
      }
    }
  });

  return out;
}
