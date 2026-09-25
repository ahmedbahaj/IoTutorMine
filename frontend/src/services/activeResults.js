/**
 * Active-result resolution.
 *
 * One video can have two component lists: the immutable result recorded in the
 * research catalog (frontend/src/data/videos.js), and a newer extraction in the
 * shared library. Before this module existed, the catalog pages read straight
 * from the static import while the library pages read from the API, so the same
 * video could show 5 components on Home and 8 on All Extractions.
 *
 * Every surface now resolves through here instead, so there is exactly one
 * answer per canonical video id:
 *
 *   1. the latest published shared extraction for the current spec version
 *   2. otherwise the original catalog result
 *
 * The catalog data is never mutated. Resolution returns new objects, and the
 * original list stays available as historical data.
 *
 * This module only ever performs a read. It never triggers an extraction.
 */

import { reactive, readonly } from 'vue'
import { listActiveExtractions } from './extract.js'

export const SOURCE_SHARED = 'shared'
export const SOURCE_CATALOG = 'catalog'

/** Shown beside a resolved result. Deliberately descriptive, not evaluative. */
export const SOURCE_LABEL = {
  [SOURCE_SHARED]: 'Latest AI Extraction',
  [SOURCE_CATALOG]: 'Original Catalog'
}

const state = reactive({
  /** videoId -> the active shared extraction */
  byVideoId: {},
  loading: false,
  loaded: false,
  /** Set when the library could not be reached; catalog fallback still works. */
  error: ''
})

export const activeResults = readonly(state)

/** In-flight load, so concurrent mounts share one request. */
let inFlight = null

function indexRows(rows) {
  for (const row of rows || []) {
    if (!row?.videoId) continue

    const existing = state.byVideoId[row.videoId]
    // Keep the newer of the two when both are present.
    if (existing && newerOf(existing, row) === existing) continue

    state.byVideoId[row.videoId] = row
  }
}

/** Shallow-copy the list so callers cannot mutate the cached result. */
function copyComponents(components) {
  return (components || []).map(c => ({ ...c }))
}

function timeOf(result) {
  const raw = result?.extractedAt || result?.savedAt
  const t = raw ? Date.parse(raw) : NaN
  return Number.isNaN(t) ? 0 : t
}

function newerOf(a, b) {
  return timeOf(b) >= timeOf(a) ? b : a
}

/**
 * Load the active shared extraction for the given video ids, once.
 * Safe to call from every page; repeat calls for known ids are free.
 */
export async function ensureActiveResults(videoIds, { force = false } = {}) {
  const ids = [...new Set((videoIds || []).filter(Boolean))]
  if (!ids.length) return

  const missing = force ? ids : ids.filter(id => !(id in state.byVideoId))
  if (!force && state.loaded && !missing.length) return

  if (inFlight) return inFlight

  state.loading = true
  state.error = ''

  inFlight = (async () => {
    try {
      const data = await listActiveExtractions(ids)
      indexRows(data.items)
      state.loaded = true
    } catch (e) {
      // The library being unreachable must not break the catalog: every page
      // falls back to the original result and simply shows no newer one.
      state.error = e?.message || 'Could not load the shared extraction library.'
    } finally {
      state.loading = false
      inFlight = null
    }
  })()

  return inFlight
}

/**
 * Record a freshly completed extraction so every open view updates without a
 * browser refresh. Only a published result becomes active.
 */
export function setActiveResult(result) {
  if (!result?.videoId || !Array.isArray(result.components)) return
  // An empty or unpublished result is not a usable active result and must
  // never displace a good one.
  if (!result.components.length) return
  if (result.published !== true) return

  const existing = state.byVideoId[result.videoId]
  state.byVideoId[result.videoId] = existing ? newerOf(existing, result) : result
}

/** The active shared extraction for a video, or null. */
export function activeFor(videoId) {
  return videoId ? state.byVideoId[videoId] || null : null
}

/**
 * Resolve a catalog entry against the shared library.
 *
 * Returns a NEW object; the catalog entry is never modified. `components` is
 * swapped for the active list when one exists, and the original stays reachable
 * as `catalogComponents`.
 */
export function resolveCatalogVideo(video) {
  if (!video) return video

  const active = activeFor(video.youtubeId)
  const catalogComponents = video.components || []

  if (!active) {
    return {
      ...video,
      components: copyComponents(catalogComponents),
      catalogComponents,
      activeSource: SOURCE_CATALOG,
      activeSourceLabel: SOURCE_LABEL[SOURCE_CATALOG],
      activeExtractedAt: null,
      activeModel: null,
      hasNewerExtraction: false
    }
  }

  return {
    ...video,
    components: copyComponents(active.components),
    catalogComponents,
    activeSource: SOURCE_SHARED,
    activeSourceLabel: SOURCE_LABEL[SOURCE_SHARED],
    activeExtractedAt: active.extractedAt || null,
    activeModel: active.model || null,
    hasNewerExtraction: true
  }
}

/** Resolve a whole catalog list, preserving order. */
export function resolveCatalog(videos) {
  return (videos || []).map(resolveCatalogVideo)
}

/**
 * Resolve a locally saved history record.
 *
 * Personal history is a record of what the user ran and when, so its own
 * timestamp is never rewritten. When the shared library holds a newer result
 * for the same video, that one is shown as active and the user's own record is
 * kept alongside it.
 */
export function resolveHistoryEntry(entry) {
  if (!entry) return entry

  const active = activeFor(entry.videoId)
  const isSuperseded = Boolean(active) && timeOf(active) > timeOf(entry)

  if (!isSuperseded) {
    return {
      ...entry,
      activeSource: active ? SOURCE_SHARED : SOURCE_CATALOG,
      supersededByShared: false,
      historicalComponents: entry.components,
      historicalExtractedAt: entry.extractedAt
    }
  }

  return {
    ...entry,
    components: copyComponents(active.components),
    componentCount: active.components.length,
    activeSource: SOURCE_SHARED,
    activeSourceLabel: SOURCE_LABEL[SOURCE_SHARED],
    activeExtractedAt: active.extractedAt || null,
    activeModel: active.model || null,
    supersededByShared: true,
    // The user's own record, kept intact and clearly separate.
    historicalComponents: entry.components,
    historicalExtractedAt: entry.extractedAt
  }
}

/** Test seam: drop everything cached. */
export function resetActiveResults() {
  for (const key of Object.keys(state.byVideoId)) delete state.byVideoId[key]
  state.loading = false
  state.loaded = false
  state.error = ''
  inFlight = null
}
