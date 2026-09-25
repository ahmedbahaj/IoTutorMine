<template>
  <main class="detail">
    <div class="container">
      <router-link :to="backTo" class="detail__back">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        {{ backLabel }}
      </router-link>

      <p v-if="loading" class="detail__state" role="status">Loading extraction…</p>

      <div v-else-if="error" class="detail__not-found">
        <h2>Extraction not found</h2>
        <p>{{ error }}</p>
        <router-link :to="backTo" class="detail__back">← {{ backLabel }}</router-link>
      </div>

      <template v-else-if="extraction">
        <h1 class="detail__title">{{ extraction.title || 'Untitled video' }}</h1>

        <div class="detail__card">
          <div class="detail__meta-row">
            <span v-if="duration" class="detail__meta-item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              {{ duration }}
            </span>
            <span v-if="extraction.channel" class="detail__meta-item">
              Channel: <strong>{{ extraction.channel }}</strong>
            </span>
            <span v-if="extractedOn" class="detail__meta-item">
              Extracted: {{ extractedOn }}
            </span>
            <span v-if="extraction.model" class="detail__meta-item">
              Model: {{ extraction.model }}
            </span>
          </div>

          <div class="detail__content">
            <div class="detail__player">
              <div v-if="extraction.videoId" class="detail__player-wrapper">
                <iframe
                  :src="`https://www.youtube.com/embed/${extraction.videoId}`"
                  frameborder="0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowfullscreen
                  title="Video player"
                ></iframe>
              </div>
              <p v-else class="detail__no-video">
                This extraction was produced from a manually pasted transcript, so there is no
                linked video.
              </p>
            </div>

            <div class="detail__info">
              <div v-if="watchUrl" class="detail__info-section">
                <h3 class="detail__info-label">Source</h3>
                <a :href="watchUrl" target="_blank" rel="noopener noreferrer" class="detail__link">
                  Watch on YouTube ↗
                </a>
              </div>

              <div class="detail__info-section">
                <h3 class="detail__info-label">Components found</h3>
                <p class="detail__info-value">
                  {{ extraction.componentCount ?? extraction.components.length }}
                  ({{ usedCount }} used)
                </p>
              </div>

              <div v-if="extraction.source === 'manual-transcript'" class="detail__info-section">
                <h3 class="detail__info-label">Source type</h3>
                <p class="detail__info-value">
                  Manually pasted transcript. Results from pasted text are kept in your own history
                  and are not published to the shared library.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div class="detail__card">
          <h2 class="detail__section-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/></svg>
            Bill of Materials
          </h2>
          <ComponentsTable :components="extraction.components" />

          <p v-if="extraction.supersededByShared" class="detail__superseded">
            Showing the latest AI extraction for this video. Your own run on
            {{ formatDate(extraction.historicalExtractedAt) }} recorded
            {{ extraction.historicalComponents.length }} components and is kept in your history.
          </p>

          <p class="detail__disclaimer">
            Automatically extracted from the tutorial transcript. Not independently verified.
          </p>
        </div>
      </template>
    </div>
  </main>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ComponentsTable from '../components/ComponentsTable.vue'
import { history } from '../services/history.js'
import { getPublicExtraction } from '../services/extract.js'
import { canonicalUrl, formatDuration } from '../services/youtube.js'
import { ensureActiveResults, resolveHistoryEntry } from '../services/activeResults.js'

const props = defineProps({
  /** 'local' reads this browser's history; 'shared' reads the public library. */
  mode: { type: String, default: 'local' }
})

const route = useRoute()

const extraction = ref(null)
const loading = ref(false)
const error = ref('')

let controller = null

function abortInFlight() {
  if (controller) {
    controller.abort()
    controller = null
  }
}

