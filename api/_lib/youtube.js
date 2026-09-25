/**
 * Safe YouTube URL handling.
 *
 * The backend never fetches a user-supplied URL directly. A request is reduced
 * to a canonical 11-character video id, and every outbound request is built
 * from that id against a hard-coded host. This keeps user input out of the
 * fetch destination and avoids SSRF.
 */

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "www.youtu.be"
]);

const PATH_PREFIXES = ["shorts", "embed", "live", "v"];

export const MAX_URL_LENGTH = 2048;

export function isValidVideoId(id) {
  return typeof id === "string" && VIDEO_ID_RE.test(id);
}

/**
 * Parse any supported YouTube URL shape into a canonical video id.
 * Returns null for anything unsupported, malformed, or off-domain.
 */
export function parseVideoId(input) {
  if (typeof input !== "string") return null;

  const raw = input.trim();
  if (!raw || raw.length > MAX_URL_LENGTH) return null;

  // A bare video id is accepted as-is.
  if (VIDEO_ID_RE.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return null;

  const segments = url.pathname.split("/").filter(Boolean);

  // youtu.be/<id>
  if (host === "youtu.be" || host === "www.youtu.be") {
    return isValidVideoId(segments[0]) ? segments[0] : null;
  }

  // youtube.com/watch?v=<id>
  if (segments[0] === "watch") {
    const v = url.searchParams.get("v");
    return isValidVideoId(v) ? v : null;
  }

  // youtube.com/{shorts,embed,live,v}/<id>
  if (PATH_PREFIXES.includes(segments[0])) {
    return isValidVideoId(segments[1]) ? segments[1] : null;
  }

  // Some share links carry ?v= on an unusual path.
  const v = url.searchParams.get("v");
  return isValidVideoId(v) ? v : null;
}

export function canonicalUrl(videoId) {
  if (!isValidVideoId(videoId)) return null;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function thumbnailUrl(videoId) {
  if (!isValidVideoId(videoId)) return null;
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

/**
 * Best-effort metadata via YouTube's public oEmbed endpoint.
 *
 * Returns { available: boolean, title, author, thumbnail }.
 * `available: false` means the video is deleted, private, or region blocked.
 * Missing fields stay null - nothing is invented.
 */
export async function fetchOEmbedMetadata(videoId, fetchImpl = fetch) {
  if (!isValidVideoId(videoId)) {
    return { available: false, reason: "invalid-id", title: null, author: null, thumbnail: null };
  }

  const target = canonicalUrl(videoId);
  const endpoint =
    `https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`;

  try {
    const res = await fetchImpl(endpoint, { headers: { Accept: "application/json" } });

    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return { available: false, reason: "unavailable", title: null, author: null, thumbnail: null };
    }
    if (!res.ok) {
      return { available: null, reason: "metadata-unreachable", title: null, author: null, thumbnail: null };
    }

    const data = await res.json();
    return {
      available: true,
      reason: null,
      title: typeof data?.title === "string" ? data.title : null,
      author: typeof data?.author_name === "string" ? data.author_name : null,
      thumbnail: typeof data?.thumbnail_url === "string" ? data.thumbnail_url : null
    };
  } catch {
    // Network failure is not proof the video is gone.
    return { available: null, reason: "metadata-unreachable", title: null, author: null, thumbnail: null };
  }
}

/** Pull "lengthSeconds" out of an already-fetched watch page. Null when absent. */
export function parseDurationSeconds(watchPageHtml) {
  // The watch page carries this both raw ("lengthSeconds":"742") and inside an
  // escaped JSON string ("lengthSeconds":\"742\"), so the backslash is optional.
  const m = String(watchPageHtml || "").match(/"lengthSeconds":\s*\\?"(\d+)\\?"/);
  if (!m) return null;
  const seconds = Number(m[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}
