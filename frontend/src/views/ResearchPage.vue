<template>
  <main class="research">
    <div class="container">
      <!-- ── Header ───────────────────────────────────────────────── -->
      <header class="research__header">
        <h1 class="research__title">Research &amp; Results</h1>
        <p class="research__lead">
          IoTutorMine is a research tool from a peer-reviewed study on mining hardware
          Bills of Materials from IoT tutorial videos. This page summarises the published
          method, benchmark, and results, and links to the artifacts.
        </p>
      </header>

      <!-- ── 1. About ─────────────────────────────────────────────── -->
      <section class="card">
        <h2 class="card__title">About IoTutorMine</h2>

        <p class="paper__title">
          IoTutorMine: A Tool for Mining Hardware Bills of Materials from IoT Tutorial Videos
        </p>
        <p class="paper__authors">
          Abdullah A. Alahmadi, Ahmed O. Bahaj, and Mohammad D. Alahmadi
        </p>
        <p class="paper__venue">ASE 2026</p>

        <h3 class="card__subtitle">The problem</h3>
        <p class="prose">
          Hardware components in IoT tutorials are usually described verbally as the
          presenter builds the circuit, and rarely listed anywhere in a structured form.
          Working out what to buy therefore means watching the whole video and noting parts
          as they are mentioned — slow for one tutorial, impractical across many.
          IoTutorMine recovers that Bill of Materials from the tutorial's transcript.
        </p>

        <h3 class="card__subtitle">The pipeline</h3>
        <ol class="pipeline">
          <li v-for="(phase, i) in pipeline" :key="phase.name" class="pipeline__step">
            <span class="pipeline__index" aria-hidden="true">{{ i + 1 }}</span>
            <span class="pipeline__body">
              <span class="pipeline__name">{{ phase.name }}</span>
              <span class="pipeline__desc">{{ phase.desc }}</span>
            </span>
          </li>
        </ol>
      </section>

      <!-- ── 2. Benchmark ─────────────────────────────────────────── -->
      <section class="card">
        <h2 class="card__title">Benchmark</h2>
        <p class="prose">
          The published evaluation uses a manually constructed ground-truth benchmark of
          YouTube IoT tutorials.
        </p>

        <div class="stats">
          <div v-for="stat in benchmarkStats" :key="stat.label" class="stat">
            <span class="stat__value">{{ stat.value }}</span>
            <span class="stat__label">{{ stat.label }}</span>
          </div>
        </div>

        <dl class="facts">
          <div class="facts__row">
            <dt>Platforms</dt>
            <dd>Arduino and Raspberry Pi</dd>
          </div>
          <div class="facts__row">
            <dt>Difficulty levels</dt>
            <dd>Beginner and intermediate</dd>
          </div>
        </dl>
      </section>

      <!-- ── 3. Results ───────────────────────────────────────────── -->
      <section class="card">
        <h2 class="card__title">Research results</h2>
        <p class="prose">
          Corpus-level precision, recall, and F1 for each evaluated model, as reported in
          the paper.
        </p>

        <!-- Legend: identity is never carried by colour alone - every bar is
             also directly labelled with its value, and the table below repeats
             all nine numbers. -->
        <ul class="legend" aria-hidden="true">
          <li v-for="metric in metrics" :key="metric.key" class="legend__item">
            <span class="legend__swatch" :style="{ background: metric.color }"></span>
            {{ metric.label }}
          </li>
        </ul>

        <div class="chart" role="img" :aria-label="chartSummary">
          <div v-for="model in results" :key="model.model" class="chart__group">
            <h3 class="chart__model">{{ model.model }}</h3>

            <div
              v-for="metric in metrics"
              :key="metric.key"
              class="chart__row"
            >
              <span class="chart__metric">{{ metric.label }}</span>

              <!-- Bars are anchored at zero. The values sit in a narrow band,
                   so the direct labels carry the precision while the bars carry
                   the overall shape; truncating the axis would exaggerate the
                   differences. -->
              <div class="chart__track">
                <div
                  v-for="tick in gridTicks"
                  :key="tick"
                  class="chart__grid"
                  :style="{ left: `${tick * 100}%` }"
                ></div>
                <div
                  class="chart__bar"
                  :style="{ width: `${model[metric.key] * 100}%`, background: metric.color }"
                  :title="`${model.model} — ${metric.label}: ${model[metric.key].toFixed(3)}`"
                ></div>
              </div>

              <span class="chart__value">{{ model[metric.key].toFixed(3) }}</span>
            </div>
          </div>

          <div class="chart__axis" aria-hidden="true">
            <span v-for="tick in axisLabels" :key="tick" class="chart__axis-tick">
              {{ tick.toFixed(2) }}
            </span>
          </div>
        </div>

        <div class="table-wrap">
          <table class="results-table">
            <caption class="visually-hidden">
              Corpus-level precision, recall and F1 by model, as published.
            </caption>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col" class="num">Precision</th>
                <th scope="col" class="num">Recall</th>
                <th scope="col" class="num">F1</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="model in results" :key="model.model">
                <th scope="row" class="results-table__model">
                  {{ model.model }}
                  <span v-if="model.selected" class="tag">used by this tool</span>
                </th>
                <td class="num">{{ model.precision.toFixed(3) }}</td>
                <td class="num">{{ model.recall.toFixed(3) }}</td>
                <td class="num">{{ model.f1.toFixed(3) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="note">
          Values are reproduced from the camera-ready ASE 2026 paper and are reported to
          three decimal places exactly as published.
        </p>
      </section>

      <!-- ── 4. Model selection ───────────────────────────────────── -->
      <section class="card">
        <h2 class="card__title">Model selection</h2>

        <p class="prose">
          Gemini 3 Flash was selected for this tool's backend because it achieved the
          strongest results of the three models in the published benchmark, leading on
          precision, recall, and F1.
        </p>
        <p class="prose">
          Extraction is <strong>zero-shot</strong>: the model is given the tutorial
          transcript and asked to identify the shoppable hardware components the presenter
          mentions or uses, without any worked examples. Each component is labelled
          <strong>USED</strong> or <strong>ALTERNATIVE</strong>.
        </p>

        <div class="callout">
          <h3 class="callout__title">What these numbers do and do not describe</h3>
          <p>
            The scores above are measurements from the paper's controlled experiment, taken
            over the 20-video ground-truth benchmark. They describe that evaluation.
          </p>
          <p>
            They are <strong>not</strong> a measurement of this website. Extractions you run
            here are produced by the same model and the same zero-shot prompt, but on
            arbitrary user-submitted videos that were never part of the benchmark and have no
            ground truth to score against. Results in
            <router-link to="/extractions">All Extractions</router-link> are
            model output, not verified ground truth, and no accuracy figure should be
            inferred for them from this table.
          </p>
        </div>
      </section>

      <!-- ── 5. Artifacts ─────────────────────────────────────────── -->
      <section class="card">
        <h2 class="card__title">Research artifacts</h2>
        <p class="prose">Everything needed to read, verify, or reproduce the study.</p>

        <div class="artifacts">
          <a
            v-for="artifact in artifacts"
            :key="artifact.href"
            :href="artifact.href"
            class="artifact"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span class="artifact__kind">{{ artifact.kind }}</span>
            <span class="artifact__name">{{ artifact.name }}</span>
            <span class="artifact__desc">{{ artifact.desc }}</span>
            <span v-if="artifact.pending" class="artifact__pending">
              {{ artifact.pendingNote }}
            </span>
            <span class="artifact__link">{{ artifact.display }} ↗</span>
          </a>
        </div>
      </section>
    </div>
  </main>
</template>

<script setup>
import { computed } from 'vue'

const pipeline = [
  {
    name: 'Transcript Acquisition',
    desc: 'Obtain the spoken content of the tutorial video.'
  },
  {
    name: 'Transcript Preparation',
    desc: 'Normalise the raw transcript into a single clean body of text for the model.'
  },
  {
    name: 'Zero-shot LLM Extraction',
    desc: 'Prompt the model to return the hardware Bill of Materials, labelling each component USED or ALTERNATIVE.'
  }
]

const benchmarkStats = [
  { value: '20', label: 'YouTube IoT tutorials' },
  { value: '131', label: 'ground-truth components' },
  { value: '16', label: 'distinct creators' }
]

/**
 * Categorical palette, validated for colour-vision deficiency against the page
 * surface (worst adjacent pair ΔE 13.8 protan, 28.8 normal; all three clear the
 * chroma floor and 3:1 contrast). The blue is the site accent.
 */
const metrics = [
  { key: 'precision', label: 'Precision', color: '#2563eb' },
  { key: 'recall', label: 'Recall', color: '#ea580c' },
  { key: 'f1', label: 'F1', color: '#0d9488' }
]

/** Published corpus-level results (ASE 2026 camera-ready). */
const results = [
  { model: 'Gemini 3 Flash', precision: 0.907, recall: 0.962, f1: 0.933, selected: true },
  { model: 'GPT-5', precision: 0.905, recall: 0.870, f1: 0.887, selected: false },
  { model: 'Claude Opus 4.7', precision: 0.882, recall: 0.855, f1: 0.868, selected: false }
]

const gridTicks = [0.25, 0.5, 0.75, 1]
const axisLabels = [0, 0.25, 0.5, 0.75, 1]

const chartSummary = computed(() =>
  'Precision, recall and F1 by model. ' +
  results
    .map(m => `${m.model}: precision ${m.precision}, recall ${m.recall}, F1 ${m.f1}.`)
    .join(' ')
)

const artifacts = [
  {
    kind: 'Paper',
    name: 'Published paper',
    desc: 'The peer-reviewed ASE 2026 paper describing the method and evaluation.',
    href: 'https://doi.org/10.1145/3832783.3834647',
    display: 'doi.org/10.1145/3832783.3834647',
    // The DOI is registered but not yet resolving: it activates when ACM
    // publishes the proceedings. Saying so is more honest than presenting a
    // link that currently 404s as a working publication link.
    pending: true,
    pendingNote: 'DOI activates on publication — not yet resolving'
  },
  {
    kind: 'Archive',
    name: 'Tool source archive',
    desc: 'Archived snapshot of the IoTutorMine source on Zenodo.',
    href: 'https://doi.org/10.5281/zenodo.20134482',
    display: 'doi.org/10.5281/zenodo.20134482'
  },
  {
    kind: 'Dataset',
    name: 'Benchmark and replication package',
    desc: 'The ground-truth benchmark and material needed to reproduce the results.',
    href: 'https://doi.org/10.5281/zenodo.20135165',
    display: 'doi.org/10.5281/zenodo.20135165'
  },
  {
    kind: 'Code',
    name: 'GitHub repository',
    desc: 'The original repository for the tool.',
    href: 'https://github.com/ahmedbahaj/IoTutorMine',
    display: 'github.com/ahmedbahaj/IoTutorMine'
  },
  {
    kind: 'Video',
    name: 'Research demo video',
    desc: 'A walkthrough of the tool and its results.',
    href: 'https://www.youtube.com/watch?v=1H3GgQFjfZU',
    display: 'youtube.com/watch?v=1H3GgQFjfZU'
  }
]
</script>

<style scoped>
.research {
  flex: 1;
  padding: var(--space-xl) 0 var(--space-2xl);
}

.research__header {
  margin-bottom: var(--space-lg);
}

.research__title {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  color: var(--color-text-primary);
  margin-bottom: var(--space-sm);
}

.research__lead {
  font-size: var(--font-size-base);
  color: var(--color-text-secondary);
  max-width: 70ch;
  line-height: 1.6;
}

/* ── Card shell, matching the other pages ───────────────────────── */
.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-xl);
  margin-bottom: var(--space-lg);
}

