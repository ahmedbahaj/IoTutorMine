/**
 * Guards the published site's identity.
 *
 * https://ahmedbahaj.github.io/IoTutorMine/ is cited in the research paper, on
 * Zenodo, and in other academic material. The repository name, the Pages
 * domain, and the /IoTutorMine/ base path must never change, and existing deep
 * links must keep resolving. These assertions fail loudly if anything drifts.
 */

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import router from './router/index.js'
import { videos } from './data/videos.js'

const PUBLISHED_ORIGIN = 'https://ahmedbahaj.github.io'
const BASE_PATH = '/IoTutorMine/'

const read = relative =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('published URL invariants', () => {
  test('the Vite base path is unchanged', () => {
    expect(read('../vite.config.js')).toContain(`base: '${BASE_PATH}'`)
  })

  test('the router base path is unchanged', () => {
    expect(read('./router/index.js')).toContain(`createWebHistory('${BASE_PATH}')`)
  })

  test('the SPA fallback keeps exactly one path segment, matching the project page', () => {
    // pathSegmentsToKeep = 1 corresponds to the single /IoTutorMine/ segment.
    expect(read('../public/404.html')).toContain('var pathSegmentsToKeep = 1')
  })

  test('every existing catalog video link still resolves under the same base', () => {
    for (const video of videos) {
      const resolved = router.resolve(`/video/${video.id}`)
      expect(resolved.name, `/video/${video.id} must still resolve`).toBe('VideoDetail')
      expect(resolved.href).toBe(`${BASE_PATH}video/${video.id}`)
    }
  })

  test('the published origin can call the API (CORS allowlist)', () => {
    const http = read('../../api/_lib/http.js')
    expect(http).toContain(PUBLISHED_ORIGIN)

    // It is also the fallback, so a request with no/unknown Origin still names
    // the research site rather than something else.
    expect(http).toContain(`: "${PUBLISHED_ORIGIN}"`)
  })

  test('the production API base is the deployed Vercel endpoint, not a local override', () => {
    const service = read('./services/extract.js')
    expect(service).toContain("'https://io-tutor-mine.vercel.app/api'")
    // The override must be opt-in via an env var, never the default.
    expect(service).toMatch(/import\.meta\.env\?\.VITE_API_BASE \|\|/)
  })

  test('no Supabase or database credential is referenced anywhere in the frontend source', () => {
    const files = [
      './services/extract.js',
      './services/history.js',
      './services/youtube.js',
      './services/progress.js',
      './views/AllExtractionsPage.vue',
      './views/MyExtractionsPage.vue',
      './views/ExtractionDetailPage.vue'
    ]

    for (const file of files) {
      const source = read(file)
      expect(source, `${file} must not reference Supabase`).not.toMatch(/supabase/i)
      expect(source, `${file} must not carry a key`).not.toMatch(/service_role|SUPABASE_|GEMINI_KEY/)
    }
  })
})
