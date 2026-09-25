/**
 * Shared HTTP helpers for the API routes.
 *
 * CORS here is only about which browser origins may read the response. It is
 * deliberately not treated as an access control or rate limiting mechanism -
 * those are enforced separately, server-side, for every request.
 */

export const ALLOWED_ORIGINS = [
  "https://ahmedbahaj.github.io",
  "https://abdullah-t1d.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];

export function setCors(req, res, methods = "POST, OPTIONS") {
  const origin = req.headers?.origin;
  const allowOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : "https://ahmedbahaj.github.io";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Refresh-Token");
}

/** Best-effort client identity for rate limiting. */
export function clientKey(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "");
  const ip =
    forwarded.split(",")[0].trim() ||
    req.headers?.["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "unknown";
  return String(ip).slice(0, 64);
}

/** Reject oversized payloads before doing any work. */
export function bodyTooLarge(req, maxBytes) {
  const declared = Number(req.headers?.["content-length"] || 0);
  return Number.isFinite(declared) && declared > maxBytes;
}

/**
 * Vercel parses JSON bodies automatically, but be defensive: a string body can
 * arrive when the content type is unexpected.
 */
export function readJsonBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "object") return body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function parsePositiveInt(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return max === undefined ? n : Math.min(n, max);
}
