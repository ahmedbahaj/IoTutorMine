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
 *   claim 5s + transcript 10s + Supadata fallback 10s + Gemini 30s + persist 5s
 *
 * which stays under 60s. Every value is overridable by environment variable so
 * the budget can be retuned for a different plan without a code change.
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

  geminiTimeoutMs: envInt('GEMINI_TIMEOUT_MS', 30_000),
  transcriptTimeoutMs: envInt('TRANSCRIPT_TIMEOUT_MS', 10_000),
  storeTimeoutMs: envInt('STORE_TIMEOUT_MS', 5_000)
};
