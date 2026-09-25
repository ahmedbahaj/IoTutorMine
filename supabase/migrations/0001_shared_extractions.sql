-- IoTutorMine shared extraction library
--
-- Run this once against the Supabase project (SQL Editor, or `supabase db push`).
-- It is idempotent and safe to re-run.
--
-- Design notes:
--  * Row Level Security is enabled with NO policies. The anon and authenticated
--    keys therefore have no access at all. Only the service-role key, which
--    lives exclusively in Vercel environment variables, can read or write.
--  * Every concurrency-sensitive operation is a Postgres function so it stays
--    atomic across independent serverless instances. No in-memory locking.
--  * A successful result is never downgraded by a later failure.

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- extractions
-- ---------------------------------------------------------------------------

create table if not exists public.extractions (
  id                  uuid primary key default gen_random_uuid(),

  -- identity
  video_id            text not null,
  spec_version        text not null,
  canonical_url       text not null,

  -- video metadata (null when YouTube did not supply it; never invented)
  title               text,
  channel             text,
  duration_seconds    integer,
  thumbnail_url       text,

  -- extraction result
  components          jsonb not null default '[]'::jsonb,
  component_count     integer not null default 0,
  model               text,
  source              text,

  -- lifecycle
  status              text not null default 'processing'
                        check (status in ('processing', 'ready', 'failed')),
  publication_status  text not null default 'pending'
                        check (publication_status in ('pending', 'published', 'rejected', 'hidden')),
  review_reason       text,
  error_message       text,

  -- worker lease for cross-instance de-duplication
  lock_until          timestamptz,

  -- search haystack: title + channel + component names, lowercased
  search_text         text not null default '',

  extracted_at        timestamptz,
  last_success_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint extractions_video_id_format check (video_id ~ '^[A-Za-z0-9_-]{11}$')
);

-- One row per video per extraction specification. Changing the prompt or model
-- means bumping spec_version, which keeps incompatible results separate rather
-- than silently mixing them.
create unique index if not exists extractions_video_spec_uniq
  on public.extractions (video_id, spec_version);

create index if not exists extractions_public_listing_idx
  on public.extractions (last_success_at desc)
  where status = 'ready' and publication_status = 'published';

create index if not exists extractions_search_trgm_idx
  on public.extractions using gin (search_text gin_trgm_ops);

alter table public.extractions enable row level security;
-- Intentionally no policies: anon/authenticated have zero access.

-- ---------------------------------------------------------------------------
-- rate_limits (fixed window, shared across serverless instances)
-- ---------------------------------------------------------------------------

create table if not exists public.rate_limits (
  bucket        text        not null,
  window_start  timestamptz not null,
  count         integer     not null default 0,
  primary key (bucket, window_start)
);

alter table public.rate_limits enable row level security;

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists extractions_touch_updated_at on public.extractions;
create trigger extractions_touch_updated_at
  before update on public.extractions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Public projection: the exact column set the API is allowed to return.
-- ---------------------------------------------------------------------------

create or replace function public.extraction_public_json(r public.extractions)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id',                 r.id,
    'video_id',           r.video_id,
    'canonical_url',      r.canonical_url,
    'title',              r.title,
    'channel',            r.channel,
    'duration_seconds',   r.duration_seconds,
    'thumbnail_url',      r.thumbnail_url,
    'components',         r.components,
    'component_count',    r.component_count,
    'model',              r.model,
    'spec_version',       r.spec_version,
    'publication_status', r.publication_status,
    'extracted_at',       r.extracted_at,
    'last_success_at',    r.last_success_at
  );
$$;

-- ---------------------------------------------------------------------------
-- claim_extraction: atomic "may I run the model for this video?"
-- ---------------------------------------------------------------------------
--
-- Outcomes:
--   'ready'      a reusable successful result exists (serve it, do not call the model)
--   'processing' another instance holds a live lease (wait for it)
--   'claimed'    caller owns the lease and must perform the extraction
--
-- A forced refresh takes the lease but deliberately leaves status = 'ready' and
-- the existing components in place, so concurrent readers keep being served the
-- previous successful result while the refresh runs.

