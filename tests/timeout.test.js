/**
 * Regression tests for the extraction timeout.
 *
 * Background: a fixed 30s model timeout aborted legitimately slow extractions.
 * Gemini 3 Flash is a thinking model whose latency varies with how much it
 * reasons, so a constant either truncates a valid run or overruns the platform
 * limit. The model now receives whatever remains of an overall request budget.
 *
 * Every "slow model" here is simulated with a timer. No real quota is spent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import handler from '../api/extract.js';
import { LIMITS, SPEC_VERSION, geminiBudgetMs } from '../api/_lib/spec.js';
import { GeminiError, callGemini } from '../api/_lib/gemini.js';
import { createDb, installWorld, mockReq, mockRes } from './helpers/world.js';

const VIDEO_ID = 'KGwtit2bFyo';
const URL_LONG = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ========================================================================== */
/* The budget calculation                                                     */
/* ========================================================================== */

test('the model gets the remaining budget, not a fixed slice', () => {
  const limits = {
    requestBudgetMs: 55_000,
    persistReserveMs: 6_000,
    geminiMinTimeoutMs: 20_000,
    geminiMaxTimeoutMs: 240_000
  };

  // Nothing spent yet: budget minus the persist reserve.
  assert.equal(geminiBudgetMs(0, limits), 49_000);
  // Transcript work already took 5s.
  assert.equal(geminiBudgetMs(5_000, limits), 44_000);
});

test('the model is never given less than the floor, however late it is', () => {
  const limits = {
    requestBudgetMs: 55_000,
    persistReserveMs: 6_000,
    geminiMinTimeoutMs: 20_000,
    geminiMaxTimeoutMs: 240_000
  };

  // Even if the budget is already blown, we do not hand the model 1ms and
  // throw away the transcript work already done.
  assert.equal(geminiBudgetMs(60_000, limits), 20_000);
  assert.equal(geminiBudgetMs(999_999, limits), 20_000);
});

test('a generous budget is capped, so a request cannot hang forever', () => {
  const limits = {
    requestBudgetMs: 10_000_000,
    persistReserveMs: 6_000,
    geminiMinTimeoutMs: 20_000,
    geminiMaxTimeoutMs: 240_000
  };

  assert.equal(geminiBudgetMs(0, limits), 240_000);
});

test('the default budget is generous and env-configurable, not an arbitrary constant', () => {
  // The regression was a hardcoded 30s. The floor alone must now exceed that.
  assert.ok(
    LIMITS.geminiMinTimeoutMs >= 20_000,
    `floor is ${LIMITS.geminiMinTimeoutMs}ms, too tight for a thinking model`
  );
  assert.ok(
    geminiBudgetMs(3_000) > 30_000,
    'a typical request must allow the model more than the old 30s limit'
  );
  assert.ok(LIMITS.requestBudgetMs >= 55_000);
});

/* ========================================================================== */
/* Failure classification                                                     */
/* ========================================================================== */

test('a slow model produces a typed timeout, not a generic error', async () => {
  // Mirrors real fetch: rejects with AbortError when the signal fires.
  const slow = (_url, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    });

  const err = await callGemini('arduino uno breadboard', 'key', {
    timeoutMs: 120,
    fetchImpl: slow
  }).then(() => null, e => e);

  assert.ok(err instanceof GeminiError);
  assert.equal(err.code, 'timeout');
  assert.match(err.message, /did not respond within/i);
});

test('a provider rejection is NOT reported as a timeout', async () => {
  const rejecting = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: { message: 'Quota exceeded' } })
  });

  const err = await callGemini('arduino', 'key', { fetchImpl: rejecting })
    .then(() => null, e => e);

  assert.ok(err instanceof GeminiError);
  assert.equal(err.code, 'provider_error');
  assert.match(err.message, /quota/i);
});

test('a network failure is NOT reported as a timeout', async () => {
  const offline = async () => { throw new Error('ECONNRESET'); };

  const err = await callGemini('arduino', 'key', { fetchImpl: offline })
    .then(() => null, e => e);

  assert.equal(err.code, 'provider_error');
});

