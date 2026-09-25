/**
 * Integration tests against a REAL Supabase / PostgREST / Postgres instance.
 *
 * These exercise the actual SQL in supabase/migrations/0001_shared_extractions.sql:
 * the unique constraint, the CHECK constraints, the lease-based claim, real
 * row locking under genuine parallelism, RLS, and the trigram search index.
 * The mocked suite cannot prove any of that.
 *
 * Skipped unless SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set. Run with:
 *   npm run test:integration            (starts nothing; expects a stack)
 *   npm run supabase:test               (wires up the local stack for you)
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import * as store from '../../api/_lib/store.js';
import handler from '../../api/extract.js';
import listHandler from '../../api/extractions.js';
import { SPEC_VERSION } from '../../api/_lib/spec.js';
import { installWorld, mockReq, mockRes } from '../helpers/world.js';

const URL_BASE = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const configured = Boolean(URL_BASE && SERVICE_KEY);
const options = configured
  ? {}
  : { skip: 'set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to run the integration suite' };

const env = { SUPABASE_URL: URL_BASE, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };
const host = configured ? new URL(URL_BASE).hostname : null;

/**
 * Everything this run creates, so it can be removed afterwards. The suite must
 * never leave residue in a real project - see the `after` hook below.
 */
const CREATED_VIDEO_IDS = new Set();
const CREATED_BUCKETS = new Set();

/** A fresh, valid 11-character video id so tests never collide. */
function newVideoId() {
  const id = randomBytes(8).toString('base64url').slice(0, 11).padEnd(11, 'a');
  CREATED_VIDEO_IDS.add(id);
  return id;
}

const canonical = id => `https://www.youtube.com/watch?v=${id}`;

const COMPONENTS = [
  { name: 'Arduino Uno', status: 'USED' },
  { name: 'DHT11', status: 'USED' },
  { name: 'DHT22', status: 'ALTERNATIVE', alternativeTo: 'DHT11' }
];

