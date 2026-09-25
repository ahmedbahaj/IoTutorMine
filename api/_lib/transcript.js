/**
 * Transcript retrieval.
 *
 * Unchanged in behaviour from the original implementation: the YouTube watch
 * page is scraped for caption tracks first, then Supadata is used as a
 * fallback. Two things were tightened:
 *   - every outbound URL is built from a validated 11-character video id, never
 *     from the raw string the user submitted;
 *   - the caption track URL returned by YouTube is host-checked before it is
 *     fetched.
 * The watch page is also reused to read the video duration, so no extra request
 * is needed for it.
 */

import { canonicalUrl, isValidVideoId, parseDurationSeconds } from "./youtube.js";

const CAPTION_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com"
]);

export function cleanTranscript(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * Fetch the watch page once and return both the caption transcript and the
 * duration. Either field may be null.
 */
export async function getTranscriptFromYouTube(videoId, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  if (!isValidVideoId(videoId)) return { text: null, durationSeconds: null };

  const t = withTimeout(timeoutMs);

  // Duration is held outside the caption lookup on purpose. YouTube's timedtext
  // endpoint often answers 200 with an empty body, which makes the caption path
  // throw; a caption failure must not discard metadata we have already read
  // from the watch page.
  let durationSeconds = null;

  try {
    const pageRes = await fetchImpl(canonicalUrl(videoId), {
      signal: t.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    const page = await pageRes.text();
    durationSeconds = parseDurationSeconds(page);

    const normalized = page
      .replace(/\\"/g, '"')
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/");

    const m = normalized.match(/"captionTracks":(\[.*?\])/);
    if (!m) return { text: null, durationSeconds };

    let tracks;
    try {
      tracks = JSON.parse(m[1]);
    } catch {
      return { text: null, durationSeconds };
    }

    if (!Array.isArray(tracks) || !tracks.length) return { text: null, durationSeconds };

    const track =
      tracks.find(x => x.languageCode === "en" && x.kind !== "asr") ||
      tracks.find(x => x.languageCode === "en") ||
      tracks[0];

    if (!track?.baseUrl) return { text: null, durationSeconds };

    // The caption URL comes from YouTube's own payload, but it is still
    // host-checked before being used as a fetch destination.
    let captionUrl;
    try {
      captionUrl = new URL(track.baseUrl);
    } catch {
      return { text: null, durationSeconds };
    }
    if (captionUrl.protocol !== "https:" || !CAPTION_HOSTS.has(captionUrl.hostname.toLowerCase())) {
      return { text: null, durationSeconds };
    }
    captionUrl.searchParams.set("fmt", "json3");

    const transcriptRes = await fetchImpl(captionUrl.toString(), { signal: t.signal });
    // An empty 200 is the common case now, and it is not valid JSON.
    const data = await transcriptRes.json().catch(() => null);

    const text = (data?.events || [])
      .flatMap(ev => (ev.segs || []).map(s => s.utf8 || ""))
      .join(" ");

    const cleaned = cleanTranscript(text);
    return { text: cleaned || null, durationSeconds };
  } catch {
    return { text: null, durationSeconds };
  } finally {
    t.done();
  }
}

/** Supadata fallback. Called with the canonical URL, never the user's raw input. */
export async function getTranscriptFromSupadata(videoId, key, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  if (!isValidVideoId(videoId) || !key) return null;

  const t = withTimeout(timeoutMs);

  try {
    const endpoint =
      `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(canonicalUrl(videoId))}&lang=en`;

    const res = await fetchImpl(endpoint, {
      signal: t.signal,
      headers: { "x-api-key": key }
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return null;

    if (Array.isArray(data.content)) {
      return cleanTranscript(data.content.map(segment => segment.text || "").join(" ")) || null;
    }
    if (typeof data.content === "string") {
      return cleanTranscript(data.content) || null;
    }
    if (typeof data.text === "string") {
      return cleanTranscript(data.text) || null;
    }

    return null;
  } catch {
    return null;
  } finally {
    t.done();
  }
}
