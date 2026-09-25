<template>
  <router-link :to="to" class="extraction-card">
    <div class="extraction-card__thumb">
      <img
        v-if="extraction.thumbnail && !thumbFailed"
        :src="extraction.thumbnail"
        :alt="displayTitle"
        loading="lazy"
        @error="thumbFailed = true"
      />
      <div v-else class="extraction-card__thumb-fallback" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/></svg>
      </div>

      <span v-if="duration" class="extraction-card__duration">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        {{ duration }}
      </span>
    </div>

    <div class="extraction-card__body">
      <h3 class="extraction-card__title">{{ displayTitle }}</h3>

      <div class="extraction-card__meta">
        <span>{{ extraction.componentCount || extraction.components?.length || 0 }} components</span>
        <span v-if="extractedOn">{{ extractedOn }}</span>
      </div>

      <div class="extraction-card__components">
        <span v-for="comp in previewComponents" :key="comp.name" class="component-badge">
          {{ comp.name }}
        </span>
        <span v-if="extraComponents > 0" class="component-badge component-badge--more">
          +{{ extraComponents }}
        </span>
      </div>

      <span class="extraction-card__action">Open Result →</span>
    </div>
  </router-link>
</template>

<script setup>
import { computed, ref } from 'vue'
import { formatDuration } from '../services/youtube.js'

const props = defineProps({
  extraction: { type: Object, required: true },
  to: { type: [String, Object], required: true }
})

const thumbFailed = ref(false)

// Titles are only shown when YouTube actually supplied one. Nothing is invented.
const displayTitle = computed(() => props.extraction.title || 'Untitled video')

const duration = computed(() => formatDuration(props.extraction.durationSeconds))

const extractedOn = computed(() => {
  const raw = props.extraction.extractedAt || props.extraction.savedAt
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
})

const usedComponents = computed(() =>
  (props.extraction.components || []).filter(c => c.status === 'USED')
)

const previewComponents = computed(() => usedComponents.value.slice(0, 3))
const extraComponents = computed(() => Math.max(0, usedComponents.value.length - 3))
</script>

<style scoped>
.extraction-card {
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  text-decoration: none;
  color: inherit;
  transition: box-shadow 0.2s, border-color 0.2s;
}

.extraction-card:hover {
  box-shadow: var(--shadow-md);
  border-color: var(--color-accent);
  text-decoration: none;
}

.extraction-card__thumb {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: #e5e7eb;
}

.extraction-card__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.extraction-card__thumb-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-muted);
}

.extraction-card__duration {
  position: absolute;
  bottom: 8px;
  left: 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: #fff;
  background: rgba(0, 0, 0, 0.7);
  border-radius: 4px;
}

.extraction-card__body {
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  flex: 1;
}

.extraction-card__title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  line-height: 1.4;
  color: var(--color-text-primary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.extraction-card__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.extraction-card__components {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: auto;
}

.component-badge {
  display: inline-block;
  padding: 2px 8px;
  font-size: 0.6875rem;
  font-weight: 500;
  color: var(--color-badge-text);
  background: var(--color-badge-bg);
  border-radius: 100px;
  white-space: nowrap;
}

.component-badge--more {
  color: var(--color-accent);
  background: var(--color-accent-light);
}

.extraction-card__action {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-accent);
}
</style>