/** Raw PostgREST call, for things the store deliberately does not expose. */
async function raw(path, { method = 'GET', body, key = SERVICE_KEY, headers = {} } = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

async function complete(videoId, overrides = {}) {
  return store.completeExtraction(env, {
    videoId,
    specVersion: SPEC_VERSION,
    canonicalUrl: canonical(videoId),
    title: 'DHT11 with Arduino Uno',
    channel: 'Surtrtech',
    durationSeconds: 742,
    thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    components: COMPONENTS,
    model: 'gemini-3-flash-preview',
    source: 'youtube-url',
    publicationStatus: 'published',
    reviewReason: null,
    searchText: 'dht11 with arduino uno surtrtech arduino uno dht11 dht22',
    ...overrides
  });
}

/* ========================================================================== */
/* Schema and constraints                                                     */
/* ========================================================================== */

test('the migration created the extractions table with the expected shape', options, async () => {
  const { ok, status } = await raw('/rest/v1/extractions?select=id&limit=1');
  assert.ok(ok, `expected the table to be readable with the service key, got ${status}`);
});

test('the video id CHECK constraint rejects malformed ids at the database level', options, async () => {
  const bad = await raw('/rest/v1/extractions', {
    method: 'POST',
    body: { video_id: 'not-a-valid-id-at-all', spec_version: SPEC_VERSION, canonical_url: 'x' }
  });

  assert.equal(bad.ok, false, 'the database must refuse a malformed video id');
  assert.match(JSON.stringify(bad.data), /extractions_video_id_format|violates check constraint/i);
});

test('the unique index enforces one row per (video_id, spec_version)', options, async () => {
  const id = newVideoId();

  const first = await raw('/rest/v1/extractions', {
    method: 'POST',
    body: { video_id: id, spec_version: SPEC_VERSION, canonical_url: canonical(id) }
  });
  assert.ok(first.ok);

  const duplicate = await raw('/rest/v1/extractions', {
    method: 'POST',
    body: { video_id: id, spec_version: SPEC_VERSION, canonical_url: canonical(id) }
  });

  assert.equal(duplicate.status, 409, 'a duplicate must be rejected by the unique index');
  assert.match(JSON.stringify(duplicate.data), /extractions_video_spec_uniq|duplicate key/i);
});

test('a different spec version coexists rather than colliding', options, async () => {
  const id = newVideoId();

  await complete(id);
  await complete(id, { specVersion: 'v-other-spec' });

  const rows = await raw(`/rest/v1/extractions?select=spec_version&video_id=eq.${id}`);
  assert.equal(rows.data.length, 2);
});

test('the publication_status CHECK constraint rejects unknown values', options, async () => {
  const id = newVideoId();
  await complete(id);

  const bad = await raw(`/rest/v1/extractions?video_id=eq.${id}`, {
    method: 'PATCH',
    body: { publication_status: 'totally-made-up' }
  });

  assert.equal(bad.ok, false);
});

/* ========================================================================== */
/* RLS                                                                        */
/* ========================================================================== */

test('RLS blocks the anon key from reading the table', options, async () => {
  if (!ANON_KEY) return; // key not supplied; the service-role path is still covered

  const id = newVideoId();
  await complete(id);

  const res = await raw(`/rest/v1/extractions?select=*&video_id=eq.${id}`, { key: ANON_KEY });

  // Either a hard 401/403, or an empty result because no policy grants a row.
  const blocked = !res.ok || (Array.isArray(res.data) && res.data.length === 0);
  assert.ok(blocked, `anon key must not read extractions, got ${res.status} ${JSON.stringify(res.data)}`);
});

test('RLS blocks the anon key from writing', options, async () => {
  if (!ANON_KEY) return;

  const id = newVideoId();
  const res = await raw('/rest/v1/extractions', {
    method: 'POST',
    key: ANON_KEY,
    body: { video_id: id, spec_version: SPEC_VERSION, canonical_url: canonical(id) }
  });

  assert.equal(res.ok, false, 'anon key must not be able to insert');

  const check = await raw(`/rest/v1/extractions?select=id&video_id=eq.${id}`);
  assert.equal(check.data.length, 0, 'nothing may have been written');
});

test('the privileged functions are not callable with the anon key', options, async () => {
  if (!ANON_KEY) return;

  const id = newVideoId();
  const res = await raw('/rest/v1/rpc/claim_extraction', {
    method: 'POST',
    key: ANON_KEY,
    body: {
      p_video_id: id,
      p_spec_version: SPEC_VERSION,
      p_canonical_url: canonical(id),
      p_stale_seconds: 180,
      p_force: false
    }
  });

  assert.equal(res.ok, false, 'EXECUTE was revoked from anon, so this must fail');
});

/* ========================================================================== */
/* claim / complete / fail lifecycle                                          */
/* ========================================================================== */

test('claim -> complete -> claim yields a real cache hit', options, async () => {
  const id = newVideoId();

  const first = await store.claimExtraction(env, {
    videoId: id, specVersion: SPEC_VERSION, canonicalUrl: canonical(id), staleSeconds: 180
  });
  assert.equal(first.outcome, 'claimed');

  await complete(id);

  const second = await store.claimExtraction(env, {
    videoId: id, specVersion: SPEC_VERSION, canonicalUrl: canonical(id), staleSeconds: 180
  });
  assert.equal(second.outcome, 'ready');
  assert.equal(second.row.components.length, 3);

  const found = await store.findReady(env, id, SPEC_VERSION);
  assert.equal(found.video_id, id);
  assert.equal(found.component_count, 3);
  assert.equal(found.duration_seconds, 742);
});

test('a live lease reports "processing" to a second caller', options, async () => {
  const id = newVideoId();

  const a = await store.claimExtraction(env, {
    videoId: id, specVersion: SPEC_VERSION, canonicalUrl: canonical(id), staleSeconds: 180
  });
  const b = await store.claimExtraction(env, {
    videoId: id, specVersion: SPEC_VERSION, canonicalUrl: canonical(id), staleSeconds: 180
  });

  assert.equal(a.outcome, 'claimed');
  assert.equal(b.outcome, 'processing');
});

test('an expired lease is reclaimed', options, async () => {
  const id = newVideoId();

  await store.claimExtraction(env, {
    videoId: id, specVersion: SPEC_VERSION, canonicalUrl: canonical(id), staleSeconds: 180
  });

  // Expire the lease the way the passage of time would.
  await raw(`/rest/v1/extractions?video_id=eq.${id}`, {
    method: 'PATCH',
    body: { lock_until: new Date(Date.now() - 60_000).toISOString() }
  });

  const retry = await store.claimExtraction(env, {
    videoId: id, specVersion: SPEC_VERSION, canonicalUrl: canonical(id), staleSeconds: 180
  });
  assert.equal(retry.outcome, 'claimed');
});

test('a failure on a fresh row marks it failed and releases the lease', options, async () => {
  const id = newVideoId();

  await store.claimExtraction(env, {
    videoId: id, specVersion: SPEC_VERSION, canonicalUrl: canonical(id), staleSeconds: 180
  });

  const { preserved } = await store.failExtraction(env, {
    videoId: id, specVersion: SPEC_VERSION, message: 'Gemini quota exceeded'
  });

  assert.equal(preserved, false);

  const row = await raw(`/rest/v1/extractions?select=status,lock_until,error_message&video_id=eq.${id}`);
  assert.equal(row.data[0].status, 'failed');
  assert.equal(row.data[0].lock_until, null);
});

test('18. a failed refresh never destroys a stored successful result', options, async () => {
  const id = newVideoId();
  await complete(id);

  // Forced refresh takes the lease but must leave the success intact.
  const claim = await store.claimExtraction(env, {
    videoId: id, specVersion: SPEC_VERSION, canonicalUrl: canonical(id), staleSeconds: 180, force: true
  });
  assert.equal(claim.outcome, 'claimed');

  const during = await store.findReady(env, id, SPEC_VERSION);
  assert.ok(during, 'the previous result must still be servable during a refresh');
  assert.equal(during.components.length, 3);

  const { preserved } = await store.failExtraction(env, {
    videoId: id, specVersion: SPEC_VERSION, message: 'model failed'
  });
  assert.equal(preserved, true, 'the SQL must report that it preserved a success');

  const after = await raw(
    `/rest/v1/extractions?select=status,components,publication_status,lock_until&video_id=eq.${id}`
  );
  assert.equal(after.data[0].status, 'ready');
  assert.equal(after.data[0].components.length, 3);
  assert.equal(after.data[0].publication_status, 'published');
  assert.equal(after.data[0].lock_until, null);
});

test('a moderator decision to hide an entry survives a later successful refresh', options, async () => {
  const id = newVideoId();
  await complete(id);

  await raw(`/rest/v1/extractions?video_id=eq.${id}`, {
    method: 'PATCH',
    body: { publication_status: 'hidden' }
  });

  await complete(id, { publicationStatus: 'published' });

  const row = await raw(`/rest/v1/extractions?select=publication_status&video_id=eq.${id}`);
  assert.equal(row.data[0].publication_status, 'hidden', 'moderation must be sticky');
});

test('completing with null metadata does not wipe previously known metadata', options, async () => {
  const id = newVideoId();
  await complete(id);

  await complete(id, { title: null, channel: null, durationSeconds: null });

  const row = await raw(`/rest/v1/extractions?select=title,duration_seconds&video_id=eq.${id}`);
  assert.equal(row.data[0].title, 'DHT11 with Arduino Uno');
  assert.equal(row.data[0].duration_seconds, 742);
});

/* ========================================================================== */
/* Real concurrency                                                           */
/* ========================================================================== */

test('14. eight genuinely parallel claims produce exactly one winner and one row', options, async () => {
  const id = newVideoId();

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.claimExtraction(env, {
        videoId: id, specVersion: SPEC_VERSION, canonicalUrl: canonical(id), staleSeconds: 180
      })
    )
  );

  const claimed = results.filter(r => r.outcome === 'claimed');
  const processing = results.filter(r => r.outcome === 'processing');

  assert.equal(claimed.length, 1, `exactly one caller may win, got ${claimed.length}`);
  assert.equal(processing.length, 7);

  const rows = await raw(`/rest/v1/extractions?select=id&video_id=eq.${id}`);
  assert.equal(rows.data.length, 1, 'the race must not create duplicate rows');
});

