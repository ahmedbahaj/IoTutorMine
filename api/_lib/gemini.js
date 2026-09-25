import { MODEL, PROMPT, LIMITS } from "./spec.js";

/**
 * Carries a machine-readable reason so callers can tell a genuine timeout from
 * a provider rejection. These read very differently to a user and need
 * different handling, but both surface as a 500 otherwise.
 */
export class GeminiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "GeminiError";
    this.code = code; // 'timeout' | 'provider_error' | 'not_configured'
  }
}

/**
 * Call Gemini with the fixed zero-shot prompt.
 * The prompt, model, and response shape are unchanged from the original
 * implementation; only a timeout and an input ceiling were added.
 */
export async function callGemini(transcript, key, { fetchImpl = fetch, timeoutMs = LIMITS.geminiMinTimeoutMs } = {}) {
  if (!key) throw new GeminiError("Extraction service is not configured.", "not_configured");

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const geminiRes = await fetchImpl(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT + String(transcript).slice(0, LIMITS.maxPromptChars) }] }],
        generationConfig: {
          responseMimeType: "application/json"
        }
      })
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      throw new GeminiError(
        data?.error?.message || `Gemini request failed (${geminiRes.status})`,
        "provider_error"
      );
    }

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    try {
      return JSON.parse(raw).components || [];
    } catch {
      return [];
    }
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new GeminiError(
        `The model did not respond within ${Math.round(timeoutMs / 1000)}s.`,
        "timeout"
      );
    }
    if (e instanceof GeminiError) throw e;
    // A network-level failure is not a timeout and must not be reported as one.
    throw new GeminiError(e?.message || "Gemini request failed", "provider_error");
  } finally {
    clearTimeout(timer);
  }
}
