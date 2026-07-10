import { NextResponse } from 'next/server';
import { parseAsin } from '@/lib/ingest/parseAsin';
import { ingestByAsin } from '@/lib/ingest';
import { fromManualFields, fromPastedHtml, PasteError, type ManualFields } from '@/lib/ingest/paste';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { ProviderError } from '@/lib/ingest/providers/types';
import { checkAccess } from '@/lib/server/guard';
import { env } from '@/lib/env';
import type { IngestError } from '@/lib/types';

export const maxDuration = 300;

interface IngestBody {
  url?: string;
  pasteHtml?: string;
  manualFields?: ManualFields;
}

function err(e: IngestError, status: number): NextResponse {
  return NextResponse.json(e, { status });
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = checkAccess(req);
  if (denied) return denied as NextResponse;

  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    return err({ code: 'INVALID_URL', message: 'Body must be JSON.', suggestPaste: false }, 400);
  }

  const asin = body.url ? parseAsin(body.url) : null;
  if (!asin && !body.manualFields) {
    return err(
      { code: 'INVALID_URL', message: 'Could not find an ASIN in that URL.', suggestPaste: false },
      400,
    );
  }

  try {
    // Paste modes take precedence when provided (or when provider=paste).
    if (body.pasteHtml) {
      const raw = fromPastedHtml(body.pasteHtml, asin ?? 'PASTED0000');
      return NextResponse.json(toSnapshot(raw));
    }
    if (body.manualFields) {
      const raw = fromManualFields(body.manualFields, asin ?? 'MANUAL0000');
      return NextResponse.json(toSnapshot(raw));
    }
    if (env.ingestProvider() === 'paste') {
      return err(
        {
          code: 'PROVIDER_ERROR',
          message: 'INGEST_PROVIDER=paste — paste the page HTML or fill the manual fields.',
          suggestPaste: true,
        },
        400,
      );
    }
    const snapshot = await ingestByAsin(asin as string);
    return NextResponse.json(snapshot);
  } catch (e) {
    if (e instanceof PasteError) {
      return err({ code: e.code, message: e.message, suggestPaste: true }, 422);
    }
    if (e instanceof ProviderError) {
      const status =
        e.code === 'ASIN_NOT_FOUND' ? 404 : e.code === 'RATE_LIMITED' ? 429 : 502;
      return err(
        { code: e.code, message: e.message, suggestPaste: e.code === 'PROVIDER_BLOCKED' },
        status,
      );
    }
    return err(
      { code: 'PROVIDER_ERROR', message: 'Unexpected ingestion failure.', suggestPaste: true },
      502,
    );
  }
}
