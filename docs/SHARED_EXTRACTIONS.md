# Shared extraction platform

How the extraction side of IoTutorMine works: the progress indicator, the
per-browser history, and the shared public library. The curated research
catalog in `frontend/src/data/videos.js` is untouched by all of this and stays
logically separate.

---

## 1. Three surfaces

| Surface | Route | Storage | Scope |
|---|---|---|---|
| Home (research catalog + extraction form) | `/` | `src/data/videos.js`, static | unchanged |
| My Extractions | `/my-extractions` | this browser's `localStorage` | one browser, one device |
| All Extractions | `/extractions` | Supabase, via the Vercel API | everyone |

Community extractions are never merged into the curated catalog, and nothing in
the extraction flow writes to `videos.js`.

---

## 2. Lookup order

A submitted URL is resolved in this order, stopping at the first hit:

1. **Normalise** the URL to a canonical 11-character video id
   (`api/_lib/youtube.js`, mirrored client-side in
   `frontend/src/services/youtube.js`). Unsupported hosts and malformed ids are
   rejected here.
2. **Personal history** — if this browser already extracted that video id, the
   saved result is shown immediately with no network call. Bypassed by
   *Re-extract*.
3. **Shared cache** — `POST /api/extract` looks for a `ready` row for
   `(video_id, spec_version)`. On a hit it returns it and the model is not
   called.
4. **Claim** — `claim_extraction()` atomically takes a lease. If another
   serverless instance holds a live lease, this request waits for that result
   instead of starting a second model run.
5. **Extract** — metadata, transcript, eligibility check, then Gemini.
6. **Persist** — `complete_extraction()` writes the result and sets the
   publication status.

The backend is authoritative: step 2 is a convenience, and the server re-checks
everything regardless of what the client believes.

### Why a lease rather than a status flag

A forced refresh takes the lease but leaves `status = 'ready'` and the previous
components in place, so readers keep being served the last good result while the
refresh runs. If the refresh then fails, `fail_extraction()` refuses to
downgrade a row that already holds a success — it only releases the lease.

### Spec versioning

`SPEC_VERSION` is derived from a SHA-256 of `MODEL + PROMPT`
(`api/_lib/spec.js`). Editing either starts a new generation of rows rather than
mixing incompatible results under one video id. The uniqueness constraint is on
`(video_id, spec_version)`, so old and new results coexist without colliding.

---

## 3. Validation workflow

Cheap checks run before any model spend.

| Stage | Check | On failure |
|---|---|---|
| URL | host allowlist + 11-char id | `400`, nothing stored |
| Availability | YouTube oEmbed | `404` if deleted/private; a network error is treated as "unknown", not "gone" |
| Transcript | watch page captions, then Supadata | `422` with `needsTranscript`, offering the manual paste |
| Relevance | hardware/tutorial vocabulary over the **transcript**, not just the title | `422` with a plain message; the model is never called |
| Schema | names, `USED`/`ALTERNATIVE`, dedupe, `alternativeTo` | `422`, not published |
| Publication | see below | stored but held back |

Relevance is deliberately conservative. It rejects only when a substantial
transcript (≥400 characters) contains no hardware vocabulary *and* the metadata
does not either. An unusual title alone never rejects a video; thin evidence
yields `uncertain`, which is allowed through to the model.

`publication_status` is one of `pending`, `published`, `rejected`, `hidden`. A
`hidden` or `rejected` row stays that way through later refreshes, so a
moderation decision is not silently undone.

Published rows are **extracted results, not verified ground truth**, and the UI
says so.

### Manual transcripts

Pasted transcripts still work exactly as before. They are saved to My
Extractions but are **never** written to the shared library: there is no way to
establish that pasted text corresponds to the linked video.

---

## 4. Personal vs shared storage

`localStorage`, key `iotutormine.extractions.v1`:

- stores video id, original URL, title, duration, thumbnail, components,
  statuses, timestamps, and the shared row id when there is one;
- **never** stores raw transcripts, API keys, or secrets;
- degrades to an in-memory session if storage is blocked, full, or corrupted;
- is per-browser. It does not sync across devices, and clearing site data
  removes it. The UI states this rather than implying sync.

The shared library is the cross-device surface, and it is read through the
backend only. The frontend holds no database credentials of any kind.

---

## 5. Security posture

