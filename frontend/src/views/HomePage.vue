<template>
  <main class="home">
    <div class="container">
      <!-- Extract Components Section -->
      <section class="home__section home__extract">
        <h2 class="home__heading">Extract Components</h2>
        <p class="home__subtitle">Paste a YouTube IoT tutorial URL and let our LLM extract the electrical components for you.</p>

        <div class="extract-bar">
          <input
            id="youtube-url-input"
            type="text"
            class="extract-input"
            v-model="youtubeUrl"
            placeholder="https://www.youtube.com/watch?v=..."
            :disabled="loading"
            @keyup.enter="runExtract()"
          />
          <button class="extract-btn" :disabled="loading" @click="runExtract()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
            {{ loading ? 'Extracting...' : 'Extract Components' }}
          </button>
        </div>

        <div v-if="needsManualTranscript" class="manual-transcript">
          <p class="home__subtitle">YouTube transcript could not be fetched automatically. Paste the transcript below and try again.</p>
          <textarea
            class="extract-input manual-transcript__textarea"
            v-model="manualTranscript"
            :disabled="loading"
            placeholder="Paste tutorial transcript here..."
          ></textarea>
        </div>

        <!-- Progress / completion / error feedback -->
        <ExtractionProgress
          :phase="phase"
          :error-message="error"
          :error-code="errorCode"
          :done-message="doneMessage"
        />

        <div v-if="error && phase !== 'error'" class="extract-notice">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          {{ error }}
          <button class="extract-notice__close" @click="error = ''" aria-label="Dismiss">×</button>
        </div>

        <div v-if="result" class="extract-results">
          <div class="extract-results__header">
            <h3 class="extract-results__title">
              {{ result.title || 'Electrical Components' }}
            </h3>
            <button
              v-if="result.videoId"
              class="btn btn--ghost"
              :disabled="loading"
              @click="runExtract({ force: true })"
              title="Run the model again instead of reusing the saved result"
            >
              Re-extract
            </button>
          </div>

          <p v-if="reuseNotice" class="extract-results__note">
            {{ reuseNotice }}
          </p>

          <ComponentsTable :components="result.components" />

          <div class="extract-results__footer">
            <router-link v-if="savedId" :to="`/my-extractions/${savedId}`" class="extract-results__link">
              Open saved result →
            </router-link>
            <router-link
              v-if="result.published && result.videoId"
              :to="`/extractions/${result.videoId}`"
              class="extract-results__link"
            >
              View in All Extractions →
            </router-link>
          </div>
        </div>
      </section>

      <!-- Videos Section -->
      <section class="home__section">
        <h1 class="home__heading">Videos</h1>
        <SearchBar v-model="searchQuery" @search="filterVideos" />

        <div class="video-grid">
          <VideoCard
            v-for="video in filteredVideos"
            :key="video.id"
            :video="video"
          />
        </div>

        <p v-if="filteredVideos.length === 0" class="home__empty">
          No videos found matching "{{ searchQuery }}".
        </p>
      </section>
    </div>
  </main>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import SearchBar from '../components/SearchBar.vue'
import VideoCard from '../components/VideoCard.vue'
import ComponentsTable from '../components/ComponentsTable.vue'
import ExtractionProgress from '../components/ExtractionProgress.vue'
import { videos } from '../data/videos.js'
import { extractComponents } from '../services/extract.js'
import { history } from '../services/history.js'
import { parseVideoId } from '../services/youtube.js'
import {
  activeFor,
  ensureActiveResults,
  resolveCatalog,
  setActiveResult
} from '../services/activeResults.js'

/** How many times to re-poll when another user is already extracting the same video. */
const PROCESSING_RETRIES = 3
const PROCESSING_RETRY_MS = 4000

const searchQuery = ref('')
const youtubeUrl = ref('')
const manualTranscript = ref('')
const loading = ref(false)
const error = ref('')
const errorCode = ref('')
const needsManualTranscript = ref(false)
const result = ref(null)
const savedId = ref('')
const reuseNotice = ref('')
const phase = ref('idle') // 'idle' | 'running' | 'done' | 'error'

