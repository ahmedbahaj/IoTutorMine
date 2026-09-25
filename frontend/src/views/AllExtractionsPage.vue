<template>
  <main class="page">
    <div class="container">
      <section class="page__section">
        <h1 class="page__heading">All Extractions</h1>
        <p class="page__subtitle">
          IoT tutorials extracted by users of this tool. These are model-extracted results,
          not manually verified ground truth, and are separate from the curated research catalog
          on the Home page.
        </p>

        <div class="page__toolbar">
          <input
            id="all-extractions-search"
            v-model="query"
            type="text"
            class="page__search"
            placeholder="Search by video title or component (e.g. DHT11)..."
            aria-label="Search shared extractions"
            @keyup.enter="runSearch"
          />
          <button class="btn btn--primary" @click="runSearch">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            Search
          </button>
        </div>

        <!-- Loading (first page) -->
        <p v-if="loading && !items.length" class="page__state" role="status">
          Loading shared extractions…
        </p>

        <!-- Error -->
        <div v-else-if="error" class="page__notice" role="alert">
          <span>{{ error }}</span>
          <button class="btn btn--ghost" @click="runSearch">Retry</button>
        </div>

        <!-- Empty -->
        <p v-else-if="!items.length" class="page__state">
          <template v-if="activeQuery">
            No shared extractions match “{{ activeQuery }}”.
          </template>
          <template v-else>
            No shared extractions yet. Extract a video from the Home page to add the first one.
          </template>
        </p>

        <!-- Results -->
        <template v-else>
          <div class="extraction-grid">
            <ExtractionCard
              v-for="item in items"
              :key="item.sharedId || item.videoId"
              :extraction="item"
              :to="{ name: 'SharedExtractionDetail', params: { videoId: item.videoId } }"
            />
          </div>

          <div v-if="hasMore" class="page__more">
            <button class="btn btn--ghost" :disabled="loading" @click="loadMore">
              {{ loading ? 'Loading…' : 'Load more' }}
            </button>
          </div>
        </template>
      </section>
    </div>
  </main>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ExtractionCard from '../components/ExtractionCard.vue'
import { listPublicExtractions } from '../services/extract.js'

const PAGE_SIZE = 24

const route = useRoute()
const router = useRouter()

const query = ref(String(route.query.q || ''))
const activeQuery = ref(query.value)
const items = ref([])
const offset = ref(0)
const hasMore = ref(false)
const loading = ref(false)
const error = ref('')

let controller = null

function abortInFlight() {
  if (controller) {
    controller.abort()
    controller = null
  }
}

async function fetchPage({ append = false } = {}) {
  abortInFlight()
  controller = new AbortController()
  const signal = controller.signal

  loading.value = true
  error.value = ''

  try {
    const data = await listPublicExtractions({
      q: activeQuery.value,
      limit: PAGE_SIZE,
      offset: append ? offset.value : 0,
      signal
    })

    const incoming = data.items || []
    items.value = append ? [...items.value, ...incoming] : incoming
    offset.value = (append ? offset.value : 0) + incoming.length
    hasMore.value = data.hasMore === true
  } catch (e) {
    if (e?.name === 'AbortError') return
    if (!append) items.value = []
    hasMore.value = false
    error.value = e?.message || 'Could not load shared extractions.'
  } finally {
    if (controller?.signal === signal) controller = null
    loading.value = false
  }
}

function runSearch() {
  activeQuery.value = query.value.trim()

  // Keep the search term in the URL so refresh and Back/Forward behave.
  const next = activeQuery.value ? { q: activeQuery.value } : {}
  if (String(route.query.q || '') !== activeQuery.value) {
    router.replace({ name: 'AllExtractions', query: next })
  }

  fetchPage()
}

function loadMore() {
  if (!loading.value && hasMore.value) fetchPage({ append: true })
}

// Respond to Back/Forward changing ?q=
watch(
  () => route.query.q,
  q => {
    const value = String(q || '')
    if (value === activeQuery.value) return
    query.value = value
    activeQuery.value = value
    fetchPage()
  }
)

onMounted(() => fetchPage())
onBeforeUnmount(abortInFlight)
</script>

<style scoped>
.page {
  flex: 1;
  padding: var(--space-xl) 0 var(--space-2xl);
}

.page__section {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-xl);
}

.page__heading {
  font-size: var(--font-size-xl);
  font-weight: 700;
  margin-bottom: var(--space-sm);
  color: var(--color-text-primary);
}

.page__subtitle {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  margin-bottom: var(--space-lg);
  max-width: 70ch;
}

.page__toolbar {
  display: flex;
  gap: var(--space-sm);
  margin-bottom: var(--space-xl);
}

.page__search {
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

.page__search:focus {
  border-color: var(--color-accent);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 20px;
  font-size: var(--font-size-sm);
  font-weight: 600;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}

.btn--primary {
  color: #fff;
  background: var(--color-accent);
}

.btn--primary:hover {
  background: var(--color-accent-hover);
}

.btn--ghost {
  color: var(--color-text-secondary);
  background: transparent;
  border-color: var(--color-border);
}

.btn--ghost:hover {
  color: var(--color-text-primary);
  background: var(--color-surface-hover);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.page__state {
  text-align: center;
  color: var(--color-text-muted);
  padding: var(--space-2xl) 0;
  font-size: var(--font-size-base);
}

.page__notice {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  padding: 12px 16px;
  font-size: var(--font-size-sm);
  color: var(--color-warning-text);
  background: var(--color-warning-bg);
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-sm);
}

.page__notice .btn--ghost {
  margin-left: auto;
}

.page__more {
  display: flex;
  justify-content: center;
  margin-top: var(--space-xl);
}

.extraction-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-lg);
}

@media (max-width: 1024px) {
  .extraction-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

@media (max-width: 768px) {
  .extraction-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .page__toolbar {
    flex-direction: column;
  }
}

@media (max-width: 480px) {
  .extraction-grid {
    grid-template-columns: 1fr;
  }

  .page__section {
    padding: var(--space-md);
  }
}
</style>