- The service-role key lives only in Vercel env vars. RLS is enabled on both
  tables with **no policies**, so anon/authenticated keys have no access at all.
- No user-supplied URL is ever a fetch destination. Outbound requests are built
  from the validated video id against hard-coded hosts, and even the caption
  track URL returned by YouTube is host-checked before use.
- Rate limits are counted in Postgres (`bump_rate_limit`), so they hold across
  serverless instances: 10 extractions / 10 min and 3 forced refreshes / hour
  per client, 120 browse requests / min.
- CORS restricts which browser origins may read responses. It is not treated as
  authentication or as a rate limit; those are enforced independently.
- Public responses are projected through a fixed column list. Internal error
  text, lease state, and review reasons never leave the server.

---

## 6. Deployment

### Supabase

1. Create a project (the free tier is sufficient).
2. Run `supabase/migrations/0001_shared_extractions.sql` in the SQL Editor. It
   is idempotent.
3. Copy the project URL and the **service role** key from
   Settings → API.

### Vercel

Set these in the existing project (Settings → Environment Variables), then
redeploy. See `.env.example` for the full list.

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_KEY` | yes | component extraction (already set) |
| `SUPADATA_KEY` | no | transcript fallback (already set) |
| `SUPABASE_URL` | for the shared library | project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | for the shared library | service role key |
| `REFRESH_TOKEN` | no | gate forced re-extraction |
| `PEER_WAIT_MS` / `PEER_POLL_MS` | no | tune the concurrent-request wait |

Until `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, the API still
extracts normally — just with no caching and no shared library, and
`/api/extractions` reports `configured: false` so the page can say so.

The repository root gained a `package.json` declaring `"type": "module"`, which
makes the ESM syntax the API already used explicit. It has no build script, so
Vercel continues to build only the functions in `api/`.

### GitHub Pages

Unchanged, except that `frontend/public/404.html` now provides the SPA fallback
GitHub Pages otherwise lacks. Without it, refreshing any deep route — including
the pre-existing `/video/:id` — returns a 404.

---

## 7. Running it locally

The whole stack runs on a developer machine, with no Supabase account:

```bash
npx supabase start                  # Postgres + PostgREST in Docker; applies the migration
node scripts/dev-api.mjs            # the Vercel functions on http://localhost:3001
cd frontend && VITE_API_BASE=http://localhost:3001/api npm run dev
```

`scripts/dev-api.mjs` reproduces the request shape Vercel gives a handler
(`req.query`, parsed `req.body`, `res.status().json()`), so `api/*.js` runs
unmodified. `VITE_API_BASE` is a development-only override; production builds
set no such variable and keep calling the deployed Vercel endpoint.

Stop the stack with `npx supabase stop`.

## 8. Tests

Three tiers:

```bash
npm test                 # fast, mocked: routing, caching, validation (node:test)
npm run test:integration # REAL Postgres + PostgREST + real HTTP
cd frontend && npm test  # components, pages, routing, SPA fallback (vitest)
```

The mocked suite runs against a fake Supabase that reproduces the SQL semantics,
so it stays fast and needs no Docker.

The integration suite is the one that proves the design. It runs against a real
Supabase instance and covers what a mock cannot:

- the migration applies cleanly, and the CHECK and UNIQUE constraints fire;
- RLS actually blocks the anon key from reading, writing, and calling the
  privileged functions;
- `claim_extraction` under genuine parallelism — eight concurrent claims yield
  exactly one winner and one row;
- the rate limiter counts correctly under parallel load;
- `fail_extraction` preserves a stored success;
- trigram search matches titles and component names case-insensitively;
- the handlers over real sockets: query parsing, JSON bodies, status codes, and
  the CORS headers a browser on the published site will actually receive.

It skips automatically unless `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are
set. `npm run test:integration` wires up the local stack for you; export those
two variables yourself to point it at a hosted project instead.

---

## 9. Known limitations

- The shared library requires Supabase provisioning; it is inert until then.
- Relevance screening is a heuristic. It is tuned to avoid rejecting valid
  tutorials, so some marginal content will reach the model.
- There is no authentication, so moderation (`hidden` / `rejected`) is currently
  a manual database operation.
- Video duration comes from the YouTube watch page. When that scrape changes
  shape, duration is simply absent rather than wrong.