.card__title {
  font-size: var(--font-size-xl);
  font-weight: 700;
  color: var(--color-text-primary);
  margin-bottom: var(--space-md);
}

.card__subtitle {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text-primary);
  margin: var(--space-lg) 0 var(--space-sm);
}

.prose {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: 1.7;
  max-width: 75ch;
  margin-bottom: var(--space-sm);
}

/* ── Paper heading block ────────────────────────────────────────── */
.paper__title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  line-height: 1.45;
  color: var(--color-text-primary);
  margin-bottom: var(--space-xs);
}

.paper__authors {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.paper__venue {
  display: inline-block;
  margin-top: var(--space-sm);
  padding: 3px 10px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-accent);
  background: var(--color-accent-light);
  border-radius: 100px;
}

/* ── Pipeline ───────────────────────────────────────────────────── */
.pipeline {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-md);
  list-style: none;
  margin-top: var(--space-md);
}

.pipeline__step {
  display: flex;
  gap: var(--space-sm);
  padding: var(--space-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-hover);
}

.pipeline__index {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 100px;
  background: var(--color-accent);
  color: #fff;
  font-size: var(--font-size-xs);
  font-weight: 700;
}

.pipeline__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pipeline__name {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-primary);
}

.pipeline__desc {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.6;
}

/* ── Benchmark stats ────────────────────────────────────────────── */
.stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-md);
  margin: var(--space-lg) 0;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-lg) var(--space-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  text-align: center;
}

