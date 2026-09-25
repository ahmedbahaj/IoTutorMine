<template>
  <div
    v-if="phase !== 'idle'"
    class="progress"
    :class="`progress--${phase}`"
  >
    <div class="progress__row">
      <span class="progress__message">{{ displayMessage }}</span>
      <span v-if="phase === 'running' || phase === 'done'" class="progress__percent">
        {{ Math.round(percent) }}%
      </span>
    </div>

    <div
      class="progress__track"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="Math.round(percent)"
      :aria-label="label"
    >
      <div class="progress__bar" :style="{ width: `${percent}%` }"></div>
    </div>

    <!-- Announced to assistive technology without stealing focus. -->
    <p class="visually-hidden" role="status" aria-live="polite">{{ label }}</p>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { estimateProgress, progressLabel, progressMessage } from '../services/progress.js'

const props = defineProps({
  /** 'idle' | 'running' | 'done' | 'error' */
  phase: { type: String, default: 'idle' },
  errorMessage: { type: String, default: '' },
  doneMessage: { type: String, default: 'Extraction complete.' }
})

const percent = ref(0)
const elapsed = ref(0)

let timer = null
let startedAt = 0

function stopTimer() {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

function startTimer() {
  stopTimer()
  startedAt = Date.now()
  elapsed.value = 0
  percent.value = 0

  timer = setInterval(() => {
    elapsed.value = Date.now() - startedAt
    // Monotonic: the estimate never moves backwards.
    percent.value = Math.max(percent.value, estimateProgress(elapsed.value))
  }, 200)
}

watch(
  () => props.phase,
  phase => {
    if (phase === 'running') {
      startTimer()
    } else if (phase === 'done') {
      stopTimer()
      // 100% only on a confirmed success.
      percent.value = 100
    } else {
      stopTimer()
      if (phase === 'idle') percent.value = 0
    }
  },
  { immediate: true }
)

onBeforeUnmount(stopTimer)

const displayMessage = computed(() => {
  if (props.phase === 'error') return props.errorMessage || 'Extraction failed.'
  if (props.phase === 'done') return props.doneMessage
  return progressMessage(elapsed.value)
})

const label = computed(() => {
  if (props.phase === 'error') return props.errorMessage || progressLabel('error', 0)
  if (props.phase === 'done') return props.doneMessage
  return progressLabel('running', percent.value)
})
</script>

<style scoped>
.progress {
  margin-top: var(--space-md);
  padding: 12px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}

.progress--done {
  border-color: #bfe5cb;
  background: #f4fbf6;
}

.progress--error {
  border-color: var(--color-warning-border);
  background: var(--color-warning-bg);
}

.progress__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-sm);
  margin-bottom: 8px;
}

.progress__message {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.progress--done .progress__message {
  color: var(--color-success);
  font-weight: 500;
}

.progress--error .progress__message {
  color: var(--color-warning-text);
  font-weight: 500;
}

.progress__percent {
  font-size: var(--font-size-sm);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-primary);
  flex-shrink: 0;
}

.progress__track {
  position: relative;
  height: 6px;
  width: 100%;
  border-radius: 999px;
  background: var(--color-border-light);
  overflow: hidden;
}

.progress__bar {
  height: 100%;
  border-radius: 999px;
  background: var(--color-accent);
  transition: width 0.25s ease-out, background-color 0.2s;
}

.progress--done .progress__bar {
  background: var(--color-success);
}

.progress--error .progress__bar {
  background: var(--color-warning-border);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .progress__bar {
    transition: none;
  }
}

@media (max-width: 480px) {
  .progress__row {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
}
</style>
