/**
 * Shared-extraction store, backed by Supabase PostgREST.
 *
 * Dependency-free on purpose: it speaks HTTP to PostgREST with the service-role
 * key, which never leaves the Vercel function. If the environment variables are
 * absent the store reports itself as unconfigured and every caller degrades to
 * the original stateless extraction behaviour.
 *
 * All concurrency-sensitive operations go through Postgres functions
 * (see supabase/migrations) so they stay atomic across serverless instances.
 */

import { LIMITS } from "./spec.js";

export class StoreError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "StoreError";
    this.status = status;
  }
}

export function isConfigured(env = process.env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

function baseUrl(env) {
  return String(env.SUPABASE_URL).replace(/\/+$/, "");
}

/** Columns exposed to the public API. Never includes internal error details. */
export const PUBLIC_COLUMNS = [
  "id",
  "video_id",
  "canonical_url",
  "title",
  "channel",
  "duration_seconds",
  "thumbnail_url",
  "components",
  "component_count",
  "model",
  "spec_version",
  "publication_status",
  "extracted_at",
  "last_success_at"
].join(",");

async function request(env, path, { method = "GET", body, headers = {}, timeoutMs = LIMITS.storeTimeoutMs } = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl(env)}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!res.ok) {
      const message = data?.message || data?.error || `Database request failed (${res.status})`;
      throw new StoreError(message, res.status);
    }

    return data;
  } catch (e) {
    if (e instanceof StoreError) throw e;
    if (e?.name === "AbortError") throw new StoreError("Database request timed out", 504);
    throw new StoreError(e?.message || "Database request failed", 502);
  } finally {
    clearTimeout(timer);
  }
}

function rpc(env, fn, args, opts) {
  return request(env, `/rest/v1/rpc/${fn}`, { method: "POST", body: args, ...opts });
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** A reusable, successful extraction for this video id under this spec version. */
export async function findReady(env, videoId, specVersion) {
  const params = new URLSearchParams({
    select: PUBLIC_COLUMNS,
    video_id: `eq.${videoId}`,
    spec_version: `eq.${specVersion}`,
    status: "eq.ready",
    limit: "1"
  });

  const rows = await request(env, `/rest/v1/extractions?${params}`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/** A published entry, for the public library detail route. */
export async function findPublished(env, videoId) {
  const params = new URLSearchParams({
    select: PUBLIC_COLUMNS,
    video_id: `eq.${videoId}`,
    status: "eq.ready",
    publication_status: "eq.published",
    order: "last_success_at.desc",
    limit: "1"
  });

  const rows = await request(env, `/rest/v1/extractions?${params}`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Paginated public library listing.
 * `q` matches video title, channel, and component names, case-insensitively.
 */
export async function listPublished(env, { q = "", limit = 24, offset = 0 } = {}) {
  const params = new URLSearchParams({
    select: PUBLIC_COLUMNS,
    status: "eq.ready",
    publication_status: "eq.published",
    order: "last_success_at.desc",
    limit: String(limit),
    offset: String(offset)
  });

  const term = String(q || "").trim().toLowerCase();
  if (term) {
    // PostgREST treats "*" as the wildcard for ilike. Commas and parentheses
    // would break the filter grammar, so they are stripped.
    const safe = term.replace(/[,()*\\]/g, " ").replace(/\s+/g, " ").trim();
    if (safe) params.set("search_text", `ilike.*${safe}*`);
  }

  const rows = await request(env, `/rest/v1/extractions?${params}`);
  return Array.isArray(rows) ? rows : [];
}

/* ------------------------------------------------------------------ *
 * Writes (atomic, via Postgres functions)
 * ------------------------------------------------------------------ */

/**
 * Atomically claim the right to run an extraction.
 *
 * Returns one of:
 *   { outcome: 'claimed', row }    - caller must perform the extraction
 *   { outcome: 'ready', row }      - a reusable result already exists
 *   { outcome: 'processing', row } - another instance is working on it
 */
export async function claimExtraction(env, { videoId, specVersion, canonicalUrl, staleSeconds = 180, force = false }) {
  const rows = await rpc(env, "claim_extraction", {
    p_video_id: videoId,
    p_spec_version: specVersion,
    p_canonical_url: canonicalUrl,
    p_stale_seconds: staleSeconds,
    p_force: force
  });

  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) throw new StoreError("Claim returned no row", 500);

  return { outcome: row.claim_outcome, row: row.extraction || null };
}

/**
 * Persist a successful extraction. Always wins over a previous failure, and
 * refreshes last_success_at.
 */
export async function completeExtraction(env, payload) {
  const rows = await rpc(env, "complete_extraction", {
    p_video_id: payload.videoId,
    p_spec_version: payload.specVersion,
    p_canonical_url: payload.canonicalUrl,
    p_title: payload.title ?? null,
    p_channel: payload.channel ?? null,
    p_duration_seconds: payload.durationSeconds ?? null,
    p_thumbnail_url: payload.thumbnailUrl ?? null,
    p_components: payload.components,
    p_model: payload.model,
    p_source: payload.source,
    p_publication_status: payload.publicationStatus,
    p_review_reason: payload.reviewReason ?? null,
    p_search_text: payload.searchText
  });

  const row = Array.isArray(rows) ? rows[0] : rows;
  return row?.extraction || null;
}

/**
 * Record a failure. The SQL function refuses to downgrade a row that already
 * holds a successful result, so a failed re-extraction never destroys one.
 *
 * Returns { row, preserved } where `preserved` is true when an earlier
 * successful result was kept intact.
 */
export async function failExtraction(env, { videoId, specVersion, message }) {
  const rows = await rpc(env, "fail_extraction", {
    p_video_id: videoId,
    p_spec_version: specVersion,
    p_error: String(message || "Extraction failed").slice(0, 500)
  });

  const row = Array.isArray(rows) ? rows[0] : rows;
  return { row: row?.extraction || null, preserved: row?.preserved === true };
}

/**
 * Fixed-window rate limit, counted in Postgres so it holds across instances.
 * Returns true when the request is allowed.
 */
export async function checkRateLimit(env, { bucket, limit, windowSeconds }) {
  const rows = await rpc(env, "bump_rate_limit", {
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds
  });

  const row = Array.isArray(rows) ? rows[0] : rows;
  return row?.allowed !== false;
}