test('a missing key is its own failure mode', async () => {
  const err = await callGemini('arduino', '', {
    fetchImpl: async () => { throw new Error('must not be called'); }
  }).then(() => null, e => e);

  assert.equal(err.code, 'not_configured');
});

/* ========================================================================== */
/* End-to-end behaviour through the handler                                   */
/* ========================================================================== */

function post(body, headers = {}) {
  const res = mockRes();
  const req = mockReq({
    body,
    headers: { 'x-forwarded-for': `itm-test-${randomBytes(4).toString('hex')}`, ...headers }
  });
  return handler(req, res).then(() => res);
}

async function withWorld(options, fn) {
  const db = options.db || createDb();
  const world = installWorld({ ...options, db });
  const saved = { ...process.env };

  Object.assign(process.env, {
    SUPABASE_URL: 'https://fake.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    GEMINI_KEY: 'test-key',
    ...(options.env || {})
  });

  try {
    return await fn({ db, counters: world.counters });
  } finally {
    world.restore();
    for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_KEY',
                     'REQUEST_BUDGET_MS', 'GEMINI_MIN_TIMEOUT_MS', 'PERSIST_RESERVE_MS']) {
      delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
}

test('a legitimately slow extraction now SUCCEEDS instead of being aborted', async () => {
  // Simulates the reported failure: a model run slower than the old 30s limit.
  // The mock resolves after a short delay standing in for that slow run; the
  // assertion is that the handler does not abort it.
  await withWorld(
    { geminiDelayMs: 600 },
    async ({ counters, db }) => {
      const res = await post({ url: URL_LONG });

      assert.equal(res.statusCode, 200, `expected success, got ${res.statusCode}: ${res.body?.error}`);
      assert.equal(res.body.components.length, 3);
      assert.equal(counters.gemini, 1);

      const row = db.get(VIDEO_ID, SPEC_VERSION);
      assert.equal(row.status, 'ready');
    }
  );
});

test('a genuine timeout returns 504 with a timeout code, not a 500', async () => {
  await withWorld(
    {
      // Model never answers; the budget is squeezed so the abort fires fast.
      geminiDelayMs: 10_000,
      env: { REQUEST_BUDGET_MS: '400', PERSIST_RESERVE_MS: '10', GEMINI_MIN_TIMEOUT_MS: '150' }
    },
    async () => {
      const res = await post({ url: URL_LONG });

      assert.equal(res.statusCode, 504);
      assert.equal(res.body.errorCode, 'timeout');
      assert.match(res.body.error, /did not respond/i);
      assert.match(res.body.error, /not completed/i);
      assert.equal(res.body.videoId, VIDEO_ID);
    }
  );
});

test('a timeout is distinguishable from a missing transcript', async () => {
  await withWorld({ captions: false }, async () => {
    const res = await post({ url: URL_LONG });

    assert.equal(res.statusCode, 422);
    assert.equal(res.body.needsTranscript, true);
    assert.notEqual(res.body.errorCode, 'timeout');
  });
});

test('a timeout is distinguishable from an ineligible video', async () => {
  await withWorld(
    {
      metadata: { title: 'Lasagne Recipe', author_name: 'Cooking' },
      transcriptText:
        'welcome back to the kitchen today we are making a classic lasagne start by browning ' +
        'the mince in olive oil with garlic and onion then add the tomatoes and layer the pasta ' +
        'sheets with bechamel and plenty of grated parmesan cheese on top bake for forty minutes ' +
        'until golden brown and let it rest before slicing and serving to six people at the table ' +
        'this recipe keeps well in the fridge for a couple of days and freezes beautifully too ' +
        'so make a double batch if you are cooking for a crowd this weekend and enjoy your meal'
    },
    async ({ counters }) => {
      const res = await post({ url: URL_LONG });

      assert.equal(res.statusCode, 422);
      assert.equal(res.body.ineligible, true);
      assert.notEqual(res.body.errorCode, 'timeout');
      assert.equal(counters.gemini, 0);
    }
  );
});

test('a timeout is distinguishable from a provider rejection', async () => {
  await withWorld({ geminiFails: true }, async () => {
    const res = await post({ url: URL_LONG });

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.errorCode, 'provider_error');
  });
});

/* ========================================================================== */
/* No duplicate model calls after a timeout                                   */
/* ========================================================================== */

