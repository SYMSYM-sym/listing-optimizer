import 'server-only';
import { env } from '@/lib/env';

/**
 * Shared route guards: optional access token + per-IP rate limit.
 * The deployed URL spends real LLM/provider money — keep it guarded.
 */

const WINDOW_MS = 60_000;
const MAX_REQ_PER_WINDOW = 20;
const hits = new Map<string, number[]>();

export function checkAccess(req: Request): Response | null {
  const token = env.appAccessToken();
  if (token && req.headers.get('x-app-token') !== token) {
    return Response.json(
      { code: 'UNAUTHORIZED', message: 'Missing or invalid x-app-token header.' },
      { status: 401 },
    );
  }
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (arr.length > MAX_REQ_PER_WINDOW) {
    return Response.json(
      { code: 'RATE_LIMITED', message: 'Too many requests — slow down.' },
      { status: 429 },
    );
  }
  return null;
}
