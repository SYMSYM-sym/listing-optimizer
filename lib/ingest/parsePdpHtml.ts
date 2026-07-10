import 'server-only';
import * as cheerio from 'cheerio';
import type { RawAttribute, RawListing } from './providers/types';

/**
 * ONE deterministic PDP-HTML parser shared by the Firecrawl adapter and the
 * paste fallback (one parser, two transports). No LLM in the ingestion path.
 */
export function looksLikeHtml(input: string): boolean {
  const sample = input.slice(0, 5000);
  const tagCount = (sample.match(/<[a-zA-Z!/]/g) ?? []).length;
  return tagCount > 10;
}

export function parsePdpHtml(html: string, asin: string, url: string): RawListing {
  const $ = cheerio.load(html);

  const title = $('#productTitle').text().trim();

  const bullets: string[] = [];
  $('#feature-bullets li .a-list-item, #feature-bullets li span.a-list-item').each(
    (_, el) => {
      const t = $(el).text().trim();
      if (t && !/^›/.test(t)) bullets.push(t);
    },
  );

  const description =
    $('#productDescription').text().trim() ||
    $('#aplus_feature_div ~ #productDescription_feature_div').text().trim();

  const attributesRaw: RawAttribute[] = [];
  // Product information table
  $('#prodDetails table tr, #productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr').each(
    (_, el) => {
      const name = $(el).find('th').first().text().trim();
      const value = $(el).find('td').first().text().replace(/\s+/g, ' ').trim();
      if (name && value) attributesRaw.push({ name, value });
    },
  );
  // Detail bullets variant
  $('#detailBullets_feature_div li').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    const m = t.match(/^(.{2,60}?)\s*[:‏:]\s*(.+)$/);
    if (m?.[1] && m[2]) {
      attributesRaw.push({ name: m[1].replace(/[‎‏]/g, '').trim(), value: m[2].trim() });
    }
  });

  const images: string[] = [];
  const landing = $('#landingImage').attr('src') ?? $('#imgTagWrapperId img').attr('src');
  if (landing) images.push(landing);
  $('#altImages img').each((_, el) => {
    const src = $(el).attr('src');
    if (src && !/sprite|play-icon|video/.test(src)) images.push(src);
  });

  const categories: string[] = [];
  $('#wayfinding-breadcrumbs_feature_div a').each((_, el) => {
    const t = $(el).text().trim();
    if (t) categories.push(t);
  });

  const priceText =
    $('#corePrice_feature_div .a-offscreen').first().text().trim() ||
    $('span.a-price .a-offscreen').first().text().trim();

  const ratingText = $('#acrPopover').attr('title') ?? '';
  const ratingMatch = ratingText.match(/([\d.]+) out of 5/);

  const importantInformation = $('#important-information').text().replace(/\s+\n/g, '\n').trim();
  const aplusText = $('#aplus').text().replace(/\s+\n/g, '\n').trim();

  const brand =
    $('#bylineInfo').text().replace(/^(Visit the|Brand:)\s*/i, '').replace(/\s*Store$/i, '').trim() ||
    undefined;

  return {
    asin,
    url,
    title,
    bullets,
    description,
    images: [...new Set(images)],
    attributesRaw,
    price: priceText || undefined,
    rating: ratingMatch?.[1] ? Number.parseFloat(ratingMatch[1]) : undefined,
    categories,
    categoryIds: [],
    aplusText: aplusText || undefined,
    importantInformation: importantInformation || undefined,
    brand,
    raw: { source: 'html' },
  };
}
