import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanTranscript,
  getTranscriptFromSupadata,
  getTranscriptFromYouTube
} from '../api/_lib/transcript.js';

const VIDEO_ID = 'OogldLc9uYc';

const WATCH_PAGE = `
  <html><script>var x = {"videoDetails":{"lengthSeconds":"317"},
  "captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=x\\u0026lang=en","languageCode":"en","kind":""}]}}
  };</script></html>
`;

/** Route a fake fetch by URL, so each failure mode can be isolated. */
function router({ page = WATCH_PAGE, caption }) {
  return async url => {
    const u = String(url);
    if (u.includes('/watch')) {
      return { ok: true, status: 200, text: async () => page };
    }
    if (u.includes('timedtext')) return caption();
    throw new Error(`unexpected url: ${u}`);
  };
}

test('a normal page yields both the transcript and the duration', async () => {
  const result = await getTranscriptFromYouTube(VIDEO_ID, {
    fetchImpl: router({
      caption: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ events: [{ segs: [{ utf8: 'Arduino DHT11 Sensor' }] }] })
      })
    })
  });

  assert.equal(result.text, 'arduino dht11 sensor');
  assert.equal(result.durationSeconds, 317);
});

/*
 * Regression: YouTube's timedtext endpoint now commonly answers 200 with an
 * empty body. That made .json() throw, the outer catch swallowed it, and the
 * duration already parsed from the watch page was discarded - so duration was
 * permanently null in production. The transcript may legitimately be
 * unavailable, but metadata already in hand must survive.
 */
test('an empty 200 from timedtext loses the transcript but NOT the duration', async () => {
  const result = await getTranscriptFromYouTube(VIDEO_ID, {
    fetchImpl: router({
      caption: async () => ({
        ok: true,
        status: 200,
        // An empty body is not valid JSON.
        json: async () => { throw new SyntaxError('Unexpected end of JSON input'); }
      })
    })
  });

  assert.equal(result.text, null, 'no transcript is available');
  assert.equal(result.durationSeconds, 317, 'the duration must survive a caption failure');
});

test('a caption request that rejects outright still returns the duration', async () => {
  const result = await getTranscriptFromYouTube(VIDEO_ID, {
    fetchImpl: router({ caption: async () => { throw new Error('network reset'); } })
  });

  assert.equal(result.text, null);
  assert.equal(result.durationSeconds, 317);
});

test('a page with no caption tracks still returns the duration', async () => {
  const result = await getTranscriptFromYouTube(VIDEO_ID, {
    fetchImpl: router({
      page: '<html>{"videoDetails":{"lengthSeconds":"317"},"captions":null}</html>',
      caption: async () => { throw new Error('should not be called'); }
    })
  });

  assert.equal(result.text, null);
  assert.equal(result.durationSeconds, 317);
});

test('a caption URL on an unexpected host is refused, and the duration survives', async () => {
  const page = WATCH_PAGE.replace('https://www.youtube.com/api/timedtext', 'https://evil.example.com/steal');

  const result = await getTranscriptFromYouTube(VIDEO_ID, {
    fetchImpl: router({
      page,
      caption: async () => { throw new Error('must never be fetched'); }
    })
  });

  assert.equal(result.text, null);
  assert.equal(result.durationSeconds, 317, 'duration still comes back');
});

test('an unparseable watch page returns nulls rather than throwing', async () => {
  const result = await getTranscriptFromYouTube(VIDEO_ID, {
    fetchImpl: router({ page: 'not a youtube page', caption: async () => ({}) })
  });

  assert.equal(result.text, null);
  assert.equal(result.durationSeconds, null);
});

test('an invalid video id is rejected before any request', async () => {
  const result = await getTranscriptFromYouTube('../etc/passwd', {
    fetchImpl: async () => { throw new Error('must not be called'); }
  });

  assert.deepEqual(result, { text: null, durationSeconds: null });
});

test('Supadata handles each supported response shape, and failure returns null', async () => {
  const call = impl => getTranscriptFromSupadata(VIDEO_ID, 'key', { fetchImpl: impl });

  const segments = await call(async () => ({
    ok: true, status: 200,
    json: async () => ({ content: [{ text: 'Arduino' }, { text: 'DHT11' }] })
  }));
  assert.equal(segments, 'arduino dht11');

  const asString = await call(async () => ({
    ok: true, status: 200, json: async () => ({ content: '  ESP32   Board ' })
  }));
  assert.equal(asString, 'esp32 board');

  const legacy = await call(async () => ({
    ok: true, status: 200, json: async () => ({ text: 'Breadboard' })
  }));
  assert.equal(legacy, 'breadboard');

  const failed = await call(async () => ({ ok: false, status: 402, json: async () => ({}) }));
  assert.equal(failed, null);

  const threw = await call(async () => { throw new Error('offline'); });
  assert.equal(threw, null);
});

test('Supadata is skipped entirely when no key is configured', async () => {
  const result = await getTranscriptFromSupadata(VIDEO_ID, undefined, {
    fetchImpl: async () => { throw new Error('must not be called'); }
  });
  assert.equal(result, null);
});

test('cleanTranscript normalises whitespace and case', () => {
  assert.equal(cleanTranscript('  Arduino\n\tUNO   Board '), 'arduino uno board');
  assert.equal(cleanTranscript(null), '');
});
