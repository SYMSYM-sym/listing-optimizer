/**
 * Isomorphic UTF-8 byte counter — used by the gate (server) and dashboard (client)
 * so backend byte limits always agree between the UI counter and C3.
 */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}
