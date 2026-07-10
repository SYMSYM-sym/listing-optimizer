import { describe, expect, it } from 'vitest';
import { parseAsin } from '@/lib/ingest/parseAsin';

const ASIN = 'B01N5IB20Q';

describe('parseAsin', () => {
  const good: [string, string][] = [
    [`https://www.amazon.com/dp/${ASIN}`, ASIN],
    [`https://www.amazon.com/dp/${ASIN}/ref=sr_1_1?keywords=probiotic&qid=1`, ASIN],
    [`https://www.amazon.com/Some-Product-Name/dp/${ASIN}?th=1`, ASIN],
    [`https://www.amazon.com/gp/product/${ASIN}`, ASIN],
    [`https://www.amazon.com/gp/aw/d/${ASIN}`, ASIN],
    [`https://www.amazon.co.uk/dp/${ASIN}/`, ASIN],
    [`https://www.amazon.com/product/${ASIN}`, ASIN],
    [`https://www.amazon.com/gp/offer-listing?asin=${ASIN}&condition=new`, ASIN],
    [`https://www.amazon.com/exec/obidos/asin/${ASIN}/`, ASIN],
    [ASIN, ASIN],
    [` ${ASIN.toLowerCase()} `, ASIN],
  ];
  it.each(good)('parses %s', (input, expected) => {
    expect(parseAsin(input)).toBe(expected);
  });

  const bad = [
    'https://www.amazon.com/',
    'https://www.amazon.com/dp/SHORT',
    'not a url at all',
    'https://example.com/dp/', 
    'ABCDEFGHIJ', // 10 chars but no digit — not a plausible ASIN
  ];
  it.each(bad)('rejects %s', (input) => {
    expect(parseAsin(input)).toBeNull();
  });
});
