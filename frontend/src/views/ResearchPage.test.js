import { describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'

import ResearchPage from './ResearchPage.vue'
import routerConfig from '../router/index.js'

/** Published corpus-level results. Any drift from these must fail loudly. */
const PUBLISHED = {
  'Gemini 3 Flash': { precision: '0.907', recall: '0.962', f1: '0.933' },
  'GPT-5': { precision: '0.905', recall: '0.870', f1: '0.887' },
  'Claude Opus 4.7': { precision: '0.882', recall: '0.855', f1: '0.868' }
}

const ARTIFACT_LINKS = [
  'https://doi.org/10.1145/3832783.3834647',
  'https://doi.org/10.5281/zenodo.20134482',
  'https://doi.org/10.5281/zenodo.20135165',
  'https://github.com/ahmedbahaj/IoTutorMine',
  'https://www.youtube.com/watch?v=1H3GgQFjfZU'
]

async function mountPage() {
  const router = createRouter({
    history: createWebHistory('/IoTutorMine/'),
    routes: routerConfig.options.routes
  })
  await router.push('/research')
  await router.isReady()
  return mount(ResearchPage, { global: { plugins: [router] } })
}

describe('Research page — content', () => {
  test('uses the official page and paper titles', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('.research__title').text()).toBe('Research & Results')
    expect(wrapper.find('.paper__title').text()).toBe(
      'IoTutorMine: A Tool for Mining Hardware Bills of Materials from IoT Tutorial Videos'
    )
  })

  test('credits all three authors in the published order', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('.paper__authors').text()).toBe(
      'Abdullah A. Alahmadi, Ahmed O. Bahaj, and Mohammad D. Alahmadi'
    )
  })

  test('describes the three-phase pipeline in order', async () => {
    const wrapper = await mountPage()
    const names = wrapper.findAll('.pipeline__name').map(n => n.text())
    expect(names).toEqual([
      'Transcript Acquisition',
      'Transcript Preparation',
      'Zero-shot LLM Extraction'
    ])
  })

  test('states every published benchmark fact', async () => {
    const wrapper = await mountPage()
    const text = wrapper.text()

    const values = wrapper.findAll('.stat__value').map(v => v.text())
    expect(values).toEqual(['20', '131', '16'])

    expect(text).toContain('YouTube IoT tutorials')
    expect(text).toContain('ground-truth components')
    expect(text).toContain('distinct creators')
    expect(text).toContain('Arduino and Raspberry Pi')
    expect(text).toContain('Beginner and intermediate')
  })
})

describe('Research page — results fidelity', () => {
  test('the table reproduces every published value to three decimals', async () => {
    const wrapper = await mountPage()
    const rows = wrapper.findAll('.results-table tbody tr')

    expect(rows).toHaveLength(3)

    for (const row of rows) {
      const model = row.find('th').text().replace('used by this tool', '').trim()
      const expected = PUBLISHED[model]
      expect(expected, `unexpected model row: ${model}`).toBeDefined()

      const cells = row.findAll('td').map(c => c.text())
      expect(cells, `values for ${model}`).toEqual([
        expected.precision,
        expected.recall,
        expected.f1
      ])
    }
  })

  test('models appear in descending F1 order', async () => {
    const wrapper = await mountPage()
    const f1s = wrapper
      .findAll('.results-table tbody tr')
      .map(r => Number(r.findAll('td')[2].text()))

    expect(f1s).toEqual([...f1s].sort((a, b) => b - a))
  })

  test('Gemini 3 Flash is marked as the model this tool uses', async () => {
    const wrapper = await mountPage()
    const rows = wrapper.findAll('.results-table tbody tr')
    const tagged = rows.filter(r => r.find('.tag').exists())

    expect(tagged).toHaveLength(1)
    expect(tagged[0].find('th').text()).toContain('Gemini 3 Flash')
  })

  test('every bar is directly labelled, so identity is never colour-alone', async () => {
    const wrapper = await mountPage()
    const bars = wrapper.findAll('.chart__bar')
    const values = wrapper.findAll('.chart__value')

    // 3 models x 3 metrics
    expect(bars).toHaveLength(9)
    expect(values).toHaveLength(9)
  })

  test('bars are anchored at zero — the axis is never truncated', async () => {
    const wrapper = await mountPage()
    const ticks = wrapper.findAll('.chart__axis-tick').map(t => t.text())

    expect(ticks[0]).toBe('0.00')
    expect(ticks.at(-1)).toBe('1.00')

    // A bar's width must equal its value as a percentage of a 0–1 scale.
    const firstBar = wrapper.find('.chart__bar')
    expect(firstBar.attributes('style')).toContain('width: 90.7%')
  })

  test('the chart exposes a text summary for assistive technology', async () => {
    const wrapper = await mountPage()
    const chart = wrapper.find('.chart')

    expect(chart.attributes('role')).toBe('img')
    const label = chart.attributes('aria-label')
    expect(label).toContain('Gemini 3 Flash')
    expect(label).toContain('0.933')
  })
})

