import test from 'node:test';
import assert from 'node:assert/strict';

import * as api from '../api/_lib/youtube.js';
import * as web from '../frontend/src/services/youtube.js';

const VIDEO_ID = 'KGwtit2bFyo';

const EQUIVALENT_URLS = [
  `https://www.youtube.com/watch?v=${VIDEO_ID}`,
  `http://www.youtube.com/watch?v=${VIDEO_ID}`,
  `https://youtube.com/watch?v=${VIDEO_ID}`,
  `https://m.youtube.com/watch?v=${VIDEO_ID}`,
  `https://music.youtube.com/watch?v=${VIDEO_ID}`,
  `https://youtu.be/${VIDEO_ID}`,
  `https://youtu.be/${VIDEO_ID}?t=42`,
  `https://www.youtube.com/shorts/${VIDEO_ID}`,
  `https://www.youtube.com/embed/${VIDEO_ID}`,
  `https://www.youtube.com/live/${VIDEO_ID}`,
  `https://www.youtube.com/v/${VIDEO_ID}`,
  `https://www.youtube-nocookie.com/embed/${VIDEO_ID}`,
  `https://www.youtube.com/watch?v=${VIDEO_ID}&list=PLabc&index=3`,
  `www.youtube.com/watch?v=${VIDEO_ID}`,
  `  https://www.youtube.com/watch?v=${VIDEO_ID}  `,
  VIDEO_ID
];

const INVALID_URLS = [
  '',
  '   ',
  'not a url',
  'https://example.com/watch?v=KGwtit2bFyo',
  'https://vimeo.com/123456',
  'https://youtube.evil.com/watch?v=KGwtit2bFyo',
  'https://www.youtube.com/watch?v=tooshort',
  'https://www.youtube.com/watch?v=waaaaaaaaytoolong123',
  'https://www.youtube.com/watch',
  'https://www.youtube.com/@somechannel',
  'javascript:alert(1)',
  'file:///etc/passwd',
  'http://169.254.169.254/latest/meta-data/',
  `https://youtu.be/${VIDEO_ID}@evil.com`,
  null,
  undefined,
  12345
];

test('13. every supported YouTube URL format resolves to the same canonical video id', () => {
  for (const url of EQUIVALENT_URLS) {
    assert.equal(api.parseVideoId(url), VIDEO_ID, `api failed on: ${url}`);
  }
});

test('15. malformed URLs, unsupported domains, and non-HTTP schemes are rejected', () => {
  for (const url of INVALID_URLS) {
    assert.equal(api.parseVideoId(url), null, `api wrongly accepted: ${url}`);
  }
});

test('frontend and backend URL parsers agree (guards against the two copies drifting)', () => {
  for (const url of [...EQUIVALENT_URLS, ...INVALID_URLS]) {
    assert.equal(
      web.parseVideoId(url),
      api.parseVideoId(url),
      `parsers disagree on: ${String(url)}`
    );
  }
});

test('an over-long input is rejected before URL parsing', () => {
  const long = `https://www.youtube.com/watch?v=${VIDEO_ID}&x=${'a'.repeat(3000)}`;
  assert.equal(api.parseVideoId(long), null);
});

test('canonical URL and thumbnail are built only from a validated id', () => {
  assert.equal(api.canonicalUrl(VIDEO_ID), `https://www.youtube.com/watch?v=${VIDEO_ID}`);
  assert.equal(api.thumbnailUrl(VIDEO_ID), `https://img.youtube.com/vi/${VIDEO_ID}/hqdefault.jpg`);
  assert.equal(api.canonicalUrl('../../etc/passwd'), null);
  assert.equal(api.thumbnailUrl('"><script>'), null);
});

test('17. duration is read when present and stays null when absent - never invented', () => {
  assert.equal(api.parseDurationSeconds('{"lengthSeconds":"742"}'), 742);
  assert.equal(api.parseDurationSeconds('{"lengthSeconds":\\"742\\"}'), 742);
  assert.equal(api.parseDurationSeconds('no duration here'), null);
  assert.equal(api.parseDurationSeconds('{"lengthSeconds":"0"}'), null);
  assert.equal(api.parseDurationSeconds(''), null);
  assert.equal(api.parseDurationSeconds(null), null);
});

test('17. unavailable videos are reported, not fabricated', async () => {
  const gone = await api.fetchOEmbedMetadata(VIDEO_ID, async () => ({ status: 404, ok: false }));
  assert.equal(gone.available, false);
  assert.equal(gone.title, null);

  // A network failure is not proof the video is gone.
  const unreachable = await api.fetchOEmbedMetadata(VIDEO_ID, async () => {
    throw new Error('network down');
  });
  assert.equal(unreachable.available, null);
  assert.equal(unreachable.title, null);

  const ok = await api.fetchOEmbedMetadata(VIDEO_ID, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ title: 'DHT11 Tutorial', author_name: 'Surtrtech' })
  }));
  assert.equal(ok.available, true);
  assert.equal(ok.title, 'DHT11 Tutorial');
  assert.equal(ok.thumbnail, null, 'a missing thumbnail must stay null');
});

test('formatDuration renders known durations and null for unknown ones', () => {
  assert.equal(web.formatDuration(65), '1:05');
  assert.equal(web.formatDuration(3725), '1:02:05');
  assert.equal(web.formatDuration(0), null);
  assert.equal(web.formatDuration(null), null);
  assert.equal(web.formatDuration('abc'), null);
});
