/**
 * End-to-end tests over REAL HTTP against a REAL Supabase.
 *
 * The other suites call the handlers with mock req/res objects. This one boots
 * the handlers behind an actual Node HTTP server, using the same request shape
 * Vercel provides, and talks to it with fetch over a socket. That is what
 * catches contract problems the mocks cannot: query-string parsing, JSON body
 * handling, status codes, and the CORS headers a browser will actually see.
 *
 * Only YouTube and Gemini are stubbed. Supabase is the real local stack.
 *
 * Skipped unless SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are set.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

import { createApiServer } from '../../scripts/dev-api.mjs';
import { installWorld } from '../helpers/world.js';

const URL_BASE = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const configured = Boolean(URL_BASE && SERVICE_KEY);
const options = configured
  ? {}
  : { skip: 'set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to run the integration suite' };

const supabaseHost = configured ? new URL(URL_BASE).hostname : null;

/** Everything this run creates, removed by the `after` hook below. */
const CREATED_VIDEO_IDS = new Set();

function newVideoId() {
  const id = randomBytes(8).toString('base64url').slice(0, 11).padEnd(11, 'a');
  CREATED_VIDEO_IDS.add(id);
  return id;
}

/**
 * Boot the API server, stub the upstreams, run `fn`, then tear everything down.
 * `realFetch` is captured before the stub is installed so the test client is
 * not itself intercepted.
 */
async function withServer(fn, worldOptions = {}) {
  const realFetch = globalThis.fetch;

  const server = createApiServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const world = installWorld({ db: null, passthroughHost: supabaseHost, ...worldOptions });
  const saved = { ...process.env };
  process.env.GEMINI_KEY = 'gemini-test-key';

  // The client must bypass the stub, or its own request would be intercepted.
  // Every request carries the test marker so its rate-limit bucket is
  // identifiable and removable, including plain GETs to the listing endpoint.
  const client = (path, init = {}) =>
    realFetch(`${base}${path}`, {
      ...init,
      headers: {
        'x-forwarded-for': `itm-test-${randomBytes(4).toString('hex')}`,
        ...(init.headers || {})
      }
    });

  const json = async (path, init) => {
    const res = await client(path, init);
    const body = await res.json().catch(() => null);
    return { status: res.status, body, headers: res.headers };
  };

  try {
    return await fn({ client, json, base, counters: world.counters });
  } finally {
    world.restore();
    Object.assign(process.env, saved);
    server.close();
    await once(server, 'close');
  }
}

const post = (json, body, headers = {}) =>
  json('/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `itm-test-${randomBytes(4).toString('hex')}`, ...headers },
    body: JSON.stringify(body)
  });

/* ========================================================================== */

test('HTTP: a full extraction round trip returns a well-formed JSON body', options, async () => {
  const id = newVideoId();

  await withServer(async ({ json, counters }) => {
    const res = await post(json, { url: `https://www.youtube.com/watch?v=${id}` });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.body.videoId, id);
    assert.equal(res.body.title, 'DHT11 with Arduino Uno');
    assert.equal(res.body.durationSeconds, 742);
    assert.equal(res.body.components.length, 3);
    assert.equal(res.body.published, true);
    assert.equal(res.body.cached, false);
    assert.equal(counters.gemini, 1);
  });
});

test('HTTP: a second request over the wire is served from the shared cache', options, async () => {
  const id = newVideoId();

  await withServer(async ({ json, counters }) => {
    await post(json, { url: `https://www.youtube.com/watch?v=${id}` });
    assert.equal(counters.gemini, 1);

    // Different URL format, different client, same video.
    const second = await post(json, { url: `https://youtu.be/${id}` });

    assert.equal(second.status, 200);
    assert.equal(second.body.cached, true);
    assert.equal(second.body.cacheHit, 'shared');
    assert.equal(counters.gemini, 1, 'the model must not run again for a cache hit');
  });
});

test('HTTP: the public listing parses its query string correctly', options, async () => {
  const id = newVideoId();

  await withServer(async ({ json }) => {
    await post(json, { url: `https://www.youtube.com/watch?v=${id}` });

    const all = await json('/api/extractions?limit=5');
    assert.equal(all.status, 200);
    assert.equal(all.body.configured, true);
    assert.equal(all.body.limit, 5);
    assert.ok(Array.isArray(all.body.items));

    // A real query string, url-encoded, including a term with a hyphen.
    const search = await json('/api/extractions?q=dht11&limit=50');
    assert.equal(search.status, 200);
    assert.ok(search.body.items.some(i => i.videoId === id));

    const single = await json(`/api/extractions?videoId=${id}`);
    assert.equal(single.status, 200);
    assert.equal(single.body.item.videoId, id);
    assert.equal(single.body.item.components.length, 3);

    // Internal columns must not cross the wire.
    const serialised = JSON.stringify(single.body);
    assert.doesNotMatch(serialised, /error_message|lock_until|search_text|review_reason/);
  });
});