create or replace function public.claim_extraction(
  p_video_id      text,
  p_spec_version  text,
  p_canonical_url text,
  p_stale_seconds integer default 180,
  p_force         boolean default false
)
returns table (claim_outcome text, extraction jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.extractions;
begin
  -- Fast path: create the row and take the lease in one atomic statement.
  insert into public.extractions (
    video_id, spec_version, canonical_url, status, lock_until
  )
  values (
    p_video_id, p_spec_version, p_canonical_url, 'processing',
    now() + make_interval(secs => p_stale_seconds)
  )
  on conflict (video_id, spec_version) do nothing
  returning * into r;

  if found then
    return query select 'claimed'::text, public.extraction_public_json(r);
    return;
  end if;

  -- Row already exists. Serialise on it.
  select * into r
  from public.extractions
  where video_id = p_video_id and spec_version = p_spec_version
  for update;

  if not p_force and r.status = 'ready' then
    return query select 'ready'::text, public.extraction_public_json(r);
    return;
  end if;

  if r.lock_until is not null and r.lock_until > now() then
    return query select 'processing'::text, public.extraction_public_json(r);
    return;
  end if;

  -- Lease is free (new, failed, or abandoned/expired). Take it.
  -- Note: status is only moved to 'processing' when there is no prior success
  -- to protect.
  update public.extractions
  set lock_until = now() + make_interval(secs => p_stale_seconds),
      status     = case when r.status = 'ready' then 'ready' else 'processing' end
  where id = r.id
  returning * into r;

  return query select 'claimed'::text, public.extraction_public_json(r);
end;
$$;

-- ---------------------------------------------------------------------------
-- complete_extraction: persist a successful result
-- ---------------------------------------------------------------------------

create or replace function public.complete_extraction(
  p_video_id           text,
  p_spec_version       text,
  p_canonical_url      text,
  p_title              text,
  p_channel            text,
  p_duration_seconds   integer,
  p_thumbnail_url      text,
  p_components         jsonb,
  p_model              text,
  p_source             text,
  p_publication_status text,
  p_review_reason      text,
  p_search_text        text
)
returns table (extraction jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.extractions;
begin
  insert into public.extractions (
    video_id, spec_version, canonical_url, title, channel, duration_seconds,
    thumbnail_url, components, component_count, model, source, status,
    publication_status, review_reason, error_message, lock_until, search_text,
    extracted_at, last_success_at
  )
  values (
    p_video_id, p_spec_version, p_canonical_url, p_title, p_channel, p_duration_seconds,
    p_thumbnail_url, coalesce(p_components, '[]'::jsonb), jsonb_array_length(coalesce(p_components, '[]'::jsonb)),
    p_model, p_source, 'ready',
    p_publication_status, p_review_reason, null, null, coalesce(p_search_text, ''),
    now(), now()
  )
  on conflict (video_id, spec_version) do update
  set title              = coalesce(excluded.title, public.extractions.title),
      channel            = coalesce(excluded.channel, public.extractions.channel),
      duration_seconds   = coalesce(excluded.duration_seconds, public.extractions.duration_seconds),
      thumbnail_url      = coalesce(excluded.thumbnail_url, public.extractions.thumbnail_url),
      canonical_url      = excluded.canonical_url,
      components         = excluded.components,
      component_count    = excluded.component_count,
      model              = excluded.model,
      source             = excluded.source,
      status             = 'ready',
      -- A moderator decision to hide or reject an entry is sticky; an automated
      -- refresh must not quietly re-publish it.
      publication_status = case
                             when public.extractions.publication_status in ('hidden', 'rejected')
                               then public.extractions.publication_status
                             else excluded.publication_status
                           end,
      review_reason      = excluded.review_reason,
      error_message      = null,
      lock_until         = null,
      search_text        = excluded.search_text,
      extracted_at       = excluded.extracted_at,
      last_success_at    = excluded.last_success_at
  returning * into r;

  return query select public.extraction_public_json(r);
end;
$$;

-- ---------------------------------------------------------------------------
-- fail_extraction: record a failure without destroying a prior success
-- ---------------------------------------------------------------------------

create or replace function public.fail_extraction(
  p_video_id     text,
  p_spec_version text,
  p_error        text
)
returns table (extraction jsonb, preserved boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.extractions;
  was_ready boolean;
begin
  select (status = 'ready') into was_ready
  from public.extractions
  where video_id = p_video_id and spec_version = p_spec_version
  for update;

  if was_ready is null then
    return;
  end if;

  update public.extractions
  set lock_until    = null,
      -- Only downgrade when there is no successful result to protect.
      status        = case when was_ready then 'ready' else 'failed' end,
      error_message = p_error
  where video_id = p_video_id and spec_version = p_spec_version
  returning * into r;

  return query select public.extraction_public_json(r), was_ready;
end;
$$;

-- ---------------------------------------------------------------------------
-- bump_rate_limit: atomic fixed-window counter
-- ---------------------------------------------------------------------------

create or replace function public.bump_rate_limit(
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer
)
returns table (allowed boolean, hits integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  w timestamptz;
  c integer;
begin
  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limits (bucket, window_start, count)
  values (p_bucket, w, 1)
  on conflict (bucket, window_start) do update
    set count = public.rate_limits.count + 1
  returning count into c;

  -- Opportunistic cleanup of old windows.
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;

  return query select (c <= p_limit), c;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock down function execution. Only the service role may call these.
-- ---------------------------------------------------------------------------

revoke all on function public.claim_extraction(text, text, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.complete_extraction(text, text, text, text, text, integer, text, jsonb, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.fail_extraction(text, text, text) from public, anon, authenticated;
revoke all on function public.bump_rate_limit(text, integer, integer) from public, anon, authenticated;

grant execute on function public.claim_extraction(text, text, text, integer, boolean) to service_role;
grant execute on function public.complete_extraction(text, text, text, text, text, integer, text, jsonb, text, text, text, text, text) to service_role;
grant execute on function public.fail_extraction(text, text, text) to service_role;
grant execute on function public.bump_rate_limit(text, integer, integer) to service_role;
