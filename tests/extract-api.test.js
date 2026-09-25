import test from 'node:test';
import assert from 'node:assert/strict';

import handler from '../api/extract.js';
import listHandler from '../api/extractions.js';
import { SPEC_VERSION } from '../api/_lib/spec.js';
import {
  createDb,
  envWithDb,
  installWorld,
  mockReq,
  mockRes
} from './helpers/world.js';

const VIDEO_ID = 'KGwtit2bFyo';
const URL_LONG = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const URL_SHORT = `https://youtu.be/${VIDEO_ID}`;

/** Run a request against the handler with the given environment and doubles. */
async function withWorld(worldOptions, fn) {
  const db = worldOptions.db || createDb();
  const world = installWorld({ ...worldOptions, db });

  const saved = { ...process.env };
  Object.assign(process.env, envWithDb(), worldOptions.env || {});

  try {
    return await fn({ db, counters: world.counters });
  } finally {
    world.restore();
    for (const k of [
      'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_KEY', 'SUPADATA_KEY',
      'REFRESH_TOKEN', 'PEER_WAIT_MS', 'PEER_POLL_MS'
    ]) {
      delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
}

async function post(body, headers) {
  const res = mockRes();
  await handler(mockReq({ body, headers }), res);
  return res;
}

async function get(query) {
  const res = mockRes();
  await listHandler(mockReq({ method: 'GET', query }), res);
  return res;
}

/* -------------------------------------------------------------------------- */
/* 15. input validation                                                        */
/* -------------------------------------------------------------------------- */

test('15. an invalid URL is rejected without touching the model or the database', async () => {
  await withWorld({}, async ({ counters, db }) => {
    for (const url of ['https://example.com/video', 'not a url', 'https://vimeo.com/1']) {
      const res = await post({ url });
      assert.equal(res.statusCode, 400, `expected 400 for ${url}`);
      assert.match(res.body.error, /supported YouTube/i);
    }

    const empty = await post({});
    assert.equal(empty.statusCode, 400);

    assert.equal(counters.gemini, 0, 'the model must never be called for an invalid URL');
    assert.equal(db.rows.size, 0, 'no database row may be created for an invalid URL');
  });
});

test('an oversized transcript is rejected', async () => {
  await withWorld({}, async ({ counters }) => {
    const res = await post({ transcript: 'x'.repeat(200_000) });
    assert.equal(res.statusCode, 413);
    assert.equal(counters.gemini, 0);
  });
});

test('non-POST methods are refused and CORS headers are set', async () => {
  await withWorld({}, async () => {
    const res = mockRes();
    await handler(mockReq({ method: 'GET' }), res);
    assert.equal(res.statusCode, 405);
    assert.ok(res.headers['Access-Control-Allow-Origin']);

    const preflight = mockRes();
    await handler(mockReq({ method: 'OPTIONS' }), preflight);
    assert.equal(preflight.statusCode, 204);
  });
});

/* -------------------------------------------------------------------------- */
/* 10 / 12 / 13. extraction, caching, and canonical identity                    */
/* -------------------------------------------------------------------------- */

test('10. a fresh extraction calls the model once and stores a published row', async () => {
  await withWorld({}, async ({ db, counters }) => {
    const res = await post({ url: URL_LONG });

    assert.equal(res.statusCode, 200);
    assert.equal(counters.gemini, 1);
    assert.equal(res.body.videoId, VIDEO_ID);
    assert.equal(res.body.title, 'DHT11 with Arduino Uno');
    assert.equal(res.body.durationSeconds, 742);
    assert.equal(res.body.components.length, 3);
    assert.equal(res.body.cached, false);
    assert.equal(res.body.published, true);

    const row = db.get(VIDEO_ID, SPEC_VERSION);
    assert.equal(row.status, 'ready');
    assert.equal(row.publication_status, 'published');
    assert.equal(row.lock_until, null, 'the lease must be released after completion');
    assert.match(row.search_text, /dht11/);
  });
});

test('12. a repeat submission is served from the shared cache with no further model call', async () => {
  await withWorld({}, async ({ db, counters }) => {
    await post({ url: URL_LONG });
    assert.equal(counters.gemini, 1);

    const second = await post({ url: URL_LONG });
    assert.equal(second.statusCode, 200);
    assert.equal(counters.gemini, 1, 'Gemini must not be called again for a cache hit');
    assert.equal(second.body.cached, true);
    assert.equal(second.body.cacheHit, 'shared');
    assert.equal(db.rows.size, 1, 'no duplicate row');
  });
});

test('11/13. a different URL format for the same video hits the same cached row', async () => {
  await withWorld({}, async ({ db, counters }) => {
    // User A
    const first = await post({ url: URL_LONG });
    assert.equal(first.statusCode, 200);

    // User B, different browser, different valid URL shape, no local history.
    const second = await post({ url: URL_SHORT });

    assert.equal(second.statusCode, 200);
    assert.equal(counters.gemini, 1, 'the second user must not trigger a new model call');
    assert.equal(second.body.cached, true);
    assert.equal(second.body.videoId, VIDEO_ID);
    assert.deepEqual(second.body.components, first.body.components);
    assert.equal(db.rows.size, 1, 'the same video must not produce a second row');
  });
});

test('14. two simultaneous requests produce one row and one model call', async () => {
  await withWorld({}, async ({ db, counters }) => {
    const [a, b] = await Promise.all([post({ url: URL_LONG }), post({ url: URL_SHORT })]);

    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.equal(db.rows.size, 1, 'exactly one shared row');
    assert.equal(counters.gemini, 1, 'the loser of the race must reuse the winner’s result');

    // Both callers received the same components.
    assert.deepEqual(a.body.components, b.body.components);
    // Exactly one of them is a cache/concurrent hit.
    const hits = [a.body.cacheHit, b.body.cacheHit].filter(Boolean);
    assert.equal(hits.length, 1);
    assert.match(hits[0], /^shared/);
  });
});

test('a live lease from another instance is waited on rather than duplicated', async () => {
  const db = createDb();
  // Simulate a peer that claimed the video 1 second ago and is still working.
  db.seed({
    video_id: VIDEO_ID,
    spec_version: SPEC_VERSION,
    canonical_url: URL_LONG,
    status: 'processing',
    publication_status: 'pending',
    lock_until: Date.now() + 120_000
  });

  await withWorld({ db, env: { PEER_WAIT_MS: '600', PEER_POLL_MS: '100' } }, async ({ counters }) => {
    const res = await post({ url: URL_LONG });

    assert.equal(res.statusCode, 202);
    assert.equal(res.body.processing, true);
    assert.equal(counters.gemini, 0, 'a second model run must not start while a lease is live');
  });
});

test('an abandoned lease is reclaimed instead of blocking the video forever', async () => {
  const db = createDb();
  db.seed({
    video_id: VIDEO_ID,
    spec_version: SPEC_VERSION,
    canonical_url: URL_LONG,
    status: 'processing',
    publication_status: 'pending',
    lock_until: Date.now() - 60_000 // expired
  });

  await withWorld({ db }, async ({ counters }) => {
    const res = await post({ url: URL_LONG });
    assert.equal(res.statusCode, 200);
    assert.equal(counters.gemini, 1);
    assert.equal(db.rows.size, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* Re-extraction                                                               */
/* -------------------------------------------------------------------------- */

test('an explicit re-extraction bypasses the cache and updates the same row', async () => {
  await withWorld({}, async ({ db, counters }) => {
    await post({ url: URL_LONG });
    assert.equal(counters.gemini, 1);

    const forced = await post({ url: URL_LONG, force: true });
    assert.equal(forced.statusCode, 200);
    assert.equal(counters.gemini, 2, 'a forced refresh does call the model again');
    assert.equal(forced.body.cached, false);
    assert.equal(db.rows.size, 1, 'a refresh must not create a second row');
  });
});

test('a forced refresh is refused without the configured refresh token', async () => {
  await withWorld({ env: { REFRESH_TOKEN: 'secret-token' } }, async ({ counters }) => {
    const denied = await post({ url: URL_LONG, force: true });
    assert.equal(denied.statusCode, 403);
    assert.equal(counters.gemini, 0);

    const allowed = await post(
      { url: URL_LONG, force: true },
      { 'x-refresh-token': 'secret-token' }
    );
    assert.equal(allowed.statusCode, 200);
  });
});

test('18. a failed re-extraction preserves the previous successful result', async () => {
  const db = createDb();

  await withWorld({ db }, async ({ counters }) => {
    const first = await post({ url: URL_LONG });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.components.length, 3);
  });

  // Now the model starts failing.
  await withWorld({ db, geminiFails: true }, async () => {
    const retry = await post({ url: URL_LONG, force: true });
    assert.equal(retry.statusCode, 500);

    const row = db.get(VIDEO_ID, SPEC_VERSION);
    assert.equal(row.status, 'ready', 'the row must not be downgraded to failed');
    assert.equal(row.publication_status, 'published');
    assert.equal(row.components.length, 3, 'the previous components must survive');
    assert.equal(row.lock_until, null, 'the lease must still be released');
  });

  // And the cached result is still served afterwards.
  await withWorld({ db }, async ({ counters }) => {
    const after = await post({ url: URL_LONG });
    assert.equal(after.statusCode, 200);
    assert.equal(after.body.components.length, 3);
    assert.equal(counters.gemini, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* 6 / 7 / 16 / 17. failure, fallback, eligibility, missing metadata            */
/* -------------------------------------------------------------------------- */

test('6. a model failure returns an error and does not publish anything', async () => {
  await withWorld({ geminiFails: true }, async ({ db }) => {
    const res = await post({ url: URL_LONG });

    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /quota/i);

    const row = db.get(VIDEO_ID, SPEC_VERSION);
    assert.equal(row.status, 'failed');
    assert.notEqual(row.publication_status, 'published');
  });
});

test('7. a video with no captions asks for a manual transcript', async () => {
  await withWorld({ captions: false }, async ({ counters }) => {
    const res = await post({ url: URL_LONG });

    assert.equal(res.statusCode, 422);
    assert.equal(res.body.needsTranscript, true);
    assert.match(res.body.error, /paste the transcript manually/i);
    assert.equal(counters.gemini, 0, 'no transcript means no model spend');
  });
});

test('7. the Supadata fallback is used when the watch page has no captions', async () => {
  await withWorld(
    {
      captions: false,
      supadataText: 'arduino uno breadboard dht11 sensor jumper wires circuit tutorial pinout',
      env: { SUPADATA_KEY: 'supadata-test-key' }
    },
    async ({ counters }) => {
      const res = await post({ url: URL_LONG });
      assert.equal(res.statusCode, 200);
      assert.equal(counters.supadata, 1);
      assert.equal(counters.gemini, 1);
    }
  );
});

test('7. a manual transcript still works and is kept out of the shared library', async () => {
  await withWorld({}, async ({ db, counters }) => {
    const res = await post({
      url: URL_LONG,
      transcript: 'we connect the dht11 sensor to the arduino uno using jumper wires'
    });

    assert.equal(res.statusCode, 200);
    assert.equal(counters.gemini, 1);
    assert.equal(res.body.source, 'manual-transcript');
    assert.equal(res.body.published, false);
    assert.equal(res.body.reviewReason, 'manual-transcript-unverified');
    assert.equal(db.rows.size, 0, 'pasted transcripts must not create shared rows');
  });
});

test('16. an unrelated video is refused before the model is called and never published', async () => {
  await withWorld(
    {
      metadata: { title: 'Classic Lasagne Recipe', author_name: 'Home Cooking' },
      transcriptText:
        'welcome back to the kitchen today we are making a classic lasagne start by browning ' +
        'the mince in olive oil with garlic and onion then add the tomatoes and layer the pasta ' +
        'sheets with bechamel and plenty of grated parmesan cheese on top bake for forty minutes ' +
        'until golden brown and let it rest before slicing and serving to six people at the table ' +
        'this recipe keeps well in the fridge for a couple of days and freezes beautifully too ' +
        'so make a double batch if you are cooking for a crowd this weekend and enjoy your meal'
    },
    async ({ db, counters }) => {
      const res = await post({ url: URL_LONG });

      assert.equal(res.statusCode, 422);
      assert.equal(res.body.ineligible, true);
      assert.match(res.body.error, /does not appear to be an IoT hardware tutorial/i);
      assert.equal(counters.gemini, 0, 'eligibility is checked before any model spend');

      const row = db.get(VIDEO_ID, SPEC_VERSION);
      assert.notEqual(row.publication_status, 'published');
    }
  );
});

test('17. an unavailable video is reported and not extracted', async () => {
  await withWorld({ metadataStatus: 404 }, async ({ counters }) => {
    const res = await post({ url: URL_LONG });

    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /unavailable/i);
    assert.equal(counters.gemini, 0);
  });
});

test('17. when metadata is unreachable the result is held back rather than invented', async () => {
  await withWorld({ metadataStatus: 500 }, async ({ db }) => {
    const res = await post({ url: URL_LONG });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.title, null, 'no title may be invented');
    assert.equal(res.body.published, false);
    assert.equal(res.body.reviewReason, 'video-metadata-unavailable');

    const row = db.get(VIDEO_ID, SPEC_VERSION);
    assert.equal(row.publication_status, 'pending');
  });
});

test('a moderator decision to hide an entry survives a later refresh', async () => {
  const db = createDb();

  await withWorld({ db }, async () => {
    await post({ url: URL_LONG });
  });

  db.get(VIDEO_ID, SPEC_VERSION).publication_status = 'hidden';

  await withWorld({ db }, async () => {
    await post({ url: URL_LONG, force: true });
    assert.equal(db.get(VIDEO_ID, SPEC_VERSION).publication_status, 'hidden');
  });
});

/* -------------------------------------------------------------------------- */
/* Rate limiting and degraded mode                                             */
/* -------------------------------------------------------------------------- */

test('9. the per-client rate limit eventually refuses further extractions', async () => {
  await withWorld({}, async () => {
    let limited = null;

    for (let i = 0; i < 14; i++) {
      // A distinct (invalid-but-parsable) video id each time to avoid cache hits.
      const res = await post({ url: `https://youtu.be/vid${String(i).padStart(8, '0')}` });
      if (res.statusCode === 429) {
        limited = res;
        break;
      }
    }

    assert.ok(limited, 'the rate limit must trigger');
    assert.match(limited.body.error, /too many/i);
  });
});

test('without Supabase configured the endpoint still extracts, just without caching', async () => {
  await withWorld({}, async ({ counters }) => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const first = await post({ url: URL_LONG });
    const second = await post({ url: URL_LONG });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.body.components.length, 3);
    assert.equal(counters.gemini, 2, 'with no shared store every request extracts afresh');
  });
});

/* -------------------------------------------------------------------------- */
/* 19. the public library endpoint                                             */
/* -------------------------------------------------------------------------- */

test('19. the public listing searches titles and component names, case-insensitively', async () => {
  const db = createDb();
  db.seed({
    video_id: 'KGwtit2bFyo',
    spec_version: SPEC_VERSION,
    canonical_url: URL_LONG,
    title: 'Ultrasonic Sensors with Arduino',
    components: [{ name: 'HC-SR04', status: 'USED' }],
    search_text: 'ultrasonic sensors with arduino robonyx hc-sr04',
    last_success_at: '2026-01-02T00:00:00.000Z'
  });
  db.seed({
    video_id: 'OogldLc9uYc',
    spec_version: SPEC_VERSION,
    canonical_url: 'https://www.youtube.com/watch?v=OogldLc9uYc',
    title: 'DHT11 Temperature Sensor Tutorial',
    components: [{ name: 'DHT11', status: 'USED' }],
    search_text: 'dht11 temperature sensor tutorial surtrtech dht11 arduino uno',
    last_success_at: '2026-01-01T00:00:00.000Z'
  });

  await withWorld({ db }, async () => {
    const all = await get({});
    assert.equal(all.statusCode, 200);
    assert.equal(all.body.items.length, 2);
    assert.equal(all.body.items[0].videoId, 'KGwtit2bFyo', 'newest first');

    // Search by component name, in the "wrong" case.
    const byComponent = await get({ q: 'DhT11' });
    assert.equal(byComponent.body.items.length, 1);
    assert.equal(byComponent.body.items[0].videoId, 'OogldLc9uYc');

    // Search by title.
    const byTitle = await get({ q: 'ultrasonic' });
    assert.equal(byTitle.body.items.length, 1);

    const none = await get({ q: 'raspberry pi' });
    assert.equal(none.body.items.length, 0);
  });
});

test('the public listing paginates and never dumps the whole table', async () => {
  const db = createDb();
  for (let i = 0; i < 30; i++) {
    db.seed({
      video_id: `vid${String(i).padStart(8, '0')}`,
      spec_version: SPEC_VERSION,
      canonical_url: 'https://www.youtube.com/watch?v=x',
      title: `Video ${i}`,
      search_text: `video ${i}`,
      last_success_at: new Date(Date.now() - i * 1000).toISOString()
    });
  }

  await withWorld({ db }, async () => {
    const page1 = await get({ limit: '10' });
    assert.equal(page1.body.items.length, 10);
    assert.equal(page1.body.hasMore, true);

    const page3 = await get({ limit: '10', offset: '20' });
    assert.equal(page3.body.items.length, 10);
    assert.equal(page3.body.hasMore, false);

    // An absurd limit is clamped.
    const huge = await get({ limit: '100000' });
    assert.ok(huge.body.items.length <= 48);
  });
});

test('the public listing only exposes sanitised, published rows', async () => {
  const db = createDb();
  db.seed({
    video_id: 'KGwtit2bFyo',
    spec_version: SPEC_VERSION,
    canonical_url: URL_LONG,
    title: 'Published one',
    search_text: 'published one',
    error_message: 'internal detail that must not leak',
    review_reason: 'internal-reason'
  });
  db.seed({
    video_id: 'OogldLc9uYc',
    spec_version: SPEC_VERSION,
    canonical_url: 'https://www.youtube.com/watch?v=OogldLc9uYc',
    title: 'Hidden one',
    publication_status: 'hidden',
    search_text: 'hidden one'
  });
  db.seed({
    video_id: 'e1FVSpkw6q4',
    spec_version: SPEC_VERSION,
    canonical_url: 'https://www.youtube.com/watch?v=e1FVSpkw6q4',
    title: 'Failed one',
    status: 'failed',
    search_text: 'failed one'
  });

  await withWorld({ db }, async () => {
    const res = await get({});
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].title, 'Published one');

    const serialised = JSON.stringify(res.body);
    assert.doesNotMatch(serialised, /internal detail/);
    assert.doesNotMatch(serialised, /internal-reason/);
    assert.doesNotMatch(serialised, /service-role/);
  });
});

test('a single published entry is retrievable by video id, and bad ids are rejected', async () => {
  const db = createDb();
  db.seed({
    video_id: VIDEO_ID,
    spec_version: SPEC_VERSION,
    canonical_url: URL_LONG,
    title: 'Ultrasonic Sensors with Arduino',
    components: [{ name: 'HC-SR04', status: 'USED' }],
    search_text: 'ultrasonic'
  });

  await withWorld({ db }, async () => {
    const found = await get({ videoId: VIDEO_ID });
    assert.equal(found.statusCode, 200);
    assert.equal(found.body.item.title, 'Ultrasonic Sensors with Arduino');
    assert.equal(found.body.item.components[0].name, 'HC-SR04');

    const missing = await get({ videoId: 'e1FVSpkw6q4' });
    assert.equal(missing.statusCode, 404);

    const bad = await get({ videoId: '../../etc/passwd' });
    assert.equal(bad.statusCode, 400);
  });
});

test('the public library reports itself as unconfigured rather than erroring out', async () => {
  const res = mockRes();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  await listHandler(mockReq({ method: 'GET', query: {} }), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.configured, false);
  assert.deepEqual(res.body.items, []);
});
