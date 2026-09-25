import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessPublication,
  assessRelevance,
  buildSearchText,
  countUsed,
  validateComponents
} from '../api/_lib/validate.js';

const IOT_TRANSCRIPT =
  'today we are wiring a dht11 temperature sensor to an arduino uno on a breadboard ' +
  'using jumper wires and a 10k resistor, then reading it over i2c on the oled display. ' +
  'this tutorial shows the full circuit and pinout step by step.';

const COOKING_TRANSCRIPT =
  'welcome back to the kitchen. today we are making a classic lasagne. ' +
  'start by browning the mince in olive oil with garlic and onion, then add tomatoes. ' +
  'layer the pasta sheets with bechamel and plenty of grated parmesan cheese on top. ' +
  'bake it for forty minutes until golden brown and let it rest before slicing and serving. ' +
  'this recipe serves six people and keeps well in the fridge for a couple of days.';

test('16. a clearly unrelated video is rejected before the model is called', () => {
  const verdict = assessRelevance({
    title: 'Classic Lasagne Recipe',
    author: 'Home Cooking',
    transcript: COOKING_TRANSCRIPT
  });

  assert.equal(verdict.verdict, 'rejected');
  assert.equal(verdict.reason, 'This video does not appear to be an IoT hardware tutorial.');
});

test('an IoT hardware tutorial is accepted', () => {
  const verdict = assessRelevance({
    title: 'DHT11 Temperature Sensor with Arduino',
    author: 'Surtrtech',
    transcript: IOT_TRANSCRIPT
  });

  assert.equal(verdict.verdict, 'eligible');
  assert.ok(verdict.signals.transcriptHits >= 3);
});

test('an unusual title is not enough to reject a hardware tutorial', () => {
  const verdict = assessRelevance({
    title: 'I built a thing at 3am and it actually worked',
    author: 'someone',
    transcript: IOT_TRANSCRIPT
  });

  assert.equal(verdict.verdict, 'eligible', 'transcript evidence must outweigh an odd title');
});

test('missing metadata and a short transcript are handled as uncertain, not rejected', () => {
  const verdict = assessRelevance({ title: '', author: '', transcript: 'hello everyone' });
  assert.equal(verdict.verdict, 'uncertain');
  assert.equal(verdict.reason, null);
});

test('a hardware title with no transcript is uncertain - metadata alone never decides', () => {
  const verdict = assessRelevance({
    title: 'Arduino Uno breadboard sensor tutorial',
    author: '',
    transcript: ''
  });
  assert.equal(verdict.verdict, 'uncertain');
});

test('component schema validation normalises, deduplicates, and drops invalid rows', () => {
  const { ok, components } = validateComponents([
    { name: '  Arduino   Uno ', status: 'used' },
    { name: 'Arduino Uno', status: 'USED' },          // duplicate
    { name: 'RGBDuino', status: 'ALTERNATIVE', alternativeTo: 'Arduino Uno' },
    { name: '', status: 'USED' },                      // no name
    { name: 'Ghost', status: 'MAYBE' },                // unsupported status
    { name: 'x'.repeat(200), status: 'USED' },         // over-long
    null,
    'not an object',
    { name: 'DHT11', status: 'USED' }
  ]);

  assert.equal(ok, true);
  assert.deepEqual(components, [
    { name: 'Arduino Uno', status: 'USED' },
    { name: 'RGBDuino', status: 'ALTERNATIVE', alternativeTo: 'Arduino Uno' },
    { name: 'DHT11', status: 'USED' }
  ]);
  assert.equal(countUsed(components), 2);
});

test('a malformed or empty model response fails validation', () => {
  assert.equal(validateComponents(null).ok, false);
  assert.equal(validateComponents('nope').ok, false);
  assert.equal(validateComponents([]).ok, false);
  assert.equal(validateComponents([{ name: 'x', status: 'BOGUS' }]).ok, false);
});

test('16. publication policy: only eligible, well-formed results are published', () => {
  const components = [
    { name: 'Arduino Uno', status: 'USED' },
    { name: 'DHT11', status: 'USED' }
  ];

  const published = assessPublication({
    source: 'youtube-url',
    components,
    relevance: 'eligible',
    metadataAvailable: true,
    title: 'DHT11 with Arduino'
  });
  assert.deepEqual(published, { publish: true, status: 'published', reason: null });

  const irrelevant = assessPublication({
    source: 'youtube-url',
    components,
    relevance: 'rejected',
    metadataAvailable: true,
    title: 'Lasagne'
  });
  assert.equal(irrelevant.publish, false);
  assert.equal(irrelevant.status, 'rejected');

  const empty = assessPublication({
    source: 'youtube-url',
    components: [],
    relevance: 'eligible',
    metadataAvailable: true,
    title: 'Something'
  });
  assert.equal(empty.publish, false);
  assert.equal(empty.status, 'rejected');

  const altsOnly = assessPublication({
    source: 'youtube-url',
    components: [{ name: 'Some board', status: 'ALTERNATIVE' }],
    relevance: 'eligible',
    metadataAvailable: true,
    title: 'Something'
  });
  assert.equal(altsOnly.publish, false, 'a result with no USED part is not a bill of materials');
});

test('17. a result with no video metadata is held back rather than published with invented data', () => {
  const held = assessPublication({
    source: 'youtube-url',
    components: [{ name: 'Arduino Uno', status: 'USED' }],
    relevance: 'eligible',
    metadataAvailable: null,
    title: null
  });

  assert.equal(held.publish, false);
  assert.equal(held.status, 'pending');
  assert.equal(held.reason, 'video-metadata-unavailable');
});

test('7. manual transcripts are never auto-published', () => {
  const manual = assessPublication({
    source: 'manual-transcript',
    components: [
      { name: 'Arduino Uno', status: 'USED' },
      { name: 'DHT11', status: 'USED' }
    ],
    relevance: 'eligible',
    metadataAvailable: true,
    title: 'DHT11 with Arduino'
  });

  assert.equal(manual.publish, false);
  assert.equal(manual.status, 'pending');
  assert.equal(manual.reason, 'manual-transcript-unverified');
});

test('an uncertain video with a single component is held for review', () => {
  const held = assessPublication({
    source: 'youtube-url',
    components: [{ name: 'Arduino Uno', status: 'USED' }],
    relevance: 'uncertain',
    metadataAvailable: true,
    title: 'Odd title'
  });

  assert.equal(held.publish, false);
  assert.equal(held.reason, 'eligibility-uncertain');
});

test('19. search text covers the title, channel, and every component name', () => {
  const text = buildSearchText({
    title: 'Temperature Logger Build',
    author: 'Robonyx',
    components: [
      { name: 'DHT11', status: 'USED' },
      { name: 'DHT22', status: 'ALTERNATIVE', alternativeTo: 'DHT11' }
    ]
  });

  assert.ok(text.includes('temperature logger build'));
  assert.ok(text.includes('robonyx'));
  assert.ok(text.includes('dht11'));
  assert.ok(text.includes('dht22'));
  assert.equal(text, text.toLowerCase(), 'search text must be lowercased for case-insensitive matching');
});
