import type { Facts, KnowledgePack, ListingSnapshot } from '@/lib/types';

/**
 * Prompt templates — small, rule-injected from the pack (never hard-coded
 * category prose). The shared system preamble is identical across groups so
 * it prompt-caches. The verbatim disclaimer is inserted by CODE at assembly,
 * so prompts instruct the model to leave it out.
 */

export function buildSystemPrompt(pack: KnowledgePack, facts: Facts): string {
  const r = pack.rules;
  const cp = pack.compliancePack;
  const compliance = cp
    ? `
COMPLIANCE (structure/function claims ONLY — this is load-bearing):
- NEVER claim to diagnose, treat, cure, prevent, or mitigate any disease or symptom.
- Banned verbs as product claims: ${cp.diseaseVerbs.join(', ')}.
- NEVER use disease/condition nouns anywhere (examples: ${cp.coreDiseaseNouns.slice(0, 12).join(', ')}, and any condition name). Reframe as a structure/function state ("supports healthy [system] function", "[parameter] balance").
- Banned marketing phrases: ${cp.superlativeBans.join(', ')}. No star-rating or review-count claims. No price in copy.
- Do NOT write the FDA disclaimer anywhere — the system inserts the verbatim constant itself. Claim-bearing bullets end with a trailing "*" marker only.
- If an allergen is present, declare it exactly as "Contains: [Allergen]" consistently; never write "No Known Allergens" when one is present.`
    : `
No category compliance module is active. Write factual, non-medical copy. No superlatives, no price, no review claims.`;

  return `You are an Amazon listing copy engine. You write ONE JSON object per request, matching the requested schema exactly. No prose outside JSON.

HARD LIMITS (checked by deterministic code — leave headroom):
- Legacy title ≤${r.titleMaxLegacy} chars. New title ≤${r.title75Max} chars (policy eff. Jul 27 2026). Item Highlights ≤${r.itemHighlightsMax} chars.
- Exactly ${r.bulletCount} bullets, each ≤${r.bulletMax} chars.
- Description ≤${r.descriptionMax} chars (leave ~250 chars headroom — the system appends the FDA disclaimer).
- Backend search terms ≤${r.backendMaxBytes} UTF-8 BYTES, lowercase, space-separated, no punctuation.
- No word more than 2× in the title. Banned title chars: ! $ ? _ { } ^ ¬ ¦ (use hyphen/comma/&/parentheses).

CANONICAL FACTS (every number you write MUST match these exactly; if a fact is absent, do not invent one):
${JSON.stringify(facts, null, 2)}
- Potency figures attach to the blend/formula, NEVER phrased "per serving".
${compliance}

STYLE:
- Product name comes FIRST in both titles; the primary keyword immediately after it (never displace the name).
- Write for buyer situations; one distinct, quotable situational anchor per major use-case.
- Include comparative framing (vs typical alternatives) and who-it's-for, phrased compliantly.
- Backend terms: only synonyms/misspellings/other-language variants that appear NOWHERE in visible copy; never repeat title words; no brand names, no ASINs.`;
}

function snapshotBlock(snapshot: ListingSnapshot): string {
  return `CURRENT LISTING (source data — improve, don't copy mistakes):
Title: ${snapshot.title}
Bullets:
${snapshot.bullets.map((b, i) => `${i + 1}. ${b}`).join('\n')}
Description: ${snapshot.description.slice(0, 1500)}
Category: ${snapshot.category}
Attributes: ${JSON.stringify(snapshot.attributes)}`;
}

