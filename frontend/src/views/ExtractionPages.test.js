import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'

import AllExtractionsPage from './AllExtractionsPage.vue'
import MyExtractionsPage from './MyExtractionsPage.vue'
import ExtractionDetailPage from './ExtractionDetailPage.vue'
import routerConfig from '../router/index.js'
import { createHistory, history } from '../services/history.js'
import { resetActiveResults } from '../services/activeResults.js'
import { listPublicExtractions, getPublicExtraction } from '../services/extract.js'

vi.mock('../services/extract.js', () => ({
  extractComponents: vi.fn(),
  listPublicExtractions: vi.fn(),
  getPublicExtraction: vi.fn(),
  listActiveExtractions: vi.fn(async () => ({ items: [] })),
  ApiError: class ApiError extends Error {}
}))

const item = (videoId, title, components, extras = {}) => ({
  sharedId: `shared-${videoId}`,
  videoId,
  canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  title,
  channel: 'Some Channel',
  durationSeconds: 742,
  thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
  components,
  componentCount: components.length,
  published: true,
  extractedAt: '2026-01-01T00:00:00.000Z',
  ...extras
})

const DHT = item('OogldLc9uYc', 'DHT11 Temperature Sensor Tutorial', [
  { name: 'Arduino Uno', status: 'USED' },
  { name: 'DHT11', status: 'USED' },
  { name: 'DHT22', status: 'ALTERNATIVE', alternativeTo: 'DHT11' }
])

const ULTRASONIC = item('KGwtit2bFyo', 'Ultrasonic Sensors with Arduino', [
  { name: 'HC-SR04', status: 'USED' }
])

function makeRouter() {
  return createRouter({
    history: createWebHistory('/IoTutorMine/'),
    routes: routerConfig.options.routes
  })
}