.stat__value {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  color: var(--color-accent);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}

.stat__label {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.facts__row {
  display: flex;
  gap: var(--space-sm);
  padding: 10px 0;
  border-top: 1px solid var(--color-border-light);
  font-size: var(--font-size-sm);
}

.facts__row dt {
  min-width: 150px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.facts__row dd {
  color: var(--color-text-secondary);
}

/* ── Chart ──────────────────────────────────────────────────────── */
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-lg);
  list-style: none;
  margin: var(--space-lg) 0 var(--space-md);
}

.legend__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.legend__swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

.chart__group {
  margin-bottom: var(--space-lg);
}

.chart__model {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-primary);
  margin-bottom: var(--space-sm);
}

.chart__row {
  display: grid;
  grid-template-columns: 74px 1fr 48px;
  align-items: center;
  gap: var(--space-sm);
  /* 2px of surface between adjacent bars so fills never touch. */
  margin-bottom: 2px;
}

.chart__metric {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.chart__track {
  position: relative;
  height: 14px;
  background: var(--color-border-light);
  border-radius: 4px;
  overflow: hidden;
}

.chart__grid {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--color-surface);
  opacity: 0.85;
}

.chart__bar {
  position: relative;
  height: 100%;
  border-radius: 4px;
  transition: width 0.4s ease-out;
}

