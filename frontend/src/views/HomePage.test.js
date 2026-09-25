import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'

import HomePage from './HomePage.vue'
import routerConfig from '../router/index.js'
import { videos } from '../data/videos.js'
import { STORAGE_KEY, createHistory } from '../services/history.js'
import { resetActiveResults } from '../services/activeResults.js'
import { extractComponents } from '../services/extract.js'

vi.mock('../services/extract.js', () => ({
  extractComponents: vi.fn(),
  listPublicExtractions: vi.fn(),
  getPublicExtraction: vi.fn(),
  listActiveExtractions: vi.fn(async () => ({ items: [] })),
  ApiError: class ApiError extends Error {}
}))

const VIDEO_ID = 'KGwtit2bFyo'
const URL_LONG = `https://www.youtube.com/watch?v=${VIDEO_ID}`

const RESULT = {
  videoId: VIDEO_ID,
  canonicalUrl: URL_LONG,
  title: 'DHT11 with Arduino Uno',
  channel: 'Surtrtech',
  durationSeconds: 742,
  thumbnail: `https://img.youtube.com/vi/${VIDEO_ID}/hqdefault.jpg`,
  components: [
    { name: 'Arduino Uno', status: 'USED' },
    { name: 'DHT11', status: 'USED' },
    { name: 'DHT22', status: 'ALTERNATIVE', alternativeTo: 'DHT11' }
  ],
  componentCount: 3,
  model: 'gemini-3-flash-preview',
  specVersion: 'v1-test',
  sharedId: 'shared-1',
  published: true,
  source: 'youtube-url',
  cached: false,
  extractedAt: '2026-01-01T00:00:00.000Z'
}

async function mountHome() {
  const router = createRouter({
    history: createWebHistory('/IoTutorMine/'),
    routes: routerConfig.options.routes
  })
  await router.push('/')
  await router.isReady()

  return mount(HomePage, { global: { plugins: [router] } })
}

/** Drive the form the way a user would. */
async function submit(wrapper, url) {
  await wrapper.find('#youtube-url-input').setValue(url)
  await wrapper.find('.extract-btn').trigger('click')
}

beforeEach(() => {
  resetActiveResults()
  localStorage.clear()
  vi.mocked(extractComponents).mockReset()
})

afterEach(() => {
  localStorage.clear()
})

describe('HomePage - existing catalog behaviour is preserved', () => {
  test('1. the curated research catalog still renders every video', async () => {
    const wrapper = await mountHome()
    expect(wrapper.findAll('.video-card')).toHaveLength(videos.length)
  })

  test('3. catalog search still filters by title, tag, component, and creator', async () => {
    const wrapper = await mountHome()
    const search = wrapper.find('#search-input')

    await search.setValue('DHT11')
    await wrapper.vm.$nextTick()
    const byComponent = wrapper.findAll('.video-card').length
    expect(byComponent).toBeGreaterThan(0)
    expect(byComponent).toBeLessThan(videos.length)

    await search.setValue('Robonyx')
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.video-card').length).toBeGreaterThan(0)

    await search.setValue('zzzz-no-such-video')
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.video-card')).toHaveLength(0)
    expect(wrapper.find('.home__empty').text()).toContain('zzzz-no-such-video')

    await search.setValue('')
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.video-card')).toHaveLength(videos.length)
  })

  test('10. community extractions are never mixed into the curated catalog', async () => {
    const wrapper = await mountHome()
    vi.mocked(extractComponents).mockResolvedValue(RESULT)

    await submit(wrapper, URL_LONG)
    await flushPromises()

    expect(wrapper.findAll('.video-card')).toHaveLength(videos.length)
  })
})

describe('HomePage - extraction feedback', () => {
  test('4/5. a successful extraction shows progress and finishes at 100%', async () => {
    let resolve
    vi.mocked(extractComponents).mockReturnValue(new Promise(r => { resolve = r }))

    const wrapper = await mountHome()
    await submit(wrapper, URL_LONG)

    // In flight: the bar is visible and below 100%.
    const inFlight = wrapper.find('[role="progressbar"]')
    expect(inFlight.exists()).toBe(true)
    expect(Number(inFlight.attributes('aria-valuenow'))).toBeLessThan(100)
    expect(wrapper.find('.extract-btn').attributes('disabled')).toBeDefined()

    resolve(RESULT)
    await flushPromises()

    expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('100')
    expect(wrapper.find('.progress').classes()).toContain('progress--done')
    expect(wrapper.find('.extract-btn').attributes('disabled')).toBeUndefined()
  })

  test('4. a duplicate submission while one is in flight is ignored', async () => {
    vi.mocked(extractComponents).mockReturnValue(new Promise(() => {}))

    const wrapper = await mountHome()
    await submit(wrapper, URL_LONG)
    await wrapper.find('.extract-btn').trigger('click')
    await wrapper.find('#youtube-url-input').trigger('keyup.enter')

    expect(extractComponents).toHaveBeenCalledTimes(1)
  })

  test('6. a failed extraction shows the error state and the message', async () => {
    vi.mocked(extractComponents).mockRejectedValue(new Error('Gemini quota exceeded'))

    const wrapper = await mountHome()
    await submit(wrapper, URL_LONG)
    await flushPromises()

    expect(wrapper.find('.progress').classes()).toContain('progress--error')
    expect(wrapper.text()).toContain('Gemini quota exceeded')
    expect(wrapper.find('.extract-results').exists()).toBe(false)
  })

  test('15. an invalid URL is refused client-side without calling the API', async () => {
    const wrapper = await mountHome()
    await submit(wrapper, 'https://example.com/not-youtube')
    await flushPromises()

    expect(extractComponents).not.toHaveBeenCalled()
    expect(wrapper.find('.extract-notice').text()).toMatch(/supported YouTube/i)
  })

  test('7. a transcript error reveals the manual transcript fallback, which then works', async () => {
    const error = Object.assign(new Error('No transcript available for this video.'), {
      needsTranscript: true
    })
    vi.mocked(extractComponents).mockRejectedValueOnce(error)

    const wrapper = await mountHome()
    await submit(wrapper, URL_LONG)
    await flushPromises()

    const textarea = wrapper.find('.manual-transcript__textarea')
    expect(textarea.exists()).toBe(true)

    vi.mocked(extractComponents).mockResolvedValueOnce({
      ...RESULT,
      source: 'manual-transcript',
      published: false
    })

    await textarea.setValue('we wire the dht11 to the arduino uno')
    await wrapper.find('.extract-btn').trigger('click')
    await flushPromises()

    expect(vi.mocked(extractComponents).mock.calls[1][0].transcript).toBe(
      'we wire the dht11 to the arduino uno'
    )
    expect(wrapper.find('.extract-results').exists()).toBe(true)
    expect(wrapper.find('.manual-transcript__textarea').exists()).toBe(false)
  })
})

