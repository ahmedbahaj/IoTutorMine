/**
 * The single response shape used by every extraction endpoint, whether the
 * result came fresh from the model or from the shared cache. Keeping one shape
 * means the frontend stores and renders both paths identically.
 */

import { thumbnailUrl } from "./youtube.js";

export function fromRow(row, extra = {}) {
  if (!row) return null;

  return {
    sharedId: row.id ?? null,
    videoId: row.video_id ?? null,
    canonicalUrl: row.canonical_url ?? null,
    title: row.title ?? null,
    channel: row.channel ?? null,
    durationSeconds: row.duration_seconds ?? null,
    thumbnail: row.thumbnail_url ?? (row.video_id ? thumbnailUrl(row.video_id) : null),
    components: Array.isArray(row.components) ? row.components : [],
    componentCount: row.component_count ?? (Array.isArray(row.components) ? row.components.length : 0),
    model: row.model ?? null,
    specVersion: row.spec_version ?? null,
    published: row.publication_status === "published",
    extractedAt: row.extracted_at ?? row.last_success_at ?? null,
    source: "youtube-url",
    cached: true,
    ...extra
  };
}

export function fresh({
  videoId,
  canonicalUrl,
  title,
  channel,
  durationSeconds,
  thumbnail,
  components,
  model,
  specVersion,
  source,
  published,
  sharedId,
  reviewReason
}) {
  return {
    sharedId: sharedId ?? null,
    videoId: videoId ?? null,
    canonicalUrl: canonicalUrl ?? null,
    title: title ?? null,
    channel: channel ?? null,
    durationSeconds: durationSeconds ?? null,
    thumbnail: thumbnail ?? (videoId ? thumbnailUrl(videoId) : null),
    components: components || [],
    componentCount: (components || []).length,
    model: model ?? null,
    specVersion: specVersion ?? null,
    published: Boolean(published),
    reviewReason: reviewReason ?? null,
    extractedAt: new Date().toISOString(),
    source,
    cached: false
  };
}