async function mountAt(component, path, props = {}) {
  const router = makeRouter()
  await router.push(path)
  await router.isReady()

  const wrapper = mount(component, { props, global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router }
}

beforeEach(() => {
  resetActiveResults()
  localStorage.clear()
  vi.mocked(listPublicExtractions).mockReset()
  vi.mocked(getPublicExtraction).mockReset()
})

afterEach(() => localStorage.clear())

/* -------------------------------------------------------------------------- */

describe('All Extractions', () => {
  test('10. renders the shared library as cards with title, duration, and counts', async () => {
    vi.mocked(listPublicExtractions).mockResolvedValue({
      items: [DHT, ULTRASONIC],
      hasMore: false
    })

    const { wrapper } = await mountAt(AllExtractionsPage, '/extractions')
    const cards = wrapper.findAll('.extraction-card')

    expect(cards).toHaveLength(2)
    expect(cards[0].text()).toContain('DHT11 Temperature Sensor Tutorial')
    expect(cards[0].text()).toContain('3 components')
    expect(cards[0].text()).toContain('12:22') // 742 seconds
    expect(cards[0].text()).toContain('Jan 1, 2026')
    expect(cards[0].find('img').attributes('src')).toContain('OogldLc9uYc')
  })

  test('shows a loading state, then results', async () => {
    let resolve
    vi.mocked(listPublicExtractions).mockReturnValue(new Promise(r => { resolve = r }))

    const router = makeRouter()
    await router.push('/extractions')
    const wrapper = mount(AllExtractionsPage, { global: { plugins: [router] } })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.page__state').text()).toMatch(/loading/i)

    resolve({ items: [DHT], hasMore: false })
    await flushPromises()

    expect(wrapper.findAll('.extraction-card')).toHaveLength(1)
  })

  test('shows a useful empty state', async () => {
    vi.mocked(listPublicExtractions).mockResolvedValue({ items: [], hasMore: false })

    const { wrapper } = await mountAt(AllExtractionsPage, '/extractions')
    expect(wrapper.find('.page__state').text()).toMatch(/no shared extractions yet/i)
  })

  test('shows an error state with a retry that actually retries', async () => {
    vi.mocked(listPublicExtractions).mockRejectedValueOnce(
      new Error('The shared extraction library is not configured yet.')
    )

    const { wrapper } = await mountAt(AllExtractionsPage, '/extractions')
    expect(wrapper.find('.page__notice').text()).toMatch(/not configured yet/i)

    vi.mocked(listPublicExtractions).mockResolvedValueOnce({ items: [DHT], hasMore: false })
    await wrapper.find('.page__notice .btn').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.extraction-card')).toHaveLength(1)
  })

  test('19. searching by component name queries the backend and keeps it in the URL', async () => {
    vi.mocked(listPublicExtractions).mockResolvedValue({ items: [DHT, ULTRASONIC], hasMore: false })

    const { wrapper, router } = await mountAt(AllExtractionsPage, '/extractions')

    vi.mocked(listPublicExtractions).mockResolvedValue({ items: [DHT], hasMore: false })
    await wrapper.find('#all-extractions-search').setValue('DHT11')
    await wrapper.find('.page__toolbar .btn').trigger('click')
    await flushPromises()

    const lastCall = vi.mocked(listPublicExtractions).mock.calls.at(-1)[0]
    expect(lastCall.q).toBe('DHT11')
    expect(lastCall.offset).toBe(0)

    expect(wrapper.findAll('.extraction-card')).toHaveLength(1)
    // 8. a stable route: the search survives a refresh and Back/Forward.
    expect(router.currentRoute.value.query.q).toBe('DHT11')
  })

  test('19. a search with no matches reports the term back to the user', async () => {
    vi.mocked(listPublicExtractions).mockResolvedValue({ items: [], hasMore: false })

    const { wrapper } = await mountAt(AllExtractionsPage, '/extractions?q=raspberry')
    expect(wrapper.find('.page__state').text()).toContain('raspberry')
  })

  test('8. results are paginated and never loaded all at once', async () => {
    vi.mocked(listPublicExtractions).mockResolvedValueOnce({ items: [DHT], hasMore: true })

    const { wrapper } = await mountAt(AllExtractionsPage, '/extractions')
    expect(wrapper.find('.page__more').exists()).toBe(true)
    expect(vi.mocked(listPublicExtractions).mock.calls[0][0].limit).toBe(24)

    vi.mocked(listPublicExtractions).mockResolvedValueOnce({ items: [ULTRASONIC], hasMore: false })
    await wrapper.find('.page__more .btn').trigger('click')
    await flushPromises()

    expect(vi.mocked(listPublicExtractions).mock.calls[1][0].offset).toBe(1)
    expect(wrapper.findAll('.extraction-card')).toHaveLength(2)
    expect(wrapper.find('.page__more').exists()).toBe(false)
  })

  test('cards link to a stable shared detail route', async () => {
    vi.mocked(listPublicExtractions).mockResolvedValue({ items: [DHT], hasMore: false })

    const { wrapper } = await mountAt(AllExtractionsPage, '/extractions')
    expect(wrapper.find('.extraction-card').attributes('href')).toContain(
      '/IoTutorMine/extractions/OogldLc9uYc'
    )
  })
})

/* -------------------------------------------------------------------------- */

describe('My Extractions', () => {
  const saved = {
    videoId: 'KGwtit2bFyo',
    canonicalUrl: 'https://www.youtube.com/watch?v=KGwtit2bFyo',
    title: 'Ultrasonic Sensors with Arduino',
    durationSeconds: 742,
    thumbnail: 'https://img.youtube.com/vi/KGwtit2bFyo/hqdefault.jpg',
    components: [
      { name: 'Arduino Uno', status: 'USED' },
      { name: 'RGBDuino', status: 'ALTERNATIVE', alternativeTo: 'Arduino Uno' }
    ],
    specVersion: 'v1-test',
    source: 'youtube-url',
    extractedAt: '2026-01-01T00:00:00.000Z'
  }

  test('8. each saved extraction shows thumbnail, title, duration, date, and count', async () => {
    history.save(saved, { originalUrl: 'https://youtu.be/KGwtit2bFyo' })

    const { wrapper } = await mountAt(MyExtractionsPage, '/my-extractions')
    const card = wrapper.find('.extraction-card')

    expect(card.exists()).toBe(true)
    expect(card.find('img').attributes('src')).toContain('KGwtit2bFyo')
    expect(card.text()).toContain('Ultrasonic Sensors with Arduino')
    expect(card.text()).toContain('12:22')
    expect(card.text()).toContain('Jan 1, 2026')
    expect(card.text()).toContain('2 components')
    expect(card.text()).toContain('Open Result')
  })

  test('shows an empty state when nothing has been extracted', async () => {
    const { wrapper } = await mountAt(MyExtractionsPage, '/my-extractions')
    expect(wrapper.find('.page__empty').text()).toMatch(/haven't extracted any videos/i)
    expect(wrapper.findAll('.extraction-card')).toHaveLength(0)
  })

  test('is explicit that history is local to this browser', async () => {
    const { wrapper } = await mountAt(MyExtractionsPage, '/my-extractions')
    expect(wrapper.find('.page__subtitle').text()).toMatch(/not synced across browsers or devices/i)
  })

  test('filters saved extractions by title and by component name', async () => {
    history.save(saved)
    history.save({ ...saved, videoId: 'OogldLc9uYc', title: 'DHT11 Tutorial',
      components: [{ name: 'DHT11', status: 'USED' }] })

    const { wrapper } = await mountAt(MyExtractionsPage, '/my-extractions')
    expect(wrapper.findAll('.extraction-card')).toHaveLength(2)

    await wrapper.find('#my-extractions-search').setValue('dht11')
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.extraction-card')).toHaveLength(1)

    await wrapper.find('#my-extractions-search').setValue('ultrasonic')
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.extraction-card')).toHaveLength(1)
  })

  test('9. corrupted storage does not break the page', async () => {
    localStorage.setItem('iotutormine.extractions.v1', 'not json at all')

    const { wrapper } = await mountAt(MyExtractionsPage, '/my-extractions')
    expect(wrapper.find('.page__empty').exists()).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */

describe('Extraction detail', () => {
  test('8. opening a saved result shows the complete bill of materials with badges', async () => {
    const record = history.save({
      videoId: 'KGwtit2bFyo',
      canonicalUrl: 'https://www.youtube.com/watch?v=KGwtit2bFyo',
      title: 'Ultrasonic Sensors with Arduino',
      durationSeconds: 742,
      components: [
        { name: 'Arduino Uno', status: 'USED' },
        { name: 'RGBDuino', status: 'ALTERNATIVE', alternativeTo: 'Arduino Uno' },
        { name: 'Jumper Wires', status: 'USED' }
      ],
      specVersion: 'v1-test',
      source: 'youtube-url'
    })

    const { wrapper } = await mountAt(
      ExtractionDetailPage,
      `/my-extractions/${record.id}`,
      { mode: 'local' }
    )

    expect(wrapper.find('.detail__title').text()).toBe('Ultrasonic Sensors with Arduino')
    expect(wrapper.findAll('.status-badge--used')).toHaveLength(2)
    expect(wrapper.findAll('.status-badge--alt')).toHaveLength(1)
    expect(wrapper.text()).toContain('RGBDuino')
    expect(wrapper.find('iframe').attributes('src')).toContain('KGwtit2bFyo')
    expect(wrapper.find('.detail__link').attributes('href')).toBe(
      'https://www.youtube.com/watch?v=KGwtit2bFyo'
    )
  })

  test('a missing local entry is reported rather than rendering blank', async () => {
    const { wrapper } = await mountAt(
      ExtractionDetailPage,
      '/my-extractions/does-not-exist',
      { mode: 'local' }
    )

    expect(wrapper.find('.detail__not-found').text()).toMatch(/no longer in this browser/i)
  })

  test('11. a shared result opens by video id, as another browser would see it', async () => {
    vi.mocked(getPublicExtraction).mockResolvedValue(DHT)

    const { wrapper } = await mountAt(
      ExtractionDetailPage,
      '/extractions/OogldLc9uYc',
      { mode: 'shared' }
    )

    expect(vi.mocked(getPublicExtraction).mock.calls[0][0]).toBe('OogldLc9uYc')
    expect(wrapper.find('.detail__title').text()).toBe('DHT11 Temperature Sensor Tutorial')
    expect(wrapper.findAll('.status-badge--used')).toHaveLength(2)
    expect(wrapper.findAll('.status-badge--alt')).toHaveLength(1)
    expect(wrapper.find('iframe').attributes('src')).toContain('OogldLc9uYc')
    expect(wrapper.text()).toMatch(/not independently verified/i)
  })

  test('a shared result that does not exist shows a clear message', async () => {
    vi.mocked(getPublicExtraction).mockResolvedValue(null)

    const { wrapper } = await mountAt(
      ExtractionDetailPage,
      '/extractions/KGwtit2bFyo',
      { mode: 'shared' }
    )

    expect(wrapper.find('.detail__not-found').text()).toMatch(/no published extraction/i)
  })

  test('8. navigating between shared entries re-fetches (Back/Forward works)', async () => {
    vi.mocked(getPublicExtraction).mockResolvedValue(DHT)

    const { wrapper, router } = await mountAt(
      ExtractionDetailPage,
      '/extractions/OogldLc9uYc',
      { mode: 'shared' }
    )
    expect(getPublicExtraction).toHaveBeenCalledTimes(1)

    vi.mocked(getPublicExtraction).mockResolvedValue(ULTRASONIC)
    await router.push('/extractions/KGwtit2bFyo')
    await flushPromises()

    expect(getPublicExtraction).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.detail__title').text()).toBe('Ultrasonic Sensors with Arduino')
  })

  test('17. a manual-transcript entry with no video id does not fake a player', async () => {
    const record = createHistory(localStorage).save({
      videoId: null,
      title: null,
      components: [{ name: 'Arduino Uno', status: 'USED' }],
      source: 'manual-transcript'
    })

    const { wrapper } = await mountAt(
      ExtractionDetailPage,
      `/my-extractions/${record.id}`,
      { mode: 'local' }
    )

    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.find('.detail__no-video').text()).toMatch(/manually pasted transcript/i)
    expect(wrapper.find('.detail__title').text()).toBe('Untitled video')
  })
})
