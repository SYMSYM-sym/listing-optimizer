import 'server-only';
import { env } from '@/lib/env';

/**
 * Shared route guards.
 *
 * `checkAccess` — OPTIONAL token + per-IP rate limit. Used by the action routes
 * (ingest/optimize/audit/regenerate) so local development without a token still
 * works; the deployed URL spends real LLM/provider money, so a configured token
 * is enforced.
 *
 * `requireAccess` — MANDATORY token. Used by the read-only HISTORY routes, which
 * serve full stored snapshots and generated copy. Those must FAIL CLOSED: if the
 * operator never configured APP_ACCESS_TOKEN, the data is not world-readable —
 * the route returns 401 instead of serving it.
 */

const WINDOW_MS = 60_000;
const MAX_REQ_PER_WINDOW = 20;
const hits = new Map<string, number[]>();

function unauthorized(message: string): Response {
  return Response.json({ code: 'UNAUTHORIZED', message }, { status: 401 });
}

function rateLimit(req: Request): Response | null {
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

/**
 * OPTIONAL-token guard: enforced when APP_ACCESS_TOKEN is configured, skipped
 * when it is not (so `npm run dev` works with no secrets).
 */
export function checkAccess(req: Request): Response | null {
  const token = env.appAccessToken();
  if (token && req.headers.get('x-app-token') !== token) {
    return unauthorized('Missing or invalid x-app-token header.');
  }
  return rateLimit(req);
}

/**
 * MANDATORY-token guard for the read-only history routes. Fails CLOSED when no
 * token is configured — an unset env var must never publish stored runs.
 */
export function requireAccess(req: Request): Response | null {
  const token = env.appAccessToken();
  if (!token) {
    return unauthorized(
      'History routes are disabled: APP_ACCESS_TOKEN is not configured on the server.',
    );
  }
  if (req.headers.get('x-app-token') !== token) {
    return unauthorized('Missing or invalid x-app-token header.');
  }
  return rateLimit(req);
}
