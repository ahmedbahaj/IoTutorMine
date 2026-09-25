/**
 * Test doubles for everything the extraction API talks to.
 *
 * The fake Supabase mirrors the semantics of supabase/migrations/0001_*.sql:
 * the unique (video_id, spec_version) key, the lease-based claim, the sticky
 * moderation status, and the rule that a failure never downgrades a row that
 * already holds a successful result. That is what makes these tests meaningful
 * rather than tautological.
 */

const PUBLIC_KEYS = [
  'id', 'video_id', 'canonical_url', 'title', 'channel', 'duration_seconds',
  'thumbnail_url', 'components', 'component_count', 'model', 'spec_version',
  'publication_status', 'extracted_at', 'last_success_at'
];

function pub(row) {
  if (!row) return null;
  const out = {};
  for (const k of PUBLIC_KEYS) out[k] = row[k] ?? null;
  return out;
}

const json = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(data),
  json: async () => data
});

export function createDb() {
  const rows = new Map();
  const limits = new Map();
  let seq = 0;

  const key = (videoId, spec) => `${videoId}|${spec}`;

  return {
    rows,
    limits,

    seed(row) {
      const full = {
        id: `row-${++seq}`,
        components: [],
        component_count: 0,
        status: 'ready',
        publication_status: 'published',
        lock_until: null,
        search_text: '',
        extracted_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
        ...row
      };
      full.component_count = full.component_count || full.components.length;
      rows.set(key(full.video_id, full.spec_version), full);
      return full;
    },

    get(videoId, spec) {
      return rows.get(key(videoId, spec)) || null;
    },

    rpc(fn, args) {
      const now = Date.now();

      if (fn === 'claim_extraction') {
        const k = key(args.p_video_id, args.p_spec_version);
        const existing = rows.get(k);

        if (!existing) {
          const row = {
            id: `row-${++seq}`,
            video_id: args.p_video_id,
            spec_version: args.p_spec_version,
            canonical_url: args.p_canonical_url,
            components: [],
            component_count: 0,
            status: 'processing',
            publication_status: 'pending',
            lock_until: now + args.p_stale_seconds * 1000,
            search_text: ''
          };
          rows.set(k, row);
          return [{ claim_outcome: 'claimed', extraction: pub(row) }];
        }

        if (!args.p_force && existing.status === 'ready') {
          return [{ claim_outcome: 'ready', extraction: pub(existing) }];
        }

        if (existing.lock_until && existing.lock_until > now) {
          return [{ claim_outcome: 'processing', extraction: pub(existing) }];
        }

        existing.lock_until = now + args.p_stale_seconds * 1000;
        existing.status = existing.status === 'ready' ? 'ready' : 'processing';
        return [{ claim_outcome: 'claimed', extraction: pub(existing) }];
      }

      if (fn === 'complete_extraction') {
        const k = key(args.p_video_id, args.p_spec_version);
        const existing = rows.get(k);
        const stamp = new Date().toISOString();

        const next = {
          id: existing?.id || `row-${++seq}`,
          video_id: args.p_video_id,
          spec_version: args.p_spec_version,
          canonical_url: args.p_canonical_url,
          title: args.p_title ?? existing?.title ?? null,
          channel: args.p_channel ?? existing?.channel ?? null,
          duration_seconds: args.p_duration_seconds ?? existing?.duration_seconds ?? null,
          thumbnail_url: args.p_thumbnail_url ?? existing?.thumbnail_url ?? null,
          components: args.p_components || [],
          component_count: (args.p_components || []).length,
          model: args.p_model,
          source: args.p_source,
          status: 'ready',
          // Moderation decisions are sticky.
          publication_status: ['hidden', 'rejected'].includes(existing?.publication_status)
            ? existing.publication_status
            : args.p_publication_status,
          review_reason: args.p_review_reason,
          error_message: null,
          lock_until: null,
          search_text: args.p_search_text || '',
          extracted_at: stamp,
          last_success_at: stamp
        };

        rows.set(k, next);
        return [{ extraction: pub(next) }];
      }

      if (fn === 'fail_extraction') {
        const k = key(args.p_video_id, args.p_spec_version);
        const existing = rows.get(k);
        if (!existing) return [];

        const wasReady = existing.status === 'ready';
        existing.lock_until = null;
        existing.status = wasReady ? 'ready' : 'failed';
        existing.error_message = args.p_error;

        return [{ extraction: pub(existing), preserved: wasReady }];
      }

      if (fn === 'bump_rate_limit') {
        const window = Math.floor(now / 1000 / args.p_window_seconds);
        const k = `${args.p_bucket}|${window}`;
        const count = (limits.get(k) || 0) + 1;
        limits.set(k, count);
        return [{ allowed: count <= args.p_limit, hits: count }];
      }

      throw new Error(`unexpected rpc: ${fn}`);
    },

    select(search) {
      let list = [...rows.values()];

      const eq = (field, param) => {
        const value = search.get(param ?? field);
        if (!value) return;
        const [op, ...rest] = value.split('.');
        const operand = rest.join('.');
        if (op === 'eq') list = list.filter(r => String(r[field] ?? '') === operand);
        if (op === 'ilike') {
          const needle = operand.replace(/^\*|\*$/g, '').toLowerCase();
          list = list.filter(r => String(r[field] ?? '').toLowerCase().includes(needle));
        }
      };

      eq('video_id');
      eq('spec_version');
      eq('status');
      eq('publication_status');
      eq('search_text');

      const order = search.get('order');
      if (order?.startsWith('last_success_at')) {
        list.sort((a, b) => String(b.last_success_at || '').localeCompare(String(a.last_success_at || '')));
      }

      const offset = Number(search.get('offset') || 0);
      const limit = Number(search.get('limit') || 1000);
      return list.slice(offset, offset + limit).map(pub);
    }
  };
}

