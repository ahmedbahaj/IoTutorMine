/**
 * Client-side YouTube URL normalisation.
 *
 * This mirrors api/_lib/youtube.js so the browser can resolve a canonical video
 * id before calling the API - that is what makes the personal-history cache
 * check possible. The backend remains authoritative and re-validates every
 * request; nothing here is trusted server-side.
 *
 * tests/youtube.test.js asserts that both implementations agree, so the two
 * copies cannot drift apart silently.
 */

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be'
]);

const PATH_PREFIXES = ['shorts', 'embed', 'live', 'v'];

export const MAX_URL_LENGTH = 2048;

export function isValidVideoId(id) {
  return typeof id === 'string' && VIDEO_ID_RE.test(id);
}

export function parseVideoId(input) {
  if (typeof input !== 'string') return null;

  const raw = input.trim();
  if (!raw || raw.length > MAX_URL_LENGTH) return null;

  if (VIDEO_ID_RE.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return null;

  const segments = url.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    return isValidVideoId(segments[0]) ? segments[0] : null;
  }

  if (segments[0] === 'watch') {
    const v = url.searchParams.get('v');
    return isValidVideoId(v) ? v : null;
  }

  if (PATH_PREFIXES.includes(segments[0])) {
    return isValidVideoId(segments[1]) ? segments[1] : null;
  }

  const v = url.searchParams.get('v');
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

/** "8:42" / "1:02:30". Returns null when the duration is unknown. */
export function formatDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return null;

  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);

  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