let controller = null

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const doneMessage = computed(() => {
  if (!result.value) return 'Extraction complete.'
  const n = result.value.components.length
  return `Extraction complete — ${n} component${n === 1 ? '' : 's'} found.`
})

function reset() {
  error.value = ''
  errorCode.value = ''
  result.value = null
  savedId.value = ''
  reuseNotice.value = ''
}

function saveResult(data, originalUrl) {
  try {
    const record = history.save(data, { originalUrl })
    savedId.value = record.id
  } catch {
    // History is a convenience: never let a storage problem break extraction.
    savedId.value = ''
  }
}

function applyResult(data, { notice = '' } = {}) {
  result.value = data
  reuseNotice.value = notice
  phase.value = 'done'
  needsManualTranscript.value = false
}

async function runExtract({ force = false } = {}) {
  // Guard against double submission from Enter + click.
  if (loading.value) return

  const url = youtubeUrl.value.trim()
  const transcript = manualTranscript.value.trim()

  if (!url && !transcript) {
    error.value = 'Please paste a YouTube URL or a transcript first.'
    phase.value = 'idle'
    return
  }

  const videoId = transcript ? null : parseVideoId(url)

  if (!transcript && !videoId) {
    error.value = 'That does not look like a supported YouTube video link.'
    phase.value = 'idle'
    return
  }

  reset()

  // Step 3 of the lookup order: reuse this browser's own history immediately,
  // with no network call at all. An explicit Re-extract skips this.
  if (!force && videoId) {
    // A newer shared extraction always wins over an older local copy, so the
    // form cannot reintroduce a stale result that other pages have moved past.
    const shared = activeFor(videoId)
    const local = history.findByVideoId(videoId)

    if (shared && (!local || Date.parse(shared.extractedAt || 0) > Date.parse(local.extractedAt || 0))) {
      saveResult(shared, url)
      applyResult(shared, {
        notice: 'Showing the latest shared extraction for this video. The model was not called again.'
      })
      return
    }

    if (local) {
      savedId.value = local.id
      applyResult(local, {
        notice: 'Reused a result already saved in this browser. Use Re-extract to run the model again.'
      })
      return
    }
  }

  loading.value = true
  phase.value = 'running'

  controller = new AbortController()
  const signal = controller.signal

  try {
    let data = null

    for (let attempt = 0; attempt <= PROCESSING_RETRIES; attempt++) {
      const response = await extractComponents({
        url,
        transcript,
        force: force && attempt === 0,
        signal
      })

      // Another request is extracting this same video right now; keep the
      // progress indicator running and check back shortly.
      if (response.processing === true) {
        if (attempt === PROCESSING_RETRIES) {
          throw new Error('This video is still being processed. Please try again in a moment.')
        }
        await sleep(PROCESSING_RETRY_MS)
        continue
      }

      data = response
      break
    }

    if (!data) throw new Error('Extraction failed. Please try again.')

    if (!data.components || !data.components.length) {
      throw new Error('No components were extracted from this video.')
    }

    saveResult(data, url)
    // Promote it to the active result so Home cards, detail pages and All
    // Extractions all update in place.
    setActiveResult(data)
    applyResult(data, {
      notice: data.cached
        ? 'Loaded from the shared extraction library — the model was not called again.'
        : ''
    })
  } catch (e) {
    if (e?.name === 'AbortError') return

    error.value = e?.message || 'Extraction failed. Please try again.'
    errorCode.value = e?.errorCode || ''
    phase.value = 'error'

    // Preserve the existing manual-transcript fallback behaviour.
    if (e?.needsTranscript || String(e?.message || '').toLowerCase().includes('transcript')) {
      needsManualTranscript.value = true
    }
  } finally {
    loading.value = false
    controller = null
  }
}