test('the rate limiter counts correctly under parallel load', options, async () => {
  const bucket = `test:${randomBytes(6).toString('hex')}`;
  CREATED_BUCKETS.add(bucket);

  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      store.checkRateLimit(env, { bucket, limit: 5, windowSeconds: 3600 })
    )
  );

  const allowed = results.filter(Boolean).length;
  assert.equal(allowed, 5, `exactly the limit may be allowed, got ${allowed}`);
});

/* ========================================================================== */
/* Public library reads                                                       */
/* ========================================================================== */

test('19. trigram search matches titles and component names, case-insensitively', options, async () => {
  const dht = newVideoId();
  const ultra = newVideoId();

  await complete(dht, {
    title: 'DHT11 Temperature Sensor Tutorial',
    searchText: 'dht11 temperature sensor tutorial surtrtech arduino uno dht11 dht22'
  });
  await complete(ultra, {
    title: 'Ultrasonic Sensors with Arduino',
    components: [{ name: 'HC-SR04', status: 'USED' }],
    searchText: 'ultrasonic sensors with arduino robonyx hc-sr04 arduino uno'
  });

  const byComponent = await store.listPublished(env, { q: 'DhT11', limit: 50 });
  const ids = byComponent.map(r => r.video_id);
  assert.ok(ids.includes(dht), 'searching a component name must find its video');
  assert.ok(!ids.includes(ultra));

  const byTitle = await store.listPublished(env, { q: 'ULTRASONIC', limit: 50 });
  assert.ok(byTitle.map(r => r.video_id).includes(ultra));

  const byPartial = await store.listPublished(env, { q: 'hc-sr', limit: 50 });
  assert.ok(byPartial.map(r => r.video_id).includes(ultra));

  const none = await store.listPublished(env, { q: 'zzz-no-such-component', limit: 50 });
  assert.equal(none.length, 0);
});

