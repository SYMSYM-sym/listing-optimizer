import 'server-only';

/**
 * Lightweight structured server logs — never log secrets or full generated copy.
 * Visible in Vercel Runtime Logs / hosting stdout.
 */
export function logServer(
  event: string,
  fields: Record<string, string | number | boolean | string[] | undefined | null> = {},
): void {
  const payload: Record<string, unknown> = { event, ts: new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) payload[k] = v;
  }
  // Single-line JSON so log aggregators can parse it.
  console.info(JSON.stringify(payload));
}
