import { MODEL, PROMPT, LIMITS } from "./spec.js";

/**
 * Call Gemini with the fixed zero-shot prompt.
 * The prompt, model, and response shape are unchanged from the original
 * implementation; only a timeout and an input ceiling were added.
 */
export async function callGemini(transcript, key, { fetchImpl = fetch, timeoutMs = LIMITS.geminiTimeoutMs } = {}) {
  if (!key) throw new Error("Extraction service is not configured.");

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
      throw new Error(data?.error?.message || "Gemini request failed");
    }

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    try {
      return JSON.parse(raw).components || [];
    } catch {
      return [];
    }
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("Extraction timed out. Please try again.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