test('a search term containing PostgREST syntax cannot break the filter', options, async () => {
  for (const q of ['a,b', 'x(y)', 'a*b', 'back\\slash', "quote'd"]) {
    const rows = await store.listPublished(env, { q, limit: 5 });
    assert.ok(Array.isArray(rows), `query ${q} should return a result set, not an error`);
  }
});

test('only published, ready rows appear in the public listing', options, async () => {
  const published = newVideoId();
  const hidden = newVideoId();
  const failed = newVideoId();
  const tag = randomBytes(5).toString('hex');

  await complete(published, { searchText: `marker ${tag} published` });
  await complete(hidden, { searchText: `marker ${tag} hidden` });
  await complete(failed, { searchText: `marker ${tag} failed` });

  await raw(`/rest/v1/extractions?video_id=eq.${hidden}`, {
    method: 'PATCH', body: { publication_status: 'hidden' }
  });
  await raw(`/rest/v1/extractions?video_id=eq.${failed}`, {
    method: 'PATCH', body: { status: 'failed' }
  });

  const rows = await store.listPublished(env, { q: tag, limit: 50 });
  const ids = rows.map(r => r.video_id);

  assert.deepEqual(ids, [published]);
});

test('the public projection never leaks internal columns', options, async () => {
  const id = newVideoId();
  await complete(id, { reviewReason: 'internal-only-reason' });

  await raw(`/rest/v1/extractions?video_id=eq.${id}`, {
    method: 'PATCH', body: { error_message: 'internal detail that must not leak' }
  });

  const row = await store.findPublished(env, id);
  const serialised = JSON.stringify(row);

  assert.doesNotMatch(serialised, /internal detail/);
  assert.doesNotMatch(serialised, /internal-only-reason/);
  assert.equal(row.error_message, undefined);
  assert.equal(row.lock_until, undefined);
  assert.equal(row.search_text, undefined);
});

test('listing is ordered newest-first and pages correctly', options, async () => {
  const tag = randomBytes(5).toString('hex');
  const ids = [];

  for (let i = 0; i < 5; i++) {
    const id = newVideoId();
    ids.push(id);
    await complete(id, { searchText: `page ${tag} item ${i}` });
  }

  const page1 = await store.listPublished(env, { q: tag, limit: 2, offset: 0 });
  const page2 = await store.listPublished(env, { q: tag, limit: 2, offset: 2 });

  assert.equal(page1.length, 2);
  assert.equal(page2.length, 2);
  assert.equal(new Set([...page1, ...page2].map(r => r.video_id)).size, 4, 'pages must not overlap');

  // Newest first: the last one written comes first.
  assert.equal(page1[0].video_id, ids[4]);
});

/* ========================================================================== */
/* End-to-end handler against the real database                               */
/* ========================================================================== */

async function post(body) {
  const res = mockRes();
  const client = `itm-test-${randomBytes(4).toString('hex')}`;
  await handler(mockReq({ body, headers: { 'x-forwarded-for': client } }), res);
  return res;
}

function withRealDb(fn, worldOptions = {}) {
  const world = installWorld({ db: null, passthroughHost: host, ...worldOptions });
  const saved = { ...process.env };
  process.env.GEMINI_KEY = 'gemini-test-key';

  return (async () => {
    try {
      return await fn(world.counters);
    } finally {
      world.restore();
      Object.assign(process.env, saved);
    }
  })();
}

test('10/12. end to end: extract once, then serve from the real shared cache', options, async () => {
  const id = newVideoId();

  await withRealDb(async counters => {
    const first = await post({ url: canonical(id) });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.published, true);
    assert.equal(first.body.components.length, 3);
    assert.equal(counters.gemini, 1);

    // A different URL format, as a different user would submit it.
    const second = await post({ url: `https://youtu.be/${id}` });
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.cached, true);
    assert.equal(counters.gemini, 1, 'the real cache hit must not call the model again');
  });

  const rows = await raw(`/rest/v1/extractions?select=id&video_id=eq.${id}`);
  assert.equal(rows.data.length, 1, 'no duplicate row in the real database');
});