async function load() {
  abortInFlight()
  extraction.value = null
  error.value = ''

  if (props.mode === 'local') {
    const entry = history.get(String(route.params.id || ''))
    if (!entry) {
      error.value = 'This saved extraction is no longer in this browser’s history.'
      return
    }

    // Show the active result by default. A read-only lookup, so opening a saved
    // entry never costs a model call; the user's own record is kept intact and
    // surfaced separately when it has been superseded.
    if (entry.videoId) await ensureActiveResults([entry.videoId])
    extraction.value = resolveHistoryEntry(entry)
    return
  }

  controller = new AbortController()
  const signal = controller.signal
  loading.value = true

  try {
    const item = await getPublicExtraction(String(route.params.videoId || ''), { signal })
    if (!item) {
      error.value = 'No published extraction exists for this video.'
      return
    }
    extraction.value = item
  } catch (e) {
    if (e?.name === 'AbortError') return
    error.value = e?.message || 'Could not load this extraction.'
  } finally {
    if (controller?.signal === signal) controller = null
    loading.value = false
  }
}

// Re-run on route change so Back/Forward and direct refreshes both work.
watch(() => [props.mode, route.params.id, route.params.videoId], load, { immediate: true })
onBeforeUnmount(abortInFlight)

const backTo = computed(() => (props.mode === 'local' ? '/my-extractions' : '/extractions'))
const backLabel = computed(() =>
  props.mode === 'local' ? 'Back to My Extractions' : 'Back to All Extractions'
)

const duration = computed(() => formatDuration(extraction.value?.durationSeconds))

const watchUrl = computed(() => {
  const e = extraction.value
  if (!e) return null
  return e.canonicalUrl || (e.videoId ? canonicalUrl(e.videoId) : null)
})

const extractedOn = computed(() => {
  const raw = extraction.value?.extractedAt || extraction.value?.savedAt
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString()
})

function formatDate(raw) {
  if (!raw) return 'an earlier date'
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? 'an earlier date' : d.toLocaleDateString()
}

const usedCount = computed(
  () => (extraction.value?.components || []).filter(c => c.status === 'USED').length
)
</script>

<style scoped>
.detail {
  flex: 1;
  padding: var(--space-xl) 0 var(--space-2xl);
}

.detail__back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-secondary);
  text-decoration: none;
  margin-bottom: var(--space-lg);
}

.detail__back:hover {
  color: var(--color-accent);
  text-decoration: none;
}

.detail__title {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  line-height: 1.3;
  color: var(--color-text-primary);
  margin-bottom: var(--space-lg);
}

.detail__card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-xl);
  margin-bottom: var(--space-lg);
}

.detail__meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-lg);
  padding-bottom: var(--space-lg);
  margin-bottom: var(--space-lg);
  border-bottom: 1px solid var(--color-border-light);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.detail__meta-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.detail__content {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: var(--space-xl);
}

.detail__player-wrapper {
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: #000;
}

.detail__player-wrapper iframe {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.detail__no-video {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  padding: var(--space-lg);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
}

.detail__info {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}

.detail__info-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  color: var(--color-text-muted);
  margin-bottom: var(--space-xs);
}

.detail__info-value {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.detail__link {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-accent);
}

.detail__section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-lg);
  font-weight: 700;
  color: var(--color-text-primary);
  margin-bottom: var(--space-md);
}

.detail__superseded {
  margin-top: var(--space-md);
  padding: 8px 12px;
  font-size: var(--font-size-xs);
  line-height: 1.6;
  color: var(--color-accent);
  background: var(--color-accent-light);
  border-radius: var(--radius-sm);
}

.detail__disclaimer {
  margin-top: var(--space-md);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.detail__state {
  text-align: center;
  color: var(--color-text-muted);
  padding: var(--space-2xl) 0;
}

.detail__not-found {
  text-align: center;
  padding: var(--space-2xl) 0;
  color: var(--color-text-muted);
}

.detail__not-found h2 {
  font-size: var(--font-size-xl);
  color: var(--color-text-primary);
  margin-bottom: var(--space-sm);
}

@media (max-width: 900px) {
  .detail__content {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 480px) {
  .detail__card {
    padding: var(--space-md);
  }
}
</style>