export const groupPrompts = {
  title: (s: ListingSnapshot): string => `${snapshotBlock(s)}

TASK: Generate the title group.
- "productName": the customer-facing product name (not the backend brand string if it differs).
- "primaryKeyword": the single category-defining term you are front-loading.
- "title": legacy ≤200 chars. Product name first, then primary keyword, then supporting terms. No word >2×.
- "title75": ≤75 chars. Product name first + the single highest-value keyword cluster. Ruthlessly prioritized.
- "itemHighlights": ≤125 chars, searchable. Every important term that no longer fits title75 (audience qualifiers, form/count/diet tags). Do NOT duplicate title75 words.
Return JSON: { "productName", "primaryKeyword", "title", "title75", "itemHighlights" }`,

  bullets: (s: ListingSnapshot): string => `${snapshotBlock(s)}

TASK: Write exactly 5 bullets, each ≤240 chars (leave headroom to 255).
- Each bullet serves ONE major use-case with a distinct, quotable situational anchor line.
- Lead each bullet with a SHORT ALL-CAPS HOOK followed by a colon.
- One bullet must declare the allergen ("Contains: ...") if any allergen is present in the ingredients; if none, one bullet covers quality/testing signals instead.
- Claim-bearing bullets end with "*" (no disclaimer text in bullets — the system handles it).
- "useCaseAnchor": 2–5 word label of the use-case the bullet anchors.
Return JSON: { "bullets": [{ "text", "useCaseAnchor", "claimBearing" } ×5] }`,

  description: (s: ListingSnapshot): string => `${snapshotBlock(s)}

TASK: Write the product description, ≤1700 chars (the system appends the verbatim FDA disclaimer and needs the headroom).
- Product name must appear.
- Blank-line paragraph breaks. Plain text, no HTML.
- Cover: what it is, who it's for, how to use, quality/safety (including "Contains: [Allergen]" if applicable and a short safety note: pregnancy/nursing/physician consult/keep from children).
- End claim paragraphs naturally; do NOT write any FDA disclaimer text.
Return JSON: { "description" }`,

  backend: (s: ListingSnapshot): string => `${snapshotBlock(s)}

TASK: Backend search terms, ≤230 UTF-8 bytes (headroom to 249).
- ONLY synonyms, common misspellings, and other-language (e.g. Spanish) variants NOT present in the title, highlights, or bullets you'd expect for this product.
- Lowercase, space-separated single words or short phrases, no punctuation, no repeats of any title word, no brand names, no ASINs, no disease terms.
Return JSON: { "backendSearchTerms" }`,

  attributes: (s: ListingSnapshot, schemaFields: string): string => `${snapshotBlock(s)}

TASK: Fill the structured attribute set (underscore_case keys) using ONLY facts derivable from the current listing data. Schema (field | required | example):
${schemaFields}
- Fill every applicable field; prioritize filter-facet fields.
- "active_ingredients" must be a subset of "ingredients" (actives only; full label list in ingredients).
- "allergen_information": exact canonical string if an allergen is present, else "Free from major allergens per label" ONLY if the label says so, else omit.
- "recommended_browse_nodes": suggest the tightest plausible node id from the category path (it is a suggestion for operator confirmation).
- "legal_disclaimer_description": write the literal string "[SYSTEM_DISCLAIMER]" — the system replaces it.
Return JSON: { "attributes": { field: value, ... } }`,

  aplus: (s: ListingSnapshot): string => `${snapshotBlock(s)}

TASK: A+ content — real extractable text (AI/voice engines read it).
- 5–7 modules including: id "brand-story" (brand story; product name must appear), id "hero" (hero module; product name must appear), an ingredients/feature module (declare "Contains: [Allergen]" here if applicable), a how-to-use module, and a who-it's-for module.
- "comparison": ≥3 rows framing ours vs a typical alternative, compliant and factual (no competitor names, no superlatives).
- "faq": 5–10 Q&A pairs mirroring the same facts as the bullets.
- Mark "claimBearing": true on any module/answer making a benefit claim; do NOT write disclaimer text (system appends it).
- No price, no "buy now"/"subscribe & save", no urgency, no guarantees, no review claims.
Return JSON: { "modules": [...], "comparison": { "rows": [...] }, "faq": [...] }`,

  images: (s: ListingSnapshot): string => `${snapshotBlock(s)}

TASK: A 7-slot image/creative plan.
Slots: (1) main image on pure white RGB 255/255/255, product ≥85% of frame, longest side ≥1000px; (2) value-prop infographic; (3) REAL PHOTOGRAPH of any regulated panel (e.g. Supplement Facts) — never AI-generated or altered; (4) ingredient/feature story; (5) how-to-use routine; (6) trust/heritage (substantiated signals only); (7) lifestyle/outcome.
- "spec": concrete requirements per slot. "notes": copy/layout guidance. No price, ratings, guarantees, or promotional CTAs on any image.
Return JSON: { "imagePlan": [{ "slot", "purpose", "spec", "notes" } ×7] }`,

  qa: (s: ListingSnapshot): string => `${snapshotBlock(s)}

TASK: 12–18 accurate Q&A pairs seeding the AI-answer layer.
- Mirror EXACTLY the same facts as the bullets and A+ FAQ (counts, potency, serving size — from the canonical facts).
- Cover: usage, timing, who it's for, dietary/allergen, storage, what makes it different, results expectations (compliant phrasing).
- Mark "claimBearing": true on benefit-claim answers; do NOT write disclaimer text (system appends it).
Return JSON: { "qa": [{ "q", "a", "claimBearing" }] }`,
};