test('HTTP: an encoded search term survives the round trip', options, async () => {
  await withServer(async ({ json }) => {
    const res = await json(`/api/extractions?q=${encodeURIComponent('HC-SR04 & friends')}&limit=5`);
    assert.equal(res.status, 200, 'a term with spaces and an ampersand must not error');
    assert.ok(Array.isArray(res.body.items));
  });
});

test('HTTP: CORS headers are what a browser on the published site will receive', options, async () => {
  await withServer(async ({ client }) => {
    const res = await client('/api/extract', {
      method: 'OPTIONS',
      headers: { Origin: 'https://ahmedbahaj.github.io' }
    });

    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      'https://ahmedbahaj.github.io',
      'the published research site must be allowed'
    );
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
    assert.match(res.headers.get('access-control-allow-headers'), /Content-Type/);
    assert.equal(res.headers.get('vary'), 'Origin');
  });
});

test('HTTP: an unknown origin does not get an allow header for itself', options, async () => {
  await withServer(async ({ client }) => {
    const res = await client('/api/extract', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' }
    });

    assert.notEqual(res.headers.get('access-control-allow-origin'), 'https://evil.example.com');
  });
});

test('HTTP: invalid input is rejected with a 400 and a readable message', options, async () => {
  await withServer(async ({ json, counters }) => {
    const res = await post(json, { url: 'https://example.com/not-youtube' });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /supported YouTube/i);
    assert.equal(counters.gemini, 0);
  });
});

test('HTTP: a malformed JSON body does not crash the function', options, async () => {
  await withServer(async ({ client }) => {
    const res = await client('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not valid json'
    });

    assert.equal(res.status, 400, 'an unparseable body should read as "no input", not a 500');
  });
});

test('HTTP: a GET on the extract endpoint is refused', options, async () => {
  await withServer(async ({ json }) => {
    const res = await json('/api/extract');
    assert.equal(res.status, 405);
  });
});

test('HTTP: an ineligible video is refused before any model spend', options, async () => {
  const id = newVideoId();

  await withServer(async ({ json, counters }) => {
    const res = await post(json, { url: `https://www.youtube.com/watch?v=${id}` });

    assert.equal(res.status, 422);
    assert.equal(res.body.ineligible, true);
    assert.match(res.body.error, /does not appear to be an IoT hardware tutorial/i);
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
});

test('HTTP: a missing transcript asks for the manual fallback, which then works', options, async () => {
  const id = newVideoId();

  await withServer(async ({ json, counters }) => {
    const refused = await post(json, { url: `https://www.youtube.com/watch?v=${id}` });

    assert.equal(refused.status, 422);
    assert.equal(refused.body.needsTranscript, true);
    assert.equal(counters.gemini, 0);
  }, { captions: false });

  // The user pastes a transcript; a separate request, as the UI would send it.
  await withServer(async ({ json, counters }) => {
    const manual = await post(json, {
      url: `https://www.youtube.com/watch?v=${id}`,
      transcript: 'we wire the dht11 sensor to the arduino uno using jumper wires on a breadboard'
    });

    assert.equal(manual.status, 200);
    assert.equal(manual.body.source, 'manual-transcript');
    assert.equal(manual.body.published, false);
    assert.equal(counters.gemini, 1);
  });
});

test('HTTP: parallel requests over real sockets still call the model once', options, async () => {
  const id = newVideoId();

  await withServer(async ({ json, counters }) => {
    const responses = await Promise.all([
      post(json, { url: `https://www.youtube.com/watch?v=${id}` }),
      post(json, { url: `https://youtu.be/${id}` }),
      post(json, { url: `https://www.youtube.com/shorts/${id}` }),
      post(json, { url: `https://www.youtube.com/embed/${id}` })
    ]);

    for (const res of responses) {
      assert.ok([200, 202].includes(res.status), `unexpected status ${res.status}`);
    }

    assert.equal(counters.gemini, 1, `model ran ${counters.gemini} times, expected 1`);

    for (const res of responses.filter(r => r.status === 200)) {
      assert.equal(res.body.components.length, 3);
    }
  }, { env: { PEER_WAIT_MS: '15000', PEER_POLL_MS: '250' } });
});

test('HTTP: an oversized body is rejected without being buffered indefinitely', options, async () => {
  await withServer(async ({ json, counters }) => {
    const res = await post(json, { transcript: 'x'.repeat(300_000) });

    assert.equal(res.status, 413);
    assert.equal(counters.gemini, 0);
  });
});


/** Remove every row this run created, scoped to its own ids. */
after(async () => {
  if (!configured) return;

  const del = path =>
    fetch(`${URL_BASE}${path}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });

  if (CREATED_VIDEO_IDS.size) {
    await del(`/rest/v1/extractions?video_id=in.(${[...CREATED_VIDEO_IDS].join(',')})`);
  }
  await del('/rest/v1/rate_limits?bucket=like.*:itm-test-*');

  console.log(`# cleanup: removed ${CREATED_VIDEO_IDS.size} test rows`);
});
