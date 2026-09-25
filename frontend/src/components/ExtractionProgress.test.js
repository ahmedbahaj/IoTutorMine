import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ExtractionProgress from './ExtractionProgress.vue'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('ExtractionProgress', () => {
  test('4. renders nothing until an extraction starts', () => {
    const wrapper = mount(ExtractionProgress, { props: { phase: 'idle' } })
    expect(wrapper.find('.progress').exists()).toBe(false)
  })

  test('4. shows an accessible progress bar while running', async () => {
    const wrapper = mount(ExtractionProgress, { props: { phase: 'running' } })

    const bar = wrapper.find('[role="progressbar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('aria-valuemin')).toBe('0')
    expect(bar.attributes('aria-valuemax')).toBe('100')
    expect(bar.attributes('aria-label')).toMatch(/in progress/i)

    // A polite live region announces state without moving focus.
    const status = wrapper.find('[role="status"]')
    expect(status.attributes('aria-live')).toBe('polite')
  })

  test('4. the bar advances over time but never reaches 100% mid-flight', async () => {
    const wrapper = mount(ExtractionProgress, { props: { phase: 'running' } })

    await vi.advanceTimersByTimeAsync(3000)
    const early = Number(wrapper.find('[role="progressbar"]').attributes('aria-valuenow'))
    expect(early).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(60_000)
    const later = Number(wrapper.find('[role="progressbar"]').attributes('aria-valuenow'))

    expect(later).toBeGreaterThanOrEqual(early)
    expect(later).toBeLessThan(100)
  })

  test('4. a long-running request keeps the indicator active and explains itself', async () => {
    const wrapper = mount(ExtractionProgress, { props: { phase: 'running' } })

    await vi.advanceTimersByTimeAsync(90_000)

    expect(wrapper.find('.progress').exists()).toBe(true)
    expect(wrapper.find('.progress__message').text()).toMatch(/still processing/i)
  })

  test('5. only a confirmed success reaches 100%', async () => {
    const wrapper = mount(ExtractionProgress, {
      props: { phase: 'running', doneMessage: 'Extraction complete — 3 components found.' }
    })

    await vi.advanceTimersByTimeAsync(5000)
    expect(Number(wrapper.find('[role="progressbar"]').attributes('aria-valuenow'))).toBeLessThan(100)

    await wrapper.setProps({ phase: 'done' })

    expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('100')
    expect(wrapper.find('.progress__bar').attributes('style')).toContain('width: 100%')
    expect(wrapper.find('.progress__message').text()).toContain('3 components found')
    expect(wrapper.find('.progress').classes()).toContain('progress--done')
  })

  test('6. a failure shows a distinct error state carrying the message', async () => {
    const wrapper = mount(ExtractionProgress, {
      props: { phase: 'error', errorMessage: 'No transcript available for this video.' }
    })

    expect(wrapper.find('.progress').classes()).toContain('progress--error')
    expect(wrapper.text()).toContain('No transcript available for this video.')
    // The percentage is not shown for a failure - there is nothing to report.
    expect(wrapper.find('.progress__percent').exists()).toBe(false)
  })

  test('the interval is cleared when the phase leaves running and on unmount', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')

    const wrapper = mount(ExtractionProgress, { props: { phase: 'running' } })
    await vi.advanceTimersByTimeAsync(1000)

    await wrapper.setProps({ phase: 'done' })
    expect(clearSpy).toHaveBeenCalled()

    const before = vi.getTimerCount()
    wrapper.unmount()
    expect(vi.getTimerCount()).toBeLessThanOrEqual(before)
  })

  test('a restarted extraction resets the bar instead of resuming mid-way', async () => {
    const wrapper = mount(ExtractionProgress, { props: { phase: 'running' } })
    await vi.advanceTimersByTimeAsync(20_000)
    await wrapper.setProps({ phase: 'done' })
    await wrapper.setProps({ phase: 'idle' })
    await wrapper.setProps({ phase: 'running' })

    expect(Number(wrapper.find('[role="progressbar"]').attributes('aria-valuenow'))).toBe(0)
  })
})