describe('HomePage - results, history, and caching', () => {
  test('8. a successful result is rendered with USED and ALTERNATIVE badges', async () => {
    vi.mocked(extractComponents).mockResolvedValue(RESULT)

    const wrapper = await mountHome()
    await submit(wrapper, URL_LONG)
    await flushPromises()

    const table = wrapper.find('.extract-results')
    expect(table.text()).toContain('Arduino Uno')
    expect(table.text()).toContain('DHT11')
    expect(table.findAll('.status-badge--used')).toHaveLength(2)
    expect(table.findAll('.status-badge--alt')).toHaveLength(1)
    expect(table.text()).toContain('DHT22')
  })

  test('8/9. the result is saved to this browser and survives a remount', async () => {
    vi.mocked(extractComponents).mockResolvedValue(RESULT)

    const wrapper = await mountHome()
    await submit(wrapper, URL_LONG)
    await flushPromises()

    const stored = createHistory(localStorage).list()
    expect(stored).toHaveLength(1)
    expect(stored[0].videoId).toBe(VIDEO_ID)
    expect(stored[0].componentCount).toBe(3)

    // A reload: the raw bytes are still there and still readable.
    expect(localStorage.getItem(STORAGE_KEY)).toBeTruthy()
    expect(createHistory(localStorage).list()).toHaveLength(1)
  })

  test('the saved result is reachable from the result panel', async () => {
    vi.mocked(extractComponents).mockResolvedValue(RESULT)

    const wrapper = await mountHome()
    await submit(wrapper, URL_LONG)
    await flushPromises()

    const link = wrapper.findAll('.extract-results__link').map(l => l.attributes('href'))
    expect(link.some(h => h?.includes('/my-extractions/'))).toBe(true)
    expect(link.some(h => h?.includes(`/extractions/${VIDEO_ID}`))).toBe(true)
  })

  test('12. a video already in local history is reused with no network call at all', async () => {
    vi.mocked(extractComponents).mockResolvedValue(RESULT)

    const first = await mountHome()
    await submit(first, URL_LONG)
    await flushPromises()
    expect(extractComponents).toHaveBeenCalledTimes(1)

    // Same browser, a fresh visit, the same video via a different URL shape.
    const second = await mountHome()
    await submit(second, `https://youtu.be/${VIDEO_ID}`)
    await flushPromises()

    expect(extractComponents).toHaveBeenCalledTimes(1)
    expect(second.find('.extract-results').text()).toContain('Arduino Uno')
    expect(second.find('.extract-results__note').text()).toMatch(/already saved in this browser/i)
  })

  test('Re-extract explicitly bypasses the local cache and forces a new run', async () => {
    vi.mocked(extractComponents).mockResolvedValue(RESULT)

    const wrapper = await mountHome()
    await submit(wrapper, URL_LONG)
    await flushPromises()
    expect(extractComponents).toHaveBeenCalledTimes(1)

    await wrapper.find('.extract-results .btn').trigger('click')
    await flushPromises()

    expect(extractComponents).toHaveBeenCalledTimes(2)
    expect(vi.mocked(extractComponents).mock.calls[1][0].force).toBe(true)
  })

  test('a shared-cache hit is labelled so the user knows the model was not re-run', async () => {
    vi.mocked(extractComponents).mockResolvedValue({ ...RESULT, cached: true, cacheHit: 'shared' })

    const wrapper = await mountHome()
    await submit(wrapper, URL_LONG)
    await flushPromises()

    expect(wrapper.find('.extract-results__note').text()).toMatch(/shared extraction library/i)
  })

  test('a result with no components is treated as a failure, not an empty success', async () => {
    vi.mocked(extractComponents).mockResolvedValue({ ...RESULT, components: [] })

    const wrapper = await mountHome()
    await submit(wrapper, URL_LONG)
    await flushPromises()

    expect(wrapper.find('.progress').classes()).toContain('progress--error')
    expect(wrapper.find('.extract-results').exists()).toBe(false)
    expect(createHistory(localStorage).list()).toHaveLength(0)
  })
})
