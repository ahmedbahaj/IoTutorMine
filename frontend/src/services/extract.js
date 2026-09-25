// The deployed API. Overridable for local development only
// (VITE_API_BASE=http://localhost:3001/api npm run dev). Production builds set
// no such variable, so the published site at
// https://ahmedbahaj.github.io/IoTutorMine/ keeps calling the deployed Vercel
// endpoint exactly as before.
const API_BASE = import.meta.env?.VITE_API_BASE || 'https://io-tutor-mine.vercel.app/api';

/** Error carrying the HTTP status and the API's structured flags. */
export class ApiError extends Error {
  constructor(message, { status = 0, needsTranscript = false, ineligible = false, processing = false, errorCode = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.needsTranscript = needsTranscript;
    this.ineligible = ineligible;
    this.processing = processing;
    // 'timeout' | 'provider_error' | 'not_configured' | 'no_transcript' | 'ineligible' | ''
    this.errorCode = errorCode;
  }

  /** A genuine model timeout, as opposed to any other failure. */
  get isTimeout() {
    return this.errorCode === 'timeout' || this.status === 504;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Derive a code for the cases the API signals with a flag rather than a
    // code, so the caller has one field to branch on.
    const errorCode =
      data.errorCode ||
      (data.needsTranscript === true ? 'no_transcript' : '') ||
      (data.ineligible === true ? 'ineligible' : '');

    throw new ApiError(data.error || `Request failed (${res.status})`, {
      status: res.status,
      needsTranscript: data.needsTranscript === true,
      ineligible: data.ineligible === true,
      processing: data.processing === true,
      errorCode
    });
  }

  return data;
}

/**
 * Run an extraction. The backend checks the shared cache first and only calls
 * the model when no reusable result exists; `force: true` requests an explicit
 * re-extraction.
 */
export async function extractComponents({ url, transcript, force = false, signal } = {}) {
  return request('/extract', {
    method: 'POST',
    signal,
    body: { url, transcript, force }
  });
}

/** Paginated public library. */
export async function listPublicExtractions({ q = '', limit = 24, offset = 0, signal } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (q) params.set('q', q);
  return request(`/extractions?${params}`, { signal });
}

/**
 * Published entries for a set of video ids, in one request. Read-only: this
 * never triggers an extraction, so opening a page cannot cost a model call.
 */
export async function listActiveExtractions(videoIds, { signal } = {}) {
  const ids = [...new Set((videoIds || []).filter(Boolean))];
  if (!ids.length) return { items: [] };

  const params = new URLSearchParams({ videoIds: ids.join(',') });
  return request(`/extractions?${params}`, { signal });
}

/** A single published entry. */
export async function getPublicExtraction(videoId, { signal } = {}) {
  const params = new URLSearchParams({ videoId });
  const data = await request(`/extractions?${params}`, { signal });
  return data.item || null;
}
