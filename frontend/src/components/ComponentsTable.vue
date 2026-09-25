<template>
  <div class="components-table-wrap">
    <table class="components-table">
      <thead>
        <tr>
          <th>Component</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="comp in used" :key="`used-${comp.name}`">
          <tr>
            <td>{{ comp.name }}</td>
            <td><span class="status-badge status-badge--used">Used</span></td>
          </tr>
          <tr
            v-for="alt in alternativesFor(comp.name)"
            :key="`alt-${comp.name}-${alt.name}`"
            class="alt-row"
          >
            <td><span class="alt-branch">↳</span> {{ alt.name }}</td>
            <td><span class="status-badge status-badge--alt">Alternative</span></td>
          </tr>
        </template>

        <!-- Alternatives the model did not link to a specific used part. -->
        <tr v-for="alt in unlinkedAlternatives" :key="`free-${alt.name}`">
          <td>{{ alt.name }}</td>
          <td><span class="status-badge status-badge--alt">Alternative</span></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  components: { type: Array, default: () => [] }
})

const used = computed(() => props.components.filter(c => c.status === 'USED'))

const alternatives = computed(() => props.components.filter(c => c.status === 'ALTERNATIVE'))

function alternativesFor(name) {
  return alternatives.value.filter(a => a.alternativeTo === name)
}

const unlinkedAlternatives = computed(() => {
  const usedNames = new Set(used.value.map(c => c.name))
  return alternatives.value.filter(a => !a.alternativeTo || !usedNames.has(a.alternativeTo))
})
</script>

<style scoped>
.components-table-wrap {
  overflow-x: auto;
}

.components-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-sm);
}

.components-table th {
  text-align: left;
  padding: 10px 8px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  border-bottom: 1px solid var(--color-border);
  white-space: nowrap;
}

.components-table td {
  padding: 10px 8px;
  color: var(--color-text-primary);
  border-bottom: 1px solid var(--color-border-light);
}

.components-table tr:last-child td {
  border-bottom: none;
}

.alt-row td:first-child {
  padding-left: 20px;
  color: var(--color-text-secondary);
}

.alt-branch {
  color: var(--color-text-muted);
  margin-right: 4px;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: var(--font-size-xs);
  font-weight: 500;
  white-space: nowrap;
}

.status-badge--used {
  color: var(--color-success);
  background: #eaf7ee;
}

.status-badge--alt {
  color: var(--color-warning-text);
  background: var(--color-warning-bg);
}
</style>