.chart__value {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-text-primary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.chart__axis {
  display: flex;
  justify-content: space-between;
  margin-left: calc(74px + var(--space-sm));
  margin-right: calc(48px + var(--space-sm));
  padding-top: 4px;
  border-top: 1px solid var(--color-border-light);
}

.chart__axis-tick {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

/* ── Results table ──────────────────────────────────────────────── */
.table-wrap {
  overflow-x: auto;
  margin-top: var(--space-xl);
}

.results-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-sm);
}

.results-table th,
.results-table td {
  padding: 10px 8px;
  text-align: left;
  border-bottom: 1px solid var(--color-border-light);
}

.results-table thead th {
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
  white-space: nowrap;
}

.results-table__model {
  font-weight: 600;
  color: var(--color-text-primary);
}

.results-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.results-table tbody tr:last-child th,
.results-table tbody tr:last-child td {
  border-bottom: none;
}

.tag {
  display: inline-block;
  margin-left: 8px;
  padding: 2px 8px;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--color-accent);
  background: var(--color-accent-light);
  border-radius: 100px;
  white-space: nowrap;
}

.note {
  margin-top: var(--space-md);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

/* ── Callout ────────────────────────────────────────────────────── */
.callout {
  margin-top: var(--space-lg);
  padding: var(--space-md) var(--space-lg);
  border: 1px solid var(--color-warning-border);
  background: var(--color-warning-bg);
  border-radius: var(--radius-md);
}

.callout__title {
  font-size: var(--font-size-sm);
  font-weight: 700;
  color: var(--color-warning-text);
  margin-bottom: var(--space-sm);
}

.callout p {
  font-size: var(--font-size-sm);
  line-height: 1.7;
  color: var(--color-warning-text);
  margin-bottom: var(--space-sm);
}

.callout p:last-child {
  margin-bottom: 0;
}

.callout a {
  color: inherit;
  font-weight: 600;
  text-decoration: underline;
}

/* ── Artifacts ──────────────────────────────────────────────────── */
.artifacts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--space-md);
  margin-top: var(--space-lg);
}

.artifact {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--space-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  text-decoration: none;
  color: inherit;
  transition: border-color 0.15s, box-shadow 0.2s;
}

.artifact:hover {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-md);
  text-decoration: none;
}

.artifact__kind {
  align-self: flex-start;
  padding: 2px 8px;
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--color-badge-text);
  background: var(--color-badge-bg);
  border-radius: 100px;
}

.artifact__name {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-primary);
}

.artifact__desc {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.6;
  flex: 1;
}

.artifact__pending {
  align-self: flex-start;
  padding: 2px 8px;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--color-warning-text);
  background: var(--color-warning-bg);
  border: 1px solid var(--color-warning-border);
  border-radius: 100px;
}

.artifact__link {
  margin-top: 4px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-accent);
  word-break: break-all;
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

/* ── Responsive ─────────────────────────────────────────────────── */
@media (max-width: 860px) {
  .pipeline {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 600px) {
  .stats {
    grid-template-columns: 1fr;
  }

  .facts__row {
    flex-direction: column;
    gap: 2px;
  }

  .chart__row {
    grid-template-columns: 62px 1fr 44px;
  }

  .chart__axis {
    margin-left: calc(62px + var(--space-sm));
    margin-right: calc(44px + var(--space-sm));
  }
}

@media (max-width: 480px) {
  .card {
    padding: var(--space-md);
  }

  .research__title {
    font-size: var(--font-size-xl);
  }
}

@media (prefers-reduced-motion: reduce) {
  .chart__bar {
    transition: none;
  }
}
</style>
