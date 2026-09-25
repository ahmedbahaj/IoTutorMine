import { describe, expect, test, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import NavBar from './NavBar.vue'
import routerConfig from '../router/index.js'

const EXPECTED = ['Home', 'My Extractions', 'All Extractions', 'Research']

function makeRouter() {
  // Rebuild from the real route table so the test fails if a route is removed.
  return createRouter({
    history: createWebHistory('/IoTutorMine/'),
    routes: routerConfig.options.routes
  })
}

async function mountNav(path = '/') {
  const router = makeRouter()
  await router.push(path)
  await router.isReady()

  const wrapper = mount(NavBar, { global: { plugins: [router] } })
  return { wrapper, router }
}

describe('NavBar', () => {
  test('2. shows exactly the four primary navigation items on desktop', async () => {
    const { wrapper } = await mountNav()
    const labels = wrapper.findAll('.navbar-links .nav-link').map(l => l.text())
    expect(labels).toEqual(EXPECTED)
  })

  test('20. the same four items are present in the mobile menu', async () => {
    const { wrapper } = await mountNav()
    const labels = wrapper.findAll('.navbar-mobile .nav-link').map(l => l.text())
    expect(labels).toEqual(EXPECTED)
  })

  test('20. the mobile toggle opens and closes the menu and reports its state', async () => {
    const { wrapper } = await mountNav()
    const toggle = wrapper.find('.navbar-toggle')

    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('.navbar-mobile').classes()).not.toContain('open')

    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('.navbar-mobile').classes()).toContain('open')

    await toggle.trigger('click')
    expect(wrapper.find('.navbar-mobile').classes()).not.toContain('open')
  })

  test('20. the mobile menu closes after navigating', async () => {
    const { wrapper, router } = await mountNav()

    await wrapper.find('.navbar-toggle').trigger('click')
    expect(wrapper.find('.navbar-mobile').classes()).toContain('open')

    await router.push('/extractions')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.navbar-mobile').classes()).not.toContain('open')
  })

  test('every navigation item points at a route that actually resolves', async () => {
    const { router } = await mountNav()

    for (const path of ['/', '/my-extractions', '/extractions', '/research']) {
      const resolved = router.resolve(path)
      expect(resolved.matched.length, `no route matched ${path}`).toBeGreaterThan(0)
    }
  })

  test('Home is only highlighted on Home, and the others on their detail pages', async () => {
    const active = async path => {
      const { wrapper } = await mountNav(path)
      return wrapper
        .findAll('.navbar-links .nav-link')
        .filter(l => l.classes().includes('nav-link--active'))
        .map(l => l.text())
    }

    expect(await active('/')).toEqual(['Home'])
    expect(await active('/my-extractions')).toEqual(['My Extractions'])
    expect(await active('/my-extractions/abc')).toEqual(['My Extractions'])
    expect(await active('/extractions')).toEqual(['All Extractions'])
    expect(await active('/extractions/KGwtit2bFyo')).toEqual(['All Extractions'])
    expect(await active('/research')).toEqual(['Research'])

    // The curated catalog pages must not light up any of the three.
    expect(await active('/video/1')).toEqual([])
  })
})
