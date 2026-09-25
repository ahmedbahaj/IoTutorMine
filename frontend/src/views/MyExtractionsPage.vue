<template>
  <main class="page">
    <div class="container">
      <section class="page__section">
        <h1 class="page__heading">My Extractions</h1>
        <p class="page__subtitle">
          Extractions you have run in this browser. They are stored locally on this device only —
          they are not synced across browsers or devices. Clearing your browser data removes them.
        </p>

        <div v-if="entries.length" class="page__toolbar">
          <input
            id="my-extractions-search"
            v-model="query"
            type="text"
            class="page__search"
            placeholder="Filter by title or component..."
            aria-label="Filter my extractions"
          />
          <button class="btn btn--danger" @click="confirmClear">Clear history</button>
        </div>

        <div v-if="!entries.length" class="page__empty">
          <p>You haven't extracted any videos yet.</p>
          <router-link to="/" class="btn btn--primary">Extract a video</router-link>
        </div>

        <p v-else-if="!filtered.length" class="page__empty">
          No saved extractions match “{{ query }}”.
        </p>

        <div v-else class="extraction-grid">
          <ExtractionCard
            v-for="entry in filtered"
            :key="entry.id"
            :extraction="entry"
            :to="{ name: 'MyExtractionDetail', params: { id: entry.id } }"
          />
        </div>
      </section>
    </div>
  </main>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import ExtractionCard from '../components/ExtractionCard.vue'
import { history } from '../services/history.js'

const entries = ref([])
const query = ref('')

function load() {
  entries.value = history.list()
}

onMounted(load)

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return entries.value

  return entries.value.filter(entry => {
    const haystack = [
      entry.title || '',
      entry.channel || '',
      entry.originalUrl || '',
      ...(entry.components || []).map(c => c.name)
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(q)
  })
})

function confirmClear() {
  if (window.confirm('Remove all saved extractions from this browser? This cannot be undone.')) {
    history.clear()
    load()
  }
}
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
  margin-bottom: var(--space-lg);
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
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}

.btn--primary {
  color: #fff;
  background: var(--color-accent);
}

.btn--primary:hover {
  background: var(--color-accent-hover);
  text-decoration: none;
}

.btn--danger {
  color: var(--color-danger);
  background: transparent;
  border-color: var(--color-border);
}

.btn--danger:hover {
  background: #fef2f2;
  border-color: var(--color-danger);
}

.page__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-md);
  text-align: center;
  color: var(--color-text-muted);
  padding: var(--space-2xl) 0;
  font-size: var(--font-size-base);
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
