import { describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import router from './index.js'
import VideoDetailPage from '../views/VideoDetailPage.vue'
import { videos } from '../data/videos.js'

const read = relative =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

/** Pull the first inline <script> body out of an HTML file. */
function inlineScript(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/)
  if (!match) throw new Error('no inline script found')
  return match[1]
}

describe('routes', () => {
  test('2/21. every route resolves to a component, including the deep ones', () => {
    const cases = [
      ['/', 'Home'],
      ['/video/1', 'VideoDetail'],
      ['/my-extractions', 'MyExtractions'],
      ['/my-extractions/abc-123', 'MyExtractionDetail'],
      ['/extractions', 'AllExtractions'],
      ['/extractions/KGwtit2bFyo', 'SharedExtractionDetail'],
      ['/research', 'Research']
    ]

    for (const [path, name] of cases) {
      const resolved = router.resolve(path)
      expect(resolved.name, `${path} should resolve to ${name}`).toBe(name)
      expect(resolved.matched.length).toBeGreaterThan(0)
    }
  })

  test('21. the router base matches the GitHub Pages project path', () => {
    expect(router.resolve('/extractions').href).toBe('/IoTutorMine/extractions')
  })

  test('an unknown path falls back to Home rather than rendering nothing', () => {
    expect(router.resolve('/no/such/page').matched.length).toBeGreaterThan(0)
  })

  test('2. an existing catalog video still renders its detail page', async () => {
    const testRouter = createRouter({
      history: createWebHistory('/IoTutorMine/'),
      routes: router.options.routes
    })
    await testRouter.push('/video/1')
    await testRouter.isReady()

    const wrapper = mount(VideoDetailPage, {
      props: { id: '1' },
      global: { plugins: [testRouter] }
    })

    const video = videos.find(v => v.id === 1)
    expect(wrapper.find('.detail__title').text()).toBe(video.title)
    expect(wrapper.find('iframe').attributes('src')).toContain(video.youtubeId)
    expect(wrapper.findAll('.status-badge--used').length).toBeGreaterThan(0)
  })
})

describe('21. GitHub Pages SPA fallback', () => {
  /**
   * Replays the real 404.html redirect and the real index.html restore against
   * a stubbed location, asserting a deep link survives the round trip. This
   * reads the shipped files, so the two halves cannot drift apart.
   */
  function roundTrip(pathname, search = '', hash = '') {
    // --- 404.html: encode the requested path into the query string ---
    let redirected = null
    const fakeWindow = {
      location: {
        protocol: 'https:',
        hostname: 'abdullah-t1d.github.io',
        port: '',
        pathname,
        search,
        hash,
        replace(url) { redirected = url }
      }
    }

    new Function('window', inlineScript(read('../../public/404.html')))(fakeWindow)
    expect(redirected, 'the 404 page must redirect').toBeTruthy()

    // --- index.html: decode it back into a real path ---
    const bounced = new URL(redirected)
    let restored = null
    const appWindow = {
      location: {
        pathname: bounced.pathname,
        search: bounced.search,
        hash: bounced.hash
      },
      history: {
        replaceState(_state, _title, url) { restored = url }
      }
    }

    new Function('window', inlineScript(read('../../index.html')))(appWindow)
    return { redirected, restored }
  }

  test('a deep shared-extraction link survives a hard refresh', () => {
    const { redirected, restored } = roundTrip('/IoTutorMine/extractions/KGwtit2bFyo')

    expect(redirected).toContain('/IoTutorMine/?/extractions/KGwtit2bFyo')
    expect(restored).toBe('/IoTutorMine/extractions/KGwtit2bFyo')
    expect(router.resolve(restored.replace('/IoTutorMine', '')).name)
      .toBe('SharedExtractionDetail')
  })

  test('the Research route survives a hard refresh', () => {
    const { restored } = roundTrip('/IoTutorMine/research')
    expect(restored).toBe('/IoTutorMine/research')
    expect(router.resolve('/research').name).toBe('Research')
  })

  test('an existing catalog deep link also survives', () => {
    const { restored } = roundTrip('/IoTutorMine/video/3')
    expect(restored).toBe('/IoTutorMine/video/3')
  })

  test('a query string is preserved across the bounce', () => {
    const { restored } = roundTrip('/IoTutorMine/extractions', '?q=dht11')
    expect(restored).toBe('/IoTutorMine/extractions?q=dht11')
  })

  test('the restore script leaves an ordinary URL untouched', () => {
    let called = false
    const appWindow = {
      location: { pathname: '/IoTutorMine/', search: '?q=dht11', hash: '' },
      history: { replaceState() { called = true } }
    }

    new Function('window', inlineScript(read('../../index.html')))(appWindow)
    expect(called).toBe(false)
  })
})
