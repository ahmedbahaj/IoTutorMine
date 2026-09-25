import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORAGE_KEY,
  createHistory,
  createMemoryStorage,
  toRecord
} from '../frontend/src/services/history.js';

const RESULT = {
  videoId: 'KGwtit2bFyo',
  canonicalUrl: 'https://www.youtube.com/watch?v=KGwtit2bFyo',
  title: 'Ultrasonic Sensors with Arduino',
  channel: 'Robonyx',
  durationSeconds: 742,
  thumbnail: 'https://img.youtube.com/vi/KGwtit2bFyo/hqdefault.jpg',
  components: [
    { name: 'Arduino Uno', status: 'USED' },
    { name: 'RGBDuino', status: 'ALTERNATIVE', alternativeTo: 'Arduino Uno' }
  ],
  model: 'gemini-3-flash-preview',
  specVersion: 'v1-test',
  sharedId: 'shared-123',
  published: true,
  source: 'youtube-url',
  extractedAt: '2026-01-01T00:00:00.000Z'
};

test('8. a successful extraction is saved with every required field', () => {
  const history = createHistory(createMemoryStorage());
  const saved = history.save(RESULT, { originalUrl: 'https://youtu.be/KGwtit2bFyo' });

  assert.ok(saved.id, 'extraction id');
  assert.equal(saved.videoId, 'KGwtit2bFyo');
  assert.equal(saved.originalUrl, 'https://youtu.be/KGwtit2bFyo');
  assert.equal(saved.title, 'Ultrasonic Sensors with Arduino');
  assert.equal(saved.durationSeconds, 742);
  assert.ok(saved.thumbnail);
  assert.equal(saved.componentCount, 2);
  assert.equal(saved.sharedId, 'shared-123');
  assert.ok(saved.extractedAt);
  assert.deepEqual(saved.components[0], { name: 'Arduino Uno', status: 'USED' });
  assert.equal(saved.components[1].alternativeTo, 'Arduino Uno', 'ALTERNATIVE linkage is preserved');
});

test('raw transcripts and unexpected fields are never written to storage', () => {
  const storage = createMemoryStorage();
  const history = createHistory(storage);

  history.save(
    {
      ...RESULT,
      transcript: 'the full spoken transcript that must not be stored',
      apiKey: 'AIza-secret',
      geminiKey: 'super-secret'
    },
    { originalUrl: 'https://youtu.be/KGwtit2bFyo' }
  );

  const raw = storage.getItem(STORAGE_KEY);
  assert.doesNotMatch(raw, /must not be stored/);
  assert.doesNotMatch(raw, /AIza-secret/);
  assert.doesNotMatch(raw, /super-secret/);
  assert.doesNotMatch(raw, /transcript"\s*:/);
});

test('9. saved results survive a page reload (a fresh reader over the same storage)', () => {
  const storage = createMemoryStorage();

  createHistory(storage).save(RESULT, { originalUrl: 'https://youtu.be/KGwtit2bFyo' });

  // A reload creates a brand new history instance over the persisted bytes.
  const afterReload = createHistory(storage).list();
  assert.equal(afterReload.length, 1);
  assert.equal(afterReload[0].title, 'Ultrasonic Sensors with Arduino');
});

test('re-running the same video under the same spec replaces its entry instead of duplicating', () => {
  const history = createHistory(createMemoryStorage());

  const first = history.save(RESULT);
  const second = history.save({ ...RESULT, components: [{ name: 'DHT11', status: 'USED' }] });

  assert.equal(history.list().length, 1);
  assert.equal(first.id, second.id, 'the stable id is kept so existing links still resolve');
  assert.equal(history.get(first.id).components[0].name, 'DHT11');
});

test('a different spec version is kept as a separate entry', () => {
  const history = createHistory(createMemoryStorage());
  history.save(RESULT);
  history.save({ ...RESULT, specVersion: 'v2-different-prompt' });

  assert.equal(history.list().length, 2);
});

test('manual transcript results are always appended, never merged by video id', () => {
  const history = createHistory(createMemoryStorage());
  history.save({ ...RESULT, source: 'manual-transcript' });
  history.save({ ...RESULT, source: 'manual-transcript' });

  assert.equal(history.list().length, 2);
});

test('12. findByVideoId powers the client-side cache check', () => {
  const history = createHistory(createMemoryStorage());
  history.save(RESULT);

  assert.ok(history.findByVideoId('KGwtit2bFyo'));
  assert.equal(history.findByVideoId('e1FVSpkw6q4'), null);
  assert.equal(history.findByVideoId(null), null);
});

test('corrupted storage is discarded gracefully instead of throwing', () => {
  const storage = createMemoryStorage();
  storage.setItem(STORAGE_KEY, '{ this is not json');

  const history = createHistory(storage);
  assert.deepEqual(history.list(), []);
  assert.equal(storage.getItem(STORAGE_KEY), null, 'the corrupt payload is cleared');

  // The store is usable again afterwards.
  history.save(RESULT);
  assert.equal(history.list().length, 1);
});

test('non-array and partially corrupt payloads are filtered, not fatal', () => {
  const storage = createMemoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ not: 'an array' }));
  assert.deepEqual(createHistory(storage).list(), []);

  storage.setItem(
    STORAGE_KEY,
    JSON.stringify([{ id: 'good', components: [] }, null, 'junk', { noId: true }])
  );
  const entries = createHistory(storage).list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'good');
});

test('a storage backend that throws degrades quietly rather than breaking the page', () => {
  const broken = {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('quota exceeded'); },
    removeItem() { throw new Error('storage disabled'); }
  };

  const history = createHistory(broken);
  assert.deepEqual(history.list(), []);
  assert.doesNotThrow(() => history.save(RESULT));
  assert.doesNotThrow(() => history.clear());
});

test('remove and clear behave as expected', () => {
  const history = createHistory(createMemoryStorage());
  const a = history.save(RESULT);
  history.save({ ...RESULT, videoId: 'e1FVSpkw6q4' });

  assert.equal(history.list().length, 2);
  history.remove(a.id);
  assert.equal(history.list().length, 1);
  history.clear();
  assert.equal(history.list().length, 0);
});

test('toRecord coerces malformed component data into the supported shape', () => {
  const record = toRecord({
    videoId: 42,
    title: { nope: true },
    durationSeconds: 'abc',
    components: [
      { name: '  Spaced  ', status: 'weird' },
      { name: '', status: 'USED' },
      null,
      { name: 'Alt', status: 'ALTERNATIVE', alternativeTo: '  Spaced  ' }
    ]
  });

  assert.equal(record.videoId, null);
  assert.equal(record.title, null);
  assert.equal(record.durationSeconds, null);
  assert.deepEqual(record.components, [
    { name: 'Spaced', status: 'USED' },
    { name: 'Alt', status: 'ALTERNATIVE', alternativeTo: 'Spaced' }
  ]);
});
