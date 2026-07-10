import type { ListingSnapshot } from '@/lib/types';

export function snapshotBlock(snapshot: ListingSnapshot): string {
  return `CURRENT LISTING (source data — improve, don't copy mistakes):
Title: ${snapshot.title}
Bullets:
${snapshot.bullets.map((b, i) => `${i + 1}. ${b}`).join('\n')}
Description: ${snapshot.description.slice(0, 1500)}
Category: ${snapshot.category}
Attributes: ${JSON.stringify(snapshot.attributes)}`;
}
