/**
 * Regression tests for single-active-result resolution.
 *
 * The bug: catalog pages read component lists straight from the static
 * videos.js import while the library pages read from the API, so the same video
 * could show 5 components on Home and 8 on All Extractions.
 */

import { describe, expect, test, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'

import HomePage from '../views/HomePage.vue'
import VideoDetailPage from '../views/VideoDetailPage.vue'
import MyExtractionsPage from '../views/MyExtractionsPage.vue'
import ExtractionDetailPage from '../views/ExtractionDetailPage.vue'
import routerConfig from '../router/index.js'
import { videos } from '../data/videos.js'
import { history } from './history.js'
import {
  SOURCE_CATALOG,
  SOURCE_SHARED,
  activeFor,
  ensureActiveResults,
  resetActiveResults,
  resolveCatalog,
  resolveCatalogVideo,
  resolveHistoryEntry,
  setActiveResult
} from './activeResults.js'
import { listActiveExtractions, extractComponents } from './extract.js'

vi.mock('./extract.js', () => ({
  extractComponents: vi.fn(),
  listPublicExtractions: vi.fn(async () => ({ items: [], hasMore: false })),
  getPublicExtraction: vi.fn(),
  listActiveExtractions: vi.fn(async () => ({ items: [] })),
  ApiError: class ApiError extends Error {}
}))

/** The catalog entry that exposed the problem. */
const CATALOG = videos.find(v => v.youtubeId === 'KGwtit2bFyo')
const VIDEO_ID = 'KGwtit2bFyo'

/** A newer shared extraction with more components than the catalog records. */
const NEWER = {
  videoId: VIDEO_ID,
  canonicalUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
  title: 'How To Use Ultrasonic Sensors with Arduino!',
  components: [
    { name: 'Ultrasonic sensor', status: 'USED' },
    { name: 'Arduino Uno', status: 'USED' },
    { name: 'Lidars', status: 'ALTERNATIVE' },
    { name: 'Servo motor', status: 'USED' },
    { name: 'Jumpers', status: 'USED' },
    { name: 'Buzzer', status: 'USED' },
    { name: 'LED', status: 'USED' },
    { name: 'RGBDuino', status: 'ALTERNATIVE' }
  ],
  componentCount: 8,
  model: 'gemini-3-flash-preview',
  published: true,
  extractedAt: '2026-06-01T00:00:00.000Z'
}

async function mountAt(component, path, props = {}) {
  const router = createRouter({
    history: createWebHistory('/IoTutorMine/'),
    routes: routerConfig.options.routes
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(component, { props, global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

const usedNames = components => components.filter(c => c.status === 'USED').map(c => c.name)

beforeEach(() => {
  resetActiveResults()
  localStorage.clear()
  vi.mocked(listActiveExtractions).mockReset()
  vi.mocked(listActiveExtractions).mockResolvedValue({ items: [] })
  vi.mocked(extractComponents).mockReset()
})

/* ========================================================================== */
/* 1 & 2. Resolution                                                          */
/* ========================================================================== */

describe('resolution', () => {
  test('1. with no shared extraction, the original catalog result is used', () => {
    const resolved = resolveCatalogVideo(CATALOG)

    expect(resolved.components).toEqual(CATALOG.components)
    expect(resolved.activeSource).toBe(SOURCE_CATALOG)
    expect(resolved.activeSourceLabel).toBe('Original Catalog')
    expect(resolved.hasNewerExtraction).toBe(false)
  })

  test('2. a newer published extraction becomes the active result', () => {
    setActiveResult(NEWER)
    const resolved = resolveCatalogVideo(CATALOG)

    expect(resolved.components).toHaveLength(8)
    expect(resolved.activeSource).toBe(SOURCE_SHARED)
    expect(resolved.activeSourceLabel).toBe('Latest AI Extraction')
    expect(resolved.hasNewerExtraction).toBe(true)
    expect(resolved.activeModel).toBe('gemini-3-flash-preview')
  })

  test('10. resolution never mutates the original catalog data', () => {
    const before = JSON.parse(JSON.stringify(CATALOG))

    setActiveResult(NEWER)
    const resolved = resolveCatalogVideo(CATALOG)
    resolved.components.push({ name: 'tampering', status: 'USED' })
    resolved.components[0].name = 'tampered'

    // Neither the catalog nor the shared cache may be corrupted by a caller.
    expect(CATALOG).toEqual(before)
    expect(activeFor(VIDEO_ID).components).toHaveLength(8)
    expect(activeFor(VIDEO_ID).components[0].name).toBe('Ultrasonic sensor')
  })

  test('the original result stays reachable as historical data', () => {
    setActiveResult(NEWER)
    const resolved = resolveCatalogVideo(CATALOG)

    expect(resolved.catalogComponents).toEqual(CATALOG.components)
    expect(resolved.catalogComponents).toHaveLength(5)
  })

  test('an unpublished result never becomes active', () => {
    setActiveResult({ ...NEWER, published: false })
    expect(activeFor(VIDEO_ID)).toBeNull()
    expect(resolveCatalogVideo(CATALOG).activeSource).toBe(SOURCE_CATALOG)
  })

  test('an older shared result never displaces a newer one', () => {
    setActiveResult(NEWER)
    setActiveResult({ ...NEWER, components: [{ name: 'Stale', status: 'USED' }], extractedAt: '2020-01-01T00:00:00.000Z' })

    expect(activeFor(VIDEO_ID).components).toHaveLength(8)
  })

  test('6. matching is by canonical video id, not title or URL format', async () => {
    // The shared row carries a different title and a short-form URL.
    setActiveResult({
      ...NEWER,
      title: 'A COMPLETELY DIFFERENT TITLE',
      canonicalUrl: `https://youtu.be/${VIDEO_ID}`
    })

    const resolved = resolveCatalogVideo(CATALOG)
    expect(resolved.components).toHaveLength(8)
    // The catalog's own title is preserved; only components are resolved.
    expect(resolved.title).toBe(CATALOG.title)
  })
})

/* ========================================================================== */
/* 7. Every surface agrees                                                    */
/* ========================================================================== */

describe('7. all surfaces agree on the active result', () => {
  test('Home card chips and the detail table show the same active components', async () => {
    vi.mocked(listActiveExtractions).mockResolvedValue({ items: [NEWER] })

    const home = await mountAt(HomePage, '/')
    const card = home.find(`#video-card-${CATALOG.id}`)

    // 6 USED components -> 3 chips plus a "+3" overflow badge.
    expect(card.text()).toContain('Ultrasonic sensor')
    expect(card.find('.component-badge--more').text()).toBe('+3')
    expect(card.text()).toContain('Latest AI Extraction')

    const detail = await mountAt(VideoDetailPage, `/video/${CATALOG.id}`, { id: String(CATALOG.id) })
    const rows = detail.findAll('.components-table tbody tr')

    expect(rows).toHaveLength(NEWER.components.length)
    expect(detail.text()).toContain('Latest AI Extraction')
    for (const name of usedNames(NEWER.components)) {
      expect(detail.text()).toContain(name)
    }
  })

  test('the stale catalog list is no longer rendered anywhere', async () => {
    vi.mocked(listActiveExtractions).mockResolvedValue({ items: [NEWER] })

    const detail = await mountAt(VideoDetailPage, `/video/${CATALOG.id}`, { id: String(CATALOG.id) })
    const rows = detail.findAll('.components-table tbody tr')

    expect(rows).toHaveLength(8)
    expect(rows).not.toHaveLength(CATALOG.components.length)
  })

  test('the detail page reports the original count as historical, not current', async () => {
    vi.mocked(listActiveExtractions).mockResolvedValue({ items: [NEWER] })

    const detail = await mountAt(VideoDetailPage, `/video/${CATALOG.id}`, { id: String(CATALOG.id) })

    expect(detail.find('.detail__source-note').text()).toMatch(/original catalog result recorded/i)
    expect(detail.find('.detail__source-note').text()).toContain('5 components')
  })

  test('without a shared result every surface falls back to the catalog', async () => {
    vi.mocked(listActiveExtractions).mockResolvedValue({ items: [] })

    const detail = await mountAt(VideoDetailPage, `/video/${CATALOG.id}`, { id: String(CATALOG.id) })
    const rows = detail.findAll('.components-table tbody tr')

    expect(rows).toHaveLength(CATALOG.components.length)
    expect(detail.text()).toContain('Original Catalog')
    expect(detail.find('.detail__source-note').exists()).toBe(false)
  })

  test('7. search indexes the ACTIVE components', async () => {
    // "Buzzer" exists only in the newer extraction, not in the catalog entry.
    expect(usedNames(CATALOG.components)).not.toContain('Buzzer')

    vi.mocked(listActiveExtractions).mockResolvedValue({ items: [NEWER] })
    const home = await mountAt(HomePage, '/')

    await home.find('#search-input').setValue('Buzzer')
    await home.vm.$nextTick()

    const cards = home.findAll('.video-card')
    expect(cards).toHaveLength(1)
    expect(cards[0].attributes('id')).toBe(`video-card-${CATALOG.id}`)
  })

  test('10. all 20 catalog entries survive resolution, in order', () => {
    setActiveResult(NEWER)
    const resolved = resolveCatalog(videos)

    expect(resolved).toHaveLength(20)
    expect(resolved.map(v => v.id)).toEqual(videos.map(v => v.id))
    // No duplicate card for the re-extracted video.
    expect(resolved.filter(v => v.youtubeId === VIDEO_ID)).toHaveLength(1)
  })
})

/* ========================================================================== */
/* 3 & 4. Re-extraction                                                       */
/* ========================================================================== */

describe('re-extraction', () => {
  test('3. a successful Re-extract updates the active result without a page refresh', async () => {
    vi.mocked(listActiveExtractions).mockResolvedValue({ items: [] })

    const home = await mountAt(HomePage, '/')

    // Before: the card shows the original catalog result.
    let card = home.find(`#video-card-${CATALOG.id}`)
    expect(card.text()).not.toContain('Latest AI Extraction')
    // The catalog entry has 4 USED components: 3 chips plus "+1".
    expect(card.find('.component-badge--more').text()).toBe('+1')

    vi.mocked(extractComponents).mockResolvedValue({ ...NEWER, cached: false })
    await home.find('#youtube-url-input').setValue(`https://youtu.be/${VIDEO_ID}`)
    await home.find('.extract-btn').trigger('click')
    await flushPromises()

    // After: the same mounted component reflects the new result. No remount.
    card = home.find(`#video-card-${CATALOG.id}`)
    expect(card.text()).toContain('Latest AI Extraction')
    expect(card.find('.component-badge--more').text()).toBe('+3')
  })

  test('4. a failed Re-extract preserves the previous active result', async () => {
    setActiveResult(NEWER)
    vi.mocked(listActiveExtractions).mockResolvedValue({ items: [NEWER] })

    const home = await mountAt(HomePage, '/')
    expect(home.find(`#video-card-${CATALOG.id}`).text()).toContain('Latest AI Extraction')

    // Surface the result first so the Re-extract control is available.
    await home.find('#youtube-url-input').setValue(`https://youtu.be/${VIDEO_ID}`)
    await home.find('.extract-btn').trigger('click')
    await flushPromises()
    expect(extractComponents).not.toHaveBeenCalled()

    vi.mocked(extractComponents).mockRejectedValue(
      Object.assign(new Error('The model did not respond within 49s.'), { errorCode: 'timeout' })
    )

    // Re-extract forces a real run, which then fails.
    await home.find('.extract-results .btn').trigger('click')
    await flushPromises()

    expect(vi.mocked(extractComponents).mock.calls.at(-1)[0].force).toBe(true)

    // The error is shown, and the active result is untouched.
    expect(home.find('.progress').classes()).toContain('progress--error')
    expect(activeFor(VIDEO_ID).components).toHaveLength(8)
    expect(home.find(`#video-card-${CATALOG.id}`).text()).toContain('Latest AI Extraction')
  })

  test('4. an invalid or unpublishable result never becomes active', async () => {
    setActiveResult(NEWER)

    // An empty result must not wipe the active one.
    setActiveResult({ ...NEWER, components: [], componentCount: 0, extractedAt: '2027-01-01T00:00:00.000Z' })
    expect(activeFor(VIDEO_ID).components).toHaveLength(8)

    // Neither may an unpublished one.
    setActiveResult({ ...NEWER, published: false, components: [{ name: 'x', status: 'USED' }], extractedAt: '2027-01-01T00:00:00.000Z' })
    expect(activeFor(VIDEO_ID).components).toHaveLength(8)
  })
})

/* ========================================================================== */
/* 5. Local history must not mask a newer shared result                       */
/* ========================================================================== */

describe('5. local history never overrides a newer shared result', () => {
  const OLD_LOCAL = {
    videoId: VIDEO_ID,
    title: 'Ultrasonic Sensors with Arduino',
    components: [{ name: 'Arduino Uno', status: 'USED' }],
    source: 'youtube-url',
    specVersion: 'v1-test',
    extractedAt: '2026-01-01T00:00:00.000Z'
  }

  test('a superseded history entry shows the active list, keeping its own record', () => {
    setActiveResult(NEWER)
    const resolved = resolveHistoryEntry({ ...OLD_LOCAL })

    expect(resolved.components).toHaveLength(8)
    expect(resolved.supersededByShared).toBe(true)
    // The user's own record is untouched - no rewritten history.
    expect(resolved.historicalComponents).toHaveLength(1)
    expect(resolved.historicalExtractedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  test('a history entry NEWER than the shared result is left alone', () => {
    setActiveResult({ ...NEWER, extractedAt: '2020-01-01T00:00:00.000Z' })
    const resolved = resolveHistoryEntry({ ...OLD_LOCAL })

    expect(resolved.supersededByShared).toBe(false)
    expect(resolved.components).toHaveLength(1)
  })

  test('My Extractions cards show the active count', async () => {
    history.save(OLD_LOCAL, { originalUrl: `https://youtu.be/${VIDEO_ID}` })
    vi.mocked(listActiveExtractions).mockResolvedValue({ items: [NEWER] })

    const page = await mountAt(MyExtractionsPage, '/my-extractions')
    const card = page.find('.extraction-card')

    expect(card.text()).toContain('8 components')
    expect(card.text()).not.toContain('1 components')
  })

  test('9. opening a saved result never triggers an extraction', async () => {
    const saved = history.save(OLD_LOCAL, { originalUrl: `https://youtu.be/${VIDEO_ID}` })
    vi.mocked(listActiveExtractions).mockResolvedValue({ items: [NEWER] })

    const detail = await mountAt(
      ExtractionDetailPage,
      `/my-extractions/${saved.id}`,
      { mode: 'local' }
    )

    expect(extractComponents).not.toHaveBeenCalled()
    expect(detail.findAll('.components-table tbody tr')).toHaveLength(8)
    expect(detail.find('.detail__superseded').text()).toMatch(/your own run/i)
    expect(detail.find('.detail__superseded').text()).toContain('1 components')
  })

  test('5. a stale local entry cannot reintroduce an outdated result on Home', async () => {
    history.save(OLD_LOCAL, { originalUrl: `https://youtu.be/${VIDEO_ID}` })
    vi.mocked(listActiveExtractions).mockResolvedValue({ items: [NEWER] })

    const home = await mountAt(HomePage, '/')

    await home.find('#youtube-url-input').setValue(`https://youtu.be/${VIDEO_ID}`)
    await home.find('.extract-btn').trigger('click')
    await flushPromises()

    // Served from the newer shared result, with no model call.
    expect(extractComponents).not.toHaveBeenCalled()
    expect(home.find('.extract-results').findAll('tbody tr')).toHaveLength(8)
    expect(home.find('.extract-results__note').text()).toMatch(/latest shared extraction/i)
  })
})

/* ========================================================================== */
/* 9. Reads never cost a model call                                           */
/* ========================================================================== */

describe('9. viewing never triggers an extraction', () => {
  test('resolution uses one batched read for the whole catalog', async () => {
    vi.mocked(listActiveExtractions).mockResolvedValue({ items: [] })

    await mountAt(HomePage, '/')

    expect(listActiveExtractions).toHaveBeenCalledTimes(1)
    expect(vi.mocked(listActiveExtractions).mock.calls[0][0]).toHaveLength(20)
    expect(extractComponents).not.toHaveBeenCalled()
  })

  test('a second page does not repeat the lookup for ids already known', async () => {
    vi.mocked(listActiveExtractions).mockResolvedValue({ items: [NEWER] })

    await mountAt(HomePage, '/')
    expect(listActiveExtractions).toHaveBeenCalledTimes(1)

    await mountAt(VideoDetailPage, `/video/${CATALOG.id}`, { id: String(CATALOG.id) })
    expect(listActiveExtractions).toHaveBeenCalledTimes(1)
  })

  test('a library outage falls back to the catalog rather than breaking the page', async () => {
    vi.mocked(listActiveExtractions).mockRejectedValue(new Error('library unreachable'))

    const home = await mountAt(HomePage, '/')

    expect(home.findAll('.video-card')).toHaveLength(20)
    const card = home.find(`#video-card-${CATALOG.id}`)
    expect(card.text()).not.toContain('Latest AI Extraction')
  })

  test('ensureActiveResults is a no-op without ids', async () => {
    await ensureActiveResults([])
    expect(listActiveExtractions).not.toHaveBeenCalled()
  })
})