const WATCH_PAGE = (captions = true, duration = 742) => `
  <html><script>var ytInitialPlayerResponse = {"videoDetails":{"lengthSeconds":"${duration}"},
  ${captions ? '"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=x\\u0026lang=en","languageCode":"en","kind":""}]}}' : '"captions":null'}
  };</script></html>
`;

export const IOT_TRANSCRIPT_TEXT =
  'today we wire a dht11 temperature sensor to an arduino uno on a breadboard with jumper wires ' +
  'and a resistor, then show the circuit and pinout for this tutorial, reading values over i2c ' +
  'and printing them to the oled display module.';

/**
 * Installs a global fetch that routes to the right double, and returns the
 * counters the tests assert on.
 */
export function installWorld({
  db,
  // When set, requests to this host bypass the fake store and go to the real
  // network (used by the live-Supabase integration suite).
  passthroughHost = null,
  metadataStatus = 200,
  metadata = { title: 'DHT11 with Arduino Uno', author_name: 'Surtrtech' },
  captions = true,
  transcriptText = IOT_TRANSCRIPT_TEXT,
  geminiComponents = [
    { name: 'Arduino Uno', status: 'USED' },
    { name: 'DHT11', status: 'USED' },
    { name: 'DHT22', status: 'ALTERNATIVE', alternativeTo: 'DHT11' }
  ],
  geminiFails = false,
  supadataText = null,
  onGemini
} = {}) {
  const counters = { gemini: 0, oembed: 0, watch: 0, supadata: 0, db: 0 };
  const original = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const href = url.href;

    // ---- Real Supabase (integration suite) ----
    if (passthroughHost && url.hostname === passthroughHost) {
      counters.db++;
      return original(input, init);
    }

    // ---- Supabase PostgREST (fake) ----
    if (db && url.hostname === 'fake.supabase.co') {
      counters.db++;
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const fn = url.pathname.split('/').pop();
        return json(db.rpc(fn, JSON.parse(init.body)));
      }
      if (url.pathname === '/rest/v1/extractions') {
        return json(db.select(url.searchParams));
      }
      return json({ message: 'not found' }, 404);
    }

    // ---- YouTube oEmbed ----
    if (url.pathname === '/oembed') {
      counters.oembed++;
      if (metadataStatus !== 200) return json({}, metadataStatus);
      return json(metadata);
    }

    // ---- YouTube watch page ----
    if (url.hostname === 'www.youtube.com' && url.pathname === '/watch') {
      counters.watch++;
      return { ok: true, status: 200, text: async () => WATCH_PAGE(captions) };
    }

    // ---- Caption track ----
    if (url.pathname === '/api/timedtext') {
      return json({ events: [{ segs: [{ utf8: transcriptText }] }] });
    }

    // ---- Supadata fallback ----
    if (url.hostname === 'api.supadata.ai') {
      counters.supadata++;
      if (!supadataText) return json({}, 404);
      return json({ content: supadataText });
    }

    // ---- Gemini ----
    if (url.hostname === 'generativelanguage.googleapis.com') {
      counters.gemini++;
      if (onGemini) onGemini(counters.gemini);
      if (geminiFails) return json({ error: { message: 'Gemini quota exceeded' } }, 429);
      return json({
        candidates: [
          { content: { parts: [{ text: JSON.stringify({ components: geminiComponents }) }] } }
        ]
      });
    }

    throw new Error(`unexpected fetch in test: ${href}`);
  };

  return {
    counters,
    restore() {
      globalThis.fetch = original;
    }
  };
}

/** Minimal Vercel-style req/res pair. */
export function mockReq({ method = 'POST', body = {}, headers = {}, query = {} } = {}) {
  return {
    method,
    body,
    query,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9', ...headers },
    socket: { remoteAddress: '203.0.113.9' }
  };
}

export function mockRes() {
  const res = {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
  return res;
}

export function envWithDb() {
  return {
    SUPABASE_URL: 'https://fake.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
    GEMINI_KEY: 'gemini-test-key'
  };
}
