import { createHash } from "node:crypto";

/**
 * The extraction specification.
 *
 * The model and the zero-shot prompt below are the ones the existing research
 * uses and are reproduced verbatim. Do not edit them casually: SPEC_VERSION is
 * derived from both, so any change starts a new, separate generation of results
 * rather than silently mixing incompatible extractions in the shared library.
 */

export const MODEL = "gemini-3-flash-preview";

export const PROMPT = `You extract a hardware Bill of Materials from an IoT tutorial transcript.
Return every shoppable hardware component the presenter mentions or uses.
Rules:
- Only physically purchasable hardware parts.
- Exclude integrated parts, consumables, software, and parts mentioned only for context or contrast.
- Label each as "USED" or "ALTERNATIVE".
- Deduplicate. Use the most specific name stated.
Return ONLY JSON in exactly this shape:
{"components":[{"name":"...","status":"USED"}]}

Transcript:
`;

/** Stable fingerprint of (model + prompt), e.g. "v1-gemini-3-flash-preview-1a2b3c4d". */
export const SPEC_VERSION = (() => {
  const digest = createHash("sha256").update(`${MODEL}\n${PROMPT}`).digest("hex").slice(0, 8);
  return `v1-${MODEL}-${digest}`;
})();

const envInt = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * Limits applied to incoming requests.
 *
 * The timeouts form a deliberate budget. A serverless function has a hard wall
 * clock limit (60s on Vercel's current Hobby plan), and the original code had
 * no timeouts at all, so a slow upstream simply ran until the platform killed
 * the request. Worst case now:
 *
 *   claim + transcript + Supadata fallback + model + persist
 *
 * rather than by giving each stage an independent constant. See
 * requestBudgetMs below. Every value is overridable by environment variable so
 * the budget can be retuned for a different platform without a code change.
 */
export const LIMITS = {
  maxBodyBytes: 200_000,
  maxTranscriptChars: 120_000,
  // Transcript slice sent to the model, matching the previous behaviour of
  // sending the full cleaned transcript but with a hard ceiling.
  maxPromptChars: 120_000,
  extractPerWindow: 10,
  extractWindowSeconds: 600,
  refreshPerWindow: 3,
  refreshWindowSeconds: 3600,
  leaseSeconds: envInt('LEASE_SECONDS', 180),

  // How long a request waits for another instance already extracting the same
  // video. Kept short: on timeout the client is told to retry, which is far
  // cheaper than holding a serverless invocation open. Read through
  // PEER_WAIT_MS / PEER_POLL_MS at call time so tests need not burn real time.
  waitForPeerMs: 8_000,
  waitPollMs: 1_000,

  transcriptTimeoutMs: envInt('TRANSCRIPT_TIMEOUT_MS', 10_000),
  storeTimeoutMs: envInt('STORE_TIMEOUT_MS', 5_000),

  /**
   * Overall wall-clock budget for one extraction request.
   *
   * The model is not given a fixed slice of time. It is given whatever is left
   * of this budget once the transcript work is done, minus a reserve to persist
   * the result. A fixed model timeout is the wrong shape: Gemini 3 Flash is a
   * thinking model whose latency varies with how much it reasons, so a constant
   * either truncates a legitimately slow run or overruns the platform limit.
   *
   * The default sits just under Vercel's 60s function ceiling. Locally there is
   * no such ceiling - set REQUEST_BUDGET_MS much higher (e.g. 300000) to let a
   * slow extraction run to completion.
   */
  requestBudgetMs: envInt('REQUEST_BUDGET_MS', 55_000),

  /** Held back from the budget so a successful result can still be written. */
  persistReserveMs: envInt('PERSIST_RESERVE_MS', 6_000),

  /**
   * The model is never given less than this, even if the budget is nearly
   * spent - a one-second timeout would fail every time and waste the transcript
   * work already done.
   */
  geminiMinTimeoutMs: envInt('GEMINI_MIN_TIMEOUT_MS', 20_000),

  /** Absolute ceiling, so a huge budget cannot hang a request indefinitely. */
  geminiMaxTimeoutMs: envInt('GEMINI_MAX_TIMEOUT_MS', 240_000)
};

/**
 * How long the model may run, given how much of the budget is already spent.
 * Returns at least geminiMinTimeoutMs and at most geminiMaxTimeoutMs.
 *
 * The four values are read at CALL time rather than captured at module load,
 * so setting REQUEST_BUDGET_MS (or the others) takes effect regardless of when
 * the module happened to be imported.
 */
export function geminiBudgetMs(elapsedMs, limits = null) {
  const resolved = limits || {
    requestBudgetMs: envInt('REQUEST_BUDGET_MS', LIMITS.requestBudgetMs),
    persistReserveMs: envInt('PERSIST_RESERVE_MS', LIMITS.persistReserveMs),
    geminiMinTimeoutMs: envInt('GEMINI_MIN_TIMEOUT_MS', LIMITS.geminiMinTimeoutMs),
    geminiMaxTimeoutMs: envInt('GEMINI_MAX_TIMEOUT_MS', LIMITS.geminiMaxTimeoutMs)
  };

  const remaining = resolved.requestBudgetMs - Math.max(0, elapsedMs) - resolved.persistReserveMs;
  return Math.min(
    resolved.geminiMaxTimeoutMs,
    Math.max(resolved.geminiMinTimeoutMs, remaining)
  );
}
