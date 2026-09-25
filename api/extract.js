/**
 * POST /api/extract
 *
 * Request:  { url?: string, transcript?: string, force?: boolean }
 * Response: the shared extraction shape (see _lib/shape.js)
 *
 * Lookup order:
 *   1. normalise and validate the URL into a canonical 11-char video id
 *   2. shared-cache read (authoritative, server side)
 *   3. atomic claim; if another instance holds the lease, wait for its result
 *   4. transcript + metadata + cheap eligibility check
 *   5. only then call the model, and persist the result
 *
 * When Supabase is not configured the handler degrades to the original
 * stateless behaviour: it extracts and returns, with no caching or publication.
 */

import { LIMITS, MODEL, SPEC_VERSION, geminiBudgetMs } from "./_lib/spec.js";
import { canonicalUrl, fetchOEmbedMetadata, parseVideoId, thumbnailUrl } from "./_lib/youtube.js";
import { cleanTranscript, getTranscriptFromSupadata, getTranscriptFromYouTube } from "./_lib/transcript.js";
import { GeminiError, callGemini } from "./_lib/gemini.js";
import { assessPublication, assessRelevance, buildSearchText, validateComponents } from "./_lib/validate.js";
import * as store from "./_lib/store.js";
import { fresh, fromRow } from "./_lib/shape.js";
import { bodyTooLarge, clientKey, readJsonBody, setCors } from "./_lib/http.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function allow(env, bucket, limit, windowSeconds) {
  if (!store.isConfigured(env)) return true; // no shared counter available
  try {
    return await store.checkRateLimit(env, { bucket, limit, windowSeconds });
  } catch {
    // A rate-limiter outage must not take the whole endpoint down.
    return true;
  }
}

