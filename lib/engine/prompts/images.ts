import type { ImageArchitecture, KnowledgePack, ListingSnapshot } from '@/lib/types';
import { heroSpecBlock, snapshotBlock } from './shared';

/**
 * WS8 — the VISUAL PRODUCTION brief.
 *
 * PROMPTS, NOT ASSETS. This app writes briefs; the operator renders them and
 * controls the credit spend. That is a logged decision, not an omission.
 *
 * The slot architecture, the ALT cap and the video window are ALL pack data
 * (`rules.imageArchitecture`), so this module authors no visual doctrine of
 * its own and gate C29 verifies the emitted brief against the SAME slot specs
 * the prompt was rendered from.
 */
function slotLines(arch: ImageArchitecture | undefined): string {
  const slots = (arch?.slots ?? []).filter((s) => s?.slot && s?.purpose);
  if (slots.length === 0) return '';
  // The id is written where the field wants it — `"slot": 1` — because the
  // previous rendering, `(1) "main-white-background" — …`, put a NUMBER and a
  // quoted LABEL side by side and said nothing about which one the `slot`
  // field takes. Every live run wrote the label and failed zod on all eight
  // rows (D2). The schema is built from these same pack rows.
  return slots.map((s) => `"slot": ${s.slot} — the ${s.purpose} image: ${s.guidance}`).join('\n');
}

/** The permitted `slot` values, verbatim from the pack. */
function slotIds(arch: ImageArchitecture | undefined): string {
  return (arch?.slots ?? [])
    .filter((s) => s?.slot && s?.purpose)
    .map((s) => String(s.slot))
    .join(', ');
}

export function imagesPrompt(snapshot: ListingSnapshot, pack: KnowledgePack): string {
  const r = pack.rules;
  const arch = r.imageArchitecture;
  const slots = (arch?.slots ?? []).filter((s) => s?.slot && s?.purpose);
  const count = slots.length;
  const altMax = arch?.altMax ?? 100;
  const video = arch?.video;
  const videoBlock = video
    ? [
        `VIDEO BRIEF (${video.aspect}, ${video.minSeconds}-${video.maxSeconds} seconds):`,
        ...(video.guidance ?? []).map((g) => `- ${g}`),
      ].join('\n')
    : '';

  // The hero-spec rule, stated AT this surface rather than only in the shared
  // system preamble — a video overlay is where a headline figure gets written
  // as a slogan (see `heroSpecBlock`). Empty string when the pack ships none.
  const heroSpec = heroSpecBlock(r.units);

  return `${snapshotBlock(snapshot)}

${heroSpec}

TASK: A ${count}-slot image plan plus a ${video?.aspect ?? '9:16'} video brief.

SLOTS — one object per slot, in this order, writing each one to its stated job and stating its stated requirements IN THE BRIEF:
${slotLines(arch)}

- "slot": the whole number shown for that slot above and nothing else — exactly one of ${slotIds(arch)}. It is an id, not a name: never write the wording that follows it, never renumber, never skip one.
- "spec": the concrete production requirements for that slot. Where the slot's job names a requirement above (a background colour, a fill share, a pixel floor, a real photograph), write that requirement out in the spec in those words — a requirement nobody wrote down is a requirement nobody renders.
- "purpose", "spec" and "notes" are written in sentence case, never in capitals. "notes": copy and layout guidance.
- "altText": a paste-ready ALT string for that image, at most ${altMax} characters. Describe what the image SHOWS, in plain words, front-loading the product and the one fact the image carries. Never name another brand: ALT text is invisible on the page and a rival's name sitting there is a trademark exposure.
- Every field describes ONLY what the finished image SHOWS. Write it as a positive instruction ("show the printed panel, sharp and evenly lit"), keep the wording factual and non-medical, and keep the overlay text to product facts. Never restate a compliance, policy or copy rule inside a brief, and never spell out the vocabulary such a rule bans: a brief is customer-adjacent copy and is scanned exactly like a bullet, so a word you only mention in order to forbid it still lands in the listing.
- Overlays carry product facts only: no figures or symbols for cost, no rating or review marks, no promotional or urgency wording, no promise about outcomes or returns.

${videoBlock}
- "shots": the shot list. "onScreenText": every string that appears on screen, each one written to the same rules as a bullet.

Return JSON: { "imagePlan": [{ "slot": ${slots[0]?.slot ?? 1}, "purpose", "spec", "notes", "altText" }, ... one object for each of ${slotIds(arch)}], "videoBrief": { "aspect", "durationSeconds", "shots": [], "onScreenText": [], "notes" } }`;
}