test('14. end to end: parallel requests for an uncached video call the model once', options, async () => {
  const id = newVideoId();

  await withRealDb(async counters => {
    const [a, b, c] = await Promise.all([
      post({ url: canonical(id) }),
      post({ url: `https://youtu.be/${id}` }),
      post({ url: `https://www.youtube.com/shorts/${id}` })
    ]);

    for (const res of [a, b, c]) {
      assert.ok([200, 202].includes(res.statusCode), `unexpected status ${res.statusCode}`);
    }

    assert.equal(counters.gemini, 1, `the model ran ${counters.gemini} times, expected 1`);

    const succeeded = [a, b, c].filter(r => r.statusCode === 200);
    assert.ok(succeeded.length >= 1);
    for (const res of succeeded) assert.equal(res.body.components.length, 3);
  }, { env: { PEER_WAIT_MS: '15000', PEER_POLL_MS: '250' } });

  const rows = await raw(`/rest/v1/extractions?select=id&video_id=eq.${id}`);
  assert.equal(rows.data.length, 1, 'a real race must still produce exactly one row');
});

test('16. an ineligible video is stored as not-published in the real database', options, async () => {
  const id = newVideoId();

  await withRealDb(async counters => {
    const res = await post({ url: canonical(id) });
    assert.equal(res.statusCode, 422);
    assert.equal(counters.gemini, 0);
  }, {
    metadata: { title: 'Classic Lasagne Recipe', author_name: 'Home Cooking' },
    transcriptText:
      'welcome back to the kitchen today we are making a classic lasagne start by browning ' +
      'the mince in olive oil with garlic and onion then add the tomatoes and layer the pasta ' +
      'sheets with bechamel and plenty of grated parmesan cheese on top bake for forty minutes ' +
      'until golden brown and let it rest before slicing and serving to six people at the table ' +
      'this recipe keeps well in the fridge for a couple of days and freezes beautifully too ' +
      'so make a double batch if you are cooking for a crowd this weekend and enjoy your meal'
  });

  const row = await raw(`/rest/v1/extractions?select=status,publication_status&video_id=eq.${id}`);
  assert.equal(row.data.length, 1);
  assert.notEqual(row.data[0].publication_status, 'published');
});

test('11. the public API returns the stored entry to an unrelated caller', options, async () => {
  const id = newVideoId();

  await withRealDb(async () => {
    await post({ url: canonical(id) });
  });

  const saved = { ...process.env };
  Object.assign(process.env, env);

  try {
    const marked = query => mockReq({
      method: 'GET',
      query,
      headers: { 'x-forwarded-for': `itm-test-${randomBytes(4).toString('hex')}` }
    });

    const listRes = mockRes();
    await listHandler(marked({ q: 'dht11', limit: '50' }), listRes);
    assert.equal(listRes.statusCode, 200);
    assert.ok(listRes.body.items.some(i => i.videoId === id), 'the entry must be publicly listed');

    const oneRes = mockRes();
    await listHandler(marked({ videoId: id }), oneRes);
    assert.equal(oneRes.statusCode, 200);
    assert.equal(oneRes.body.item.videoId, id);
    assert.equal(oneRes.body.item.components.length, 3);
    assert.equal(oneRes.body.item.title, 'DHT11 with Arduino Uno');
  } finally {
    Object.assign(process.env, saved);
  }
});


/* ========================================================================== */
/* Cleanup                                                                    */
/* ========================================================================== */

/**
 * Remove every row this run created. Scoped strictly to the ids and buckets
 * recorded above, so it can never touch data the tests did not produce.
 */
after(async () => {
  if (!configured) return;

  if (CREATED_VIDEO_IDS.size) {
    const list = [...CREATED_VIDEO_IDS].join(',');
    await raw(`/rest/v1/extractions?video_id=in.(${list})`, { method: 'DELETE' });
  }

  for (const bucket of CREATED_BUCKETS) {
    await raw(`/rest/v1/rate_limits?bucket=eq.${encodeURIComponent(bucket)}`, { method: 'DELETE' });
  }

  // Rate-limit rows created by the handler tests all carry this marker prefix.
  await raw('/rest/v1/rate_limits?bucket=like.*:itm-test-*', { method: 'DELETE' });

  const left = await raw(
    `/rest/v1/extractions?select=video_id&video_id=in.(${[...CREATED_VIDEO_IDS].join(',')})`
  );
  const remaining = Array.isArray(left.data) ? left.data.length : 0;
  console.log(`# cleanup: removed ${CREATED_VIDEO_IDS.size} test rows, ${remaining} remaining`);
});