describe('Research page — scientific accuracy guards', () => {
  test('never claims the live web API was benchmarked', async () => {
    const wrapper = await mountPage()
    const text = wrapper.text()

    // The distinction between the published experiment and this website must
    // be stated explicitly.
    expect(text).toMatch(/not.*a measurement of this website/i)
    expect(text).toMatch(/never part of the benchmark/i)
    expect(text).toMatch(/model output, not verified ground truth/i)
  })

  test('attributes the scores to the published experiment, not to production', async () => {
    const wrapper = await mountPage()
    const callout = wrapper.find('.callout')

    expect(callout.exists()).toBe(true)
    expect(callout.text()).toMatch(/controlled experiment/i)
    expect(callout.text()).toMatch(/20-video ground-truth benchmark/i)
  })

  test('describes extraction as zero-shot and component-oriented', async () => {
    const wrapper = await mountPage()
    const text = wrapper.text()

    expect(text).toMatch(/zero-shot/i)
    expect(text).toMatch(/shoppable hardware components/i)
    expect(text).toContain('USED')
    expect(text).toContain('ALTERNATIVE')
  })

  test('states that the published values come from the camera-ready paper', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('.note').text()).toMatch(/camera-ready ASE 2026 paper/i)
  })
})

describe('Research page — artifacts', () => {
  test('links to every artifact, with the exact published URLs', async () => {
    const wrapper = await mountPage()
    const hrefs = wrapper.findAll('.artifact').map(a => a.attributes('href'))

    expect(hrefs).toEqual(ARTIFACT_LINKS)
  })

  test('the unresolved ACM DOI is labelled pending, not presented as live', async () => {
    const wrapper = await mountPage()
    const paperCard = wrapper
      .findAll('.artifact')
      .find(a => a.attributes('href') === 'https://doi.org/10.1145/3832783.3834647')

    expect(paperCard).toBeDefined()
    const pending = paperCard.find('.artifact__pending')
    expect(pending.exists()).toBe(true)
    expect(pending.text()).toMatch(/activates on publication|not yet resolving/i)

    // The resolving artifacts carry no such caveat.
    for (const a of wrapper.findAll('.artifact')) {
      if (a.attributes('href').includes('zenodo') || a.attributes('href').includes('github')) {
        expect(a.find('.artifact__pending').exists()).toBe(false)
      }
    }
  })

  test('points at the original repository, never a fork', async () => {
    const wrapper = await mountPage()
    const hrefs = wrapper.findAll('.artifact').map(a => a.attributes('href'))

    expect(hrefs).toContain('https://github.com/ahmedbahaj/IoTutorMine')
    for (const href of hrefs) {
      expect(href).not.toContain('abdullah-t1d')
    }
  })

  test('external links open safely in a new tab', async () => {
    const wrapper = await mountPage()

    for (const link of wrapper.findAll('.artifact')) {
      expect(link.attributes('target')).toBe('_blank')
      expect(link.attributes('rel')).toContain('noopener')
      expect(link.attributes('rel')).toContain('noreferrer')
    }
  })

  test('uses only the two published Zenodo DOIs', async () => {
    const wrapper = await mountPage()
    const zenodo = wrapper
      .findAll('.artifact')
      .map(a => a.attributes('href'))
      .filter(h => h.includes('zenodo'))

    expect(zenodo).toEqual([
      'https://doi.org/10.5281/zenodo.20134482',
      'https://doi.org/10.5281/zenodo.20135165'
    ])
  })
})

describe('Research page — integration with the rest of the app', () => {
  test('is reachable at a stable /research route', async () => {
    const resolved = routerConfig.resolve('/research')
    expect(resolved.name).toBe('Research')
    expect(resolved.href).toBe('/IoTutorMine/research')
  })

  test('is frontend-only — it renders with no network access at all', async () => {
    const original = globalThis.fetch
    globalThis.fetch = () => {
      throw new Error('the Research page must not make any network request')
    }

    try {
      const wrapper = await mountPage()
      expect(wrapper.find('.research__title').exists()).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })
})
