'use client';

/**
 * CLIENT-SIDE ship-sheet fetch.
 *
 * The sheet is generated SERVER-SIDE (`GET /api/runs/[id]/ship-sheet`) behind
 * the mandatory-token guard, so it cannot be reached with a plain link: an
 * `<a href>` or `window.open` sends no `x-app-token` header and would render a
 * 401 JSON body in a new tab. Both entry points therefore fetch the HTML with
 * the same headers every other history call uses and hand the browser a blob.
 *
 * Two verbs, one fetch:
 *  - `open`     — new tab, for working next to Seller Central;
 *  - `download` — a file, for archiving next to the run.
 */

async function fetchSheet(runId: string, headers: HeadersInit): Promise<Blob> {
  const res = await fetch(`/api/runs/${runId}/ship-sheet`, { headers });
  if (!res.ok) {
    let message = `Ship sheet failed (${res.status})`;
    try {
      const body = (await res.json()) as { code?: string; message?: string };
      message = `${body.code ?? 'ERROR'}: ${body.message ?? message}`;
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new Error(message);
  }
  return new Blob([await res.text()], { type: 'text/html;charset=utf-8' });
}

export async function openShipSheet(runId: string, headers: HeadersInit): Promise<void> {
  const url = URL.createObjectURL(await fetchSheet(runId, headers));
  window.open(url, '_blank', 'noopener,noreferrer');
  // The tab keeps its own reference to the blob; revoke late so the open wins.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadShipSheet(
  runId: string,
  headers: HeadersInit,
  filenameStem: string,
): Promise<void> {
  const url = URL.createObjectURL(await fetchSheet(runId, headers));
  const a = document.createElement('a');
  a.href = url;
  a.download = `ship-sheet-${filenameStem.replace(/\W+/g, '-').toLowerCase() || 'listing'}.html`;
  a.click();
  URL.revokeObjectURL(url);
}
