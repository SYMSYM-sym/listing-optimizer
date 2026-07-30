-- Run-history table for the Listing Optimizer.
-- Every /api/optimize run is persisted here (input snapshot + generated listing + audit)
-- so the History dashboard can reopen past runs and copy any section.
--
-- SECURITY: RLS is enabled with NO policies. The anon/publishable key therefore has
-- zero access. The app reads/writes exclusively server-side with the service_role key
-- (which bypasses RLS) behind the x-app-token guard — the browser never talks to
-- Supabase directly.

create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  asin text,
  url text,
  product_name text,
  pack_id text,
  verified boolean,
  score integer,
  gaps integer,
  failure_ids text[],
  snapshot jsonb,
  optimized jsonb,
  audit jsonb
);

create index if not exists runs_created_at_idx on public.runs (created_at desc);
create index if not exists runs_asin_idx on public.runs (asin);

alter table public.runs enable row level security;
