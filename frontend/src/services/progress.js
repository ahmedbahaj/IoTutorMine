/**
 * Progress estimation for the extraction form.
 *
 * The backend answers in a single HTTP request and reports no intermediate
 * state, so there is nothing real to display mid-flight. Rather than inventing
 * completed stages, this models *elapsed time only*: the bar eases towards a
 * ceiling it never reaches and is honest about what it means. 100% is written
 * by the caller, once, on a confirmed success.
 */

export const PROGRESS_CAP = 92;
export const EXPECTED_MS = 18_000;

/** Time constant chosen so the curve reaches ~63% of the cap at EXPECTED_MS/2. */
const TAU = EXPECTED_MS / 2;

/**
 * Monotonic, asymptotic estimate in [0, PROGRESS_CAP).
 * Never returns 100: only a confirmed response may do that.
 */
export function estimateProgress(elapsedMs, { cap = PROGRESS_CAP, tau = TAU } = {}) {
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const value = cap * (1 - Math.exp(-elapsed / tau));
  return Math.min(cap - 0.01, Math.round(value * 10) / 10);
}

/**
 * The message shown beside the bar. Describes what the client is actually
 * waiting on, and says plainly when a request is running long.
 */
export function progressMessage(elapsedMs, { expectedMs = EXPECTED_MS } = {}) {
  const elapsed = Math.max(0, Number(elapsedMs) || 0);

  if (elapsed > expectedMs * 3) {
    return 'Still processing. Long videos can take a while — this request is still open.';
  }
  if (elapsed > expectedMs) {
    return 'Taking longer than usual. Processing is still in progress.';
  }
  return 'Fetching the transcript and extracting components…';
}

/** Accessible label for the progress region. */
export function progressLabel(phase, percent) {
  switch (phase) {
    case 'done':
      return 'Extraction complete.';
    case 'error':
      return 'Extraction failed.';
    case 'running':
      return `Extraction in progress, roughly ${Math.round(percent)} percent of the expected time elapsed.`;
    default:
      return '';
  }
}