onBeforeUnmount(() => {
  if (controller) controller.abort()
})

/**
 * The catalog with each entry resolved against the shared library. The original
 * `videos` import is never mutated - this produces new objects - so the research
 * data stays intact while the UI shows the active result.
 */
const resolvedVideos = computed(() => resolveCatalog(videos))

const filteredVideos = computed(() => {
  const q = searchQuery.value.toLowerCase().trim()
  if (!q) return resolvedVideos.value
  // Search indexes the ACTIVE components, so a part found only by a newer
  // extraction is still discoverable.
  return resolvedVideos.value.filter(v =>
    v.title.toLowerCase().includes(q) ||
    v.tags.some(t => t.toLowerCase().includes(q)) ||
    v.components.some(c => c.name.toLowerCase().includes(q)) ||
    v.creator.toLowerCase().includes(q)
  )
})

// One batched, read-only lookup for the whole catalog.
onMounted(() => {
  ensureActiveResults(videos.map(v => v.youtubeId))
})

function filterVideos() {
  // search is reactive via computed, this is a no-op placeholder
}
</script>

<style scoped>
.home {
  flex: 1;
  padding: var(--space-xl) 0 var(--space-2xl);
}

.home__section {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-xl);
}

.home__extract {
  margin-bottom: var(--space-lg);
}

.home__heading {
  font-size: var(--font-size-xl);
  font-weight: 700;
  margin-bottom: var(--space-sm);
  color: var(--color-text-primary);
}

.home__subtitle {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  margin-bottom: var(--space-lg);
}

.extract-bar {
  display: flex;
  gap: var(--space-sm);
}

.extract-input {
  flex: 1;
  padding: 10px 16px;
  font-size: var(--font-size-base);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-primary);
  outline: none;
  transition: border-color 0.15s;
}

.extract-input:focus {
  border-color: var(--color-accent);
}

.extract-input:disabled {
  background: var(--color-surface-hover);
  color: var(--color-text-muted);
}

.extract-input::placeholder {
  color: var(--color-text-muted);
}

.extract-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 20px;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: #fff;
  background: var(--color-accent);
  border: none;
  border-radius: var(--radius-sm);
  white-space: nowrap;
  transition: background 0.15s;
}

.extract-btn:hover {
  background: var(--color-accent-hover);
}

.extract-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.extract-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: var(--space-md);
  padding: 12px 16px;
  font-size: var(--font-size-sm);
  color: var(--color-warning-text);
  background: var(--color-warning-bg);
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-sm);
}

.extract-notice__close {
  margin-left: auto;
  background: none;
  border: none;
  font-size: 1.2rem;
  color: var(--color-warning-text);
  padding: 0 4px;
  line-height: 1;
}

.extract-notice__close:hover {
  opacity: 0.7;
}

.manual-transcript {
  margin-top: var(--space-md);
}

.manual-transcript__textarea {
  width: 100%;
  min-height: 120px;
  resize: vertical;
}

.extract-results {
  margin-top: var(--space-md);
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}

.extract-results__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-md);
  margin-bottom: var(--space-sm);
}

.extract-results__title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text-primary);
}

.extract-results__note {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  margin-bottom: var(--space-md);
}

.extract-results__footer {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-lg);
  margin-top: var(--space-md);
}

.extract-results__link {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-accent);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}

.btn--ghost:hover {
  color: var(--color-text-primary);
  background: var(--color-surface-hover);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.video-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-lg);
}

.home__empty {
  text-align: center;
  color: var(--color-text-muted);
  padding: var(--space-2xl) 0;
  font-size: var(--font-size-base);
}

@media (max-width: 1024px) {
  .video-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

@media (max-width: 768px) {
  .video-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .extract-bar {
    flex-direction: column;
  }
}

@media (max-width: 480px) {
  .video-grid {
    grid-template-columns: 1fr;
  }

  .home__section {
    padding: var(--space-md);
  }

  .extract-results__header {
    flex-direction: column;
  }
}
</style>
