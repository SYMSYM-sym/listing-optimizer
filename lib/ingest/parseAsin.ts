/**
 * Extract an ASIN from the many shapes of Amazon URLs, or accept a bare ASIN.
 * Returns null when no plausible ASIN is found.
 */

const ASIN_RE = /^[A-Z0-9]{10}$/;

function isAsin(s: string): boolean {
  return ASIN_RE.test(s.toUpperCase()) && /\d/.test(s);
}

export function parseAsin(input: string): string | null {
  const trimmed = input.trim();

  // Bare 10-char ASIN
  if (isAsin(trimmed)) return trimmed.toUpperCase();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!/(^|\.)amazon\.[a-z.]{2,10}$/i.test(url.hostname) && !/^amzn\.(to|com)$/i.test(url.hostname)) {
    // Still allow any host — some sellers use proxies — but only via path patterns below.
  }

  const path = decodeURIComponent(url.pathname);

  // /dp/ASIN, /dp/ASIN/ref=..., /<anything>/dp/ASIN
  // /gp/product/ASIN, /gp/aw/d/ASIN, /product/ASIN, /ASIN/ (rare)
  const patterns = [
    /\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/gp\/product\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/gp\/aw\/d\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/product\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/exec\/obidos\/asin\/([A-Z0-9]{10})(?:[/?]|$)/i,
  ];
  for (const re of patterns) {
    const m = path.match(re);
    if (m?.[1] && isAsin(m[1])) return m[1].toUpperCase();
  }

  // ?asin=XXXXXXXXXX (also &asin=)
  const qp = url.searchParams.get('asin');
  if (qp && isAsin(qp)) return qp.toUpperCase();

  return null;
}