test('a timeout serves a peer result instead of reporting failure', async () => {
  const db = createDb();

  // A peer finished this video while our own model call was still running.
  db.seed({
    video_id: VIDEO_ID,
    spec_version: SPEC_VERSION,
    canonical_url: URL_LONG,
    title: 'Ultrasonic Sensors with Arduino',
    components: [{ name: 'Arduino Uno', status: 'USED' }],
    component_count: 1,
    status: 'ready',
    publication_status: 'published'
  });

  await withWorld(
    {
      db,
      geminiDelayMs: 10_000,
      env: {
        REQUEST_BUDGET_MS: '400',
        PERSIST_RESERVE_MS: '10',
        GEMINI_MIN_TIMEOUT_MS: '150'
      }
    },
    async ({ counters }) => {
      // force=true bypasses the cache, so the model IS called and times out.
      const res = await post({ url: URL_LONG, force: true });

      assert.equal(res.statusCode, 200, 'the existing result should be served');
      assert.equal(res.body.cacheHit, 'shared-after-timeout');
      assert.equal(res.body.components.length, 1);
      assert.equal(counters.gemini, 1, 'exactly one model call was attempted');
    }
  );
});

test('retrying after a timeout reuses the cache rather than calling the model again', async () => {
  const db = createDb();

  // First attempt times out with nothing cached.
  await withWorld(
    {
      db,
      geminiDelayMs: 10_000,
      env: { REQUEST_BUDGET_MS: '400', PERSIST_RESERVE_MS: '10', GEMINI_MIN_TIMEOUT_MS: '150' }
    },
    async ({ counters }) => {
      const res = await post({ url: URL_LONG });
      assert.equal(res.statusCode, 504);
      assert.equal(counters.gemini, 1);
    }
  );

  // The retry succeeds and stores the result.
  await withWorld({ db }, async ({ counters }) => {
    const ok = await post({ url: URL_LONG });
    assert.equal(ok.statusCode, 200);
    assert.equal(counters.gemini, 1);
  });

  // A further attempt must not call the model at all.
  await withWorld({ db }, async ({ counters }) => {
    const again = await post({ url: URL_LONG });
    assert.equal(again.statusCode, 200);
    assert.equal(again.body.cached, true);
    assert.equal(counters.gemini, 0, 'the cache must absorb the retry');
  });

  assert.equal(db.rows.size, 1, 'no duplicate rows across the whole sequence');
});

test('a timed-out re-extraction preserves the previous successful result', async () => {
  const db = createDb();

  // Establish a good result.
  await withWorld({ db }, async () => {
    const first = await post({ url: URL_LONG });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.components.length, 3);
  });

  // Now force a re-extraction that times out.
  await withWorld(
    {
      db,
      geminiDelayMs: 10_000,
      env: { REQUEST_BUDGET_MS: '400', PERSIST_RESERVE_MS: '10', GEMINI_MIN_TIMEOUT_MS: '150' }
    },
    async () => {
      await post({ url: URL_LONG, force: true });

      const row = db.get(VIDEO_ID, SPEC_VERSION);
      assert.equal(row.status, 'ready', 'must not be downgraded to failed');
      assert.equal(row.components.length, 3, 'the previous components must survive');
      assert.equal(row.publication_status, 'published');
      assert.equal(row.lock_until, null, 'the lease must be released');
    }
  );

  // And the good result is still served afterwards.
  await withWorld({ db }, async ({ counters }) => {
    const after = await post({ url: URL_LONG });
    assert.equal(after.statusCode, 200);
    assert.equal(after.body.components.length, 3);
    assert.equal(counters.gemini, 0);
  });
});

test('the manual transcript path also reports a typed timeout', async () => {
  await withWorld(
    {
      geminiDelayMs: 10_000,
      env: { REQUEST_BUDGET_MS: '400', PERSIST_RESERVE_MS: '10', GEMINI_MIN_TIMEOUT_MS: '150' }
    },
    async () => {
      const res = await post({
        url: URL_LONG,
        transcript: 'we wire the dht11 sensor to the arduino uno using jumper wires'
      });

      assert.equal(res.statusCode, 504);
      assert.equal(res.body.errorCode, 'timeout');
    }
  );
});