/** Wait for a peer instance that holds the lease to publish its result. */
async function waitForPeer(env, videoId) {
  const budget = Number(env.PEER_WAIT_MS) || LIMITS.waitForPeerMs;
  const poll = Number(env.PEER_POLL_MS) || LIMITS.waitPollMs;
  const deadline = Date.now() + budget;

  while (Date.now() < deadline) {
    await sleep(poll);
    const row = await store.findReady(env, videoId, SPEC_VERSION).catch(() => null);
    if (row) return row;
  }

  return null;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const env = process.env;
  // Wall clock for this request, so the model can be given whatever is left of
  // the budget rather than a fixed slice.
  const startedAt = Date.now();

  if (bodyTooLarge(req, LIMITS.maxBodyBytes)) {
    return res.status(413).json({ error: "Request is too large." });
  }

  const body = readJsonBody(req);
  const rawUrl = typeof body.url === "string" ? body.url : "";
  const rawTranscript = typeof body.transcript === "string" ? body.transcript : "";
  const force = body.force === true;

  if (rawTranscript.length > LIMITS.maxTranscriptChars) {
    return res.status(413).json({ error: "Transcript is too long." });
  }

  const ip = clientKey(req);
  const manualTranscript = cleanTranscript(rawTranscript);
  const videoId = parseVideoId(rawUrl);

  // ---- validation ------------------------------------------------------
  if (!manualTranscript && !videoId) {
    return res.status(400).json({
      error: rawUrl
        ? "That does not look like a supported YouTube video link."
        : "Provide either a valid YouTube URL or a transcript."
    });
  }

  // ---- rate limiting ---------------------------------------------------
  if (!(await allow(env, `extract:${ip}`, LIMITS.extractPerWindow, LIMITS.extractWindowSeconds))) {
    return res.status(429).json({ error: "Too many extraction requests. Please try again later." });
  }

  if (force) {
    const required = env.REFRESH_TOKEN;
    if (required && req.headers["x-refresh-token"] !== required) {
      return res.status(403).json({ error: "Re-extraction is not permitted for this request." });
    }
    if (!(await allow(env, `refresh:${ip}`, LIMITS.refreshPerWindow, LIMITS.refreshWindowSeconds))) {
      return res.status(429).json({ error: "Re-extraction limit reached. Please try again later." });
    }
  }

  // ---- manual transcript path -----------------------------------------
  // Never cached and never published: we cannot establish that pasted text
  // corresponds to the linked video. The result is still returned so it can be
  // saved in the user's own history.
  if (manualTranscript) {
    try {
      const raw = await callGemini(manualTranscript, env.GEMINI_KEY, {
        timeoutMs: geminiBudgetMs(Date.now() - startedAt)
      });
      const { ok, components, errors } = validateComponents(raw);

      if (!ok) return res.status(422).json({ error: errors[0] || "No components were extracted." });

      return res.status(200).json(fresh({
        videoId,
        canonicalUrl: videoId ? canonicalUrl(videoId) : null,
        thumbnail: videoId ? thumbnailUrl(videoId) : null,
        components,
        model: MODEL,
        specVersion: SPEC_VERSION,
        source: "manual-transcript",
        published: false,
        reviewReason: "manual-transcript-unverified"
      }));
    } catch (e) {
      return res.status(e?.code === "timeout" ? 504 : 500).json({
        error: e?.message || "Extraction failed",
        errorCode: e?.code || "unknown"
      });
    }
  }

  // ---- shared cache ----------------------------------------------------
  const shared = store.isConfigured(env);
  const url = canonicalUrl(videoId);
  let claimed = false;

  if (shared) {
    try {
      if (!force) {
        const cached = await store.findReady(env, videoId, SPEC_VERSION);
        if (cached) return res.status(200).json(fromRow(cached, { cacheHit: "shared" }));
      }

      const claim = await store.claimExtraction(env, {
        videoId,
        specVersion: SPEC_VERSION,
        canonicalUrl: url,
        staleSeconds: LIMITS.leaseSeconds,
        force
      });

      if (claim.outcome === "ready" && !force) {
        return res.status(200).json(fromRow(claim.row, { cacheHit: "shared" }));
      }

      if (claim.outcome === "processing") {
        const row = await waitForPeer(env, videoId);
        if (row) return res.status(200).json(fromRow(row, { cacheHit: "shared-concurrent" }));

        return res.status(202).json({
          processing: true,
          videoId,
          error: "This video is already being processed. Please wait a moment and try again."
        });
      }

      claimed = true;
    } catch (e) {
      // The shared library being unavailable should not block extraction.
      console.error("shared store unavailable:", e?.message);
    }
  }

  // ---- extraction ------------------------------------------------------
  try {
    const [metadata, transcriptResult] = await Promise.all([
      fetchOEmbedMetadata(videoId),
      getTranscriptFromYouTube(videoId, { timeoutMs: LIMITS.transcriptTimeoutMs })
    ]);

    if (metadata.available === false) {
      const message = "This video is unavailable. It may be private, deleted, or region restricted.";
      if (claimed) await store.failExtraction(env, { videoId, specVersion: SPEC_VERSION, message }).catch(() => {});
      return res.status(404).json({ error: message });
    }

    let transcript = transcriptResult.text;
    if (!transcript) {
      transcript = await getTranscriptFromSupadata(videoId, env.SUPADATA_KEY, {
        timeoutMs: LIMITS.transcriptTimeoutMs
      });
    }

    if (!transcript) {
      const message = "No transcript available for this video. You can paste the transcript manually.";
      if (claimed) await store.failExtraction(env, { videoId, specVersion: SPEC_VERSION, message }).catch(() => {});
      return res.status(422).json({ error: message, needsTranscript: true });
    }

    // Cheap eligibility check, before any model spend.
    const relevance = assessRelevance({
      title: metadata.title || "",
      author: metadata.author || "",
      transcript
    });

    if (relevance.verdict === "rejected") {
      if (claimed) {
        await store.failExtraction(env, {
          videoId,
          specVersion: SPEC_VERSION,
          message: "not-iot-hardware"
        }).catch(() => {});
      }
      return res.status(422).json({ error: relevance.reason, ineligible: true });
    }

    const raw = await callGemini(transcript, env.GEMINI_KEY, {
      timeoutMs: geminiBudgetMs(Date.now() - startedAt)
    });
    const { ok, components, errors } = validateComponents(raw);

    if (!ok) {
      const message = errors[0] || "No components were extracted from this video.";
      if (claimed) await store.failExtraction(env, { videoId, specVersion: SPEC_VERSION, message }).catch(() => {});
      return res.status(422).json({ error: message });
    }

    const publication = assessPublication({
      source: "youtube-url",
      components,
      relevance: relevance.verdict,
      metadataAvailable: metadata.available === true,
      title: metadata.title
    });

    const result = fresh({
      videoId,
      canonicalUrl: url,
      title: metadata.title,
      channel: metadata.author,
      durationSeconds: transcriptResult.durationSeconds,
      thumbnail: metadata.thumbnail || thumbnailUrl(videoId),
      components,
      model: MODEL,
      specVersion: SPEC_VERSION,
      source: "youtube-url",
      published: publication.publish,
      reviewReason: publication.reason
    });

    if (claimed) {
      try {
        const row = await store.completeExtraction(env, {
          videoId,
          specVersion: SPEC_VERSION,
          canonicalUrl: url,
          title: metadata.title,
          channel: metadata.author,
          durationSeconds: transcriptResult.durationSeconds,
          thumbnailUrl: metadata.thumbnail || thumbnailUrl(videoId),
          components,
          model: MODEL,
          source: "youtube-url",
          publicationStatus: publication.status,
          reviewReason: publication.reason,
          searchText: buildSearchText({
            title: metadata.title,
            author: metadata.author,
            components
          })
        });

        if (row) {
          result.sharedId = row.id ?? null;
          result.published = row.publication_status === "published";
        }
      } catch (e) {
        // The extraction itself succeeded; failing to persist it must not fail
        // the user's request.
        console.error("failed to persist extraction:", e?.message);
      }
    }

    return res.status(200).json(result);
  } catch (e) {
    const message = e?.message || "Extraction failed";
    const isTimeout = e instanceof GeminiError && e.code === "timeout";
    const errorCode = e instanceof GeminiError ? e.code : "unknown";

    // A timeout means we abandoned our own model call, not that no result
    // exists. A peer instance may have finished this same video while we were
    // waiting. Check once before reporting failure, so the user is served a
    // real result instead of being invited to spend another model call on a
    // video that is already extracted.
    if (shared && isTimeout) {
      const row = await store.findReady(env, videoId, SPEC_VERSION).catch(() => null);
      if (row) {
        if (claimed) {
          await store
            .failExtraction(env, { videoId, specVersion: SPEC_VERSION, message })
            .catch(() => {});
        }
        return res.status(200).json(fromRow(row, { cacheHit: "shared-after-timeout" }));
      }
    }

    if (claimed) {
      // Releases the lease. A previously successful result is preserved: the
      // SQL refuses to downgrade a row that already holds one.
      await store.failExtraction(env, { videoId, specVersion: SPEC_VERSION, message }).catch(() => {});
    }

    // 504 distinguishes "we ran out of time" from "something went wrong",
    // which the client needs in order to offer a sensible next step.
    return res.status(isTimeout ? 504 : 500).json({
      error: isTimeout
        ? `${message} The extraction was not completed — you can try again.`
        : message,
      errorCode,
      videoId
    });
  }
}
