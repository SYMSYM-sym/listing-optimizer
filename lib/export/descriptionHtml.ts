/**
 * Seller Central description formatting.
 *
 * Amazon's product description field accepts ONLY the `<br>` line-break tag.
 * Every other HTML element (<p>, <b>, <ul>, <strong>, ...) has been deprecated
 * since July 2021 and can either render as raw text or get the listing
 * suppressed. The canonical `description` we generate and gate is therefore
 * PLAIN TEXT with real paragraph breaks; this helper produces the paste-ready
 * variant for the Seller Central textarea.
 *
 * Pure and lossless: it inserts line-break tags and NOTHING else — no escaping,
 * no wrapping tags, no entity substitution. Round-tripping the output through
 * the browser therefore reproduces the source text exactly.
 */

/** A blank line (optionally whitespace-filled) separating two paragraphs. */
const PARAGRAPH_BREAK = /\n[ \t]*\n+/g;

export function toSellerCentralDescription(text: string): string {
  if (!text) return '';
  return text
    .replace(/\r\n?/g, '\n') // normalise CRLF/CR so line handling is uniform
    .trim()
    .replace(PARAGRAPH_BREAK, '<br><br>') // blank line => paragraph gap
    .replace(/\n/g, '<br>'); // remaining single newline => single break
}
