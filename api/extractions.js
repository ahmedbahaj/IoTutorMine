/**
 * GET /api/extractions            -> paginated public library
 *   ?q=dht11      case-insensitive match on title, channel, and component names
 *   ?limit=24     max 48
 *   ?offset=0
 *
 * GET /api/extractions?videoId=XXXXXXXXXXX  -> a single published entry
 * GET /api/extractions?videoIds=a,b,c        -> published entries for those ids,
 *                                               used to resolve the active result
 *                                               for the catalog in one request
 *
 * Read-only and public. Only published, successful rows are exposed, projected
 * through a fixed column list - internal error text, lease state, and review
 * reasons never leave the server.
 */

import * as store from "./_lib/store.js";
import { fromRow } from "./_lib/shape.js";
import { clientKey, parsePositiveInt, setCors } from "./_lib/http.js";
import { isValidVideoId } from "./_lib/youtube.js";
import { SPEC_VERSION } from "./_lib/spec.js";

const MAX_LIMIT = 48;
const DEFAULT_LIMIT = 24;
const MAX_QUERY_LENGTH = 100;
/** Enough for the whole research catalog in one call, and bounded. */
const MAX_BATCH_IDS = 50;

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const env = process.env;

  if (!store.isConfigured(env)) {
    return res.status(503).json({
      error: "The shared extraction library is not configured yet.",
      configured: false,
      items: [],
      hasMore: false
    });
  }

  const ip = clientKey(req);
  try {
    const allowed = await store.checkRateLimit(env, {
      bucket: `browse:${ip}`,
      limit: 120,
      windowSeconds: 60
    });
    if (!allowed) return res.status(429).json({ error: "Too many requests. Please slow down." });
  } catch {
    // A rate-limiter outage must not break public browsing.
  }

  const query = req.query || {};
  const videoId = typeof query.videoId === "string" ? query.videoId : "";
  const videoIds = typeof query.videoIds === "string" ? query.videoIds : "";

  try {
    // ---- batch lookup --------------------------------------------------
    if (videoIds) {
      const ids = [...new Set(videoIds.split(",").map(s => s.trim()).filter(Boolean))]
        .slice(0, MAX_BATCH_IDS);

      const invalid = ids.filter(id => !isValidVideoId(id));
      if (invalid.length) {
        return res.status(400).json({ error: "One or more video ids are invalid." });
      }

      const rows = await store.listPublishedByIds(env, ids, SPEC_VERSION);
      return res.status(200).json({
        configured: true,
        specVersion: SPEC_VERSION,
        items: rows.map(row => fromRow(row))
      });
    }

    // ---- single entry --------------------------------------------------
    if (videoId) {
      if (!isValidVideoId(videoId)) {
        return res.status(400).json({ error: "Invalid video id." });
      }

      const row = await store.findPublished(env, videoId, SPEC_VERSION);
      if (!row) return res.status(404).json({ error: "No published extraction for this video." });

      return res.status(200).json({ configured: true, item: fromRow(row) });
    }

    // ---- listing -------------------------------------------------------
    const limit = Math.max(1, parsePositiveInt(query.limit, DEFAULT_LIMIT, MAX_LIMIT));
    const offset = parsePositiveInt(query.offset, 0, 5000);
    const q = String(query.q || "").slice(0, MAX_QUERY_LENGTH);

    // Fetch one extra row to determine whether another page exists, without
    // paying for an exact count over the whole table.
    const rows = await store.listPublished(env, {
      q,
      limit: limit + 1,
      offset,
      specVersion: SPEC_VERSION
    });
    const hasMore = rows.length > limit;

    return res.status(200).json({
      configured: true,
      items: rows.slice(0, limit).map(row => fromRow(row)),
      limit,
      offset,
      hasMore
    });
  } catch (e) {
    return res.status(502).json({ error: "The shared extraction library is temporarily unavailable." });
  }
}
