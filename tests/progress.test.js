import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPECTED_MS,
  PROGRESS_CAP,
  estimateProgress,
  progressLabel,
  progressMessage
} from '../frontend/src/services/progress.js';

test('4/5. the estimate never reaches 100% while a request is in flight', () => {
  const samples = [0, 100, 1000, 5000, EXPECTED_MS, 60_000, 600_000, 36_000_000];

  for (const ms of samples) {
    const value = estimateProgress(ms);
    assert.ok(value < 100, `estimate hit 100% at ${ms}ms`);
    assert.ok(value < PROGRESS_CAP, `estimate reached the cap at ${ms}ms`);
    assert.ok(value >= 0, `estimate went negative at ${ms}ms`);
  }
});

test('the estimate is monotonically non-decreasing over time', () => {
  let previous = -1;
  for (let ms = 0; ms <= 120_000; ms += 250) {
    const value = estimateProgress(ms);
    assert.ok(value >= previous, `estimate moved backwards at ${ms}ms`);
    previous = value;
  }
});

test('progress starts at zero and makes visible early progress', () => {
  assert.equal(estimateProgress(0), 0);
  assert.ok(estimateProgress(2000) > 10, 'the bar should move promptly so it does not look stuck');
  assert.ok(estimateProgress(EXPECTED_MS) > 70);
});

test('invalid elapsed values are treated as zero rather than throwing', () => {
  assert.equal(estimateProgress(null), 0);
  assert.equal(estimateProgress(undefined), 0);
  assert.equal(estimateProgress('abc'), 0);
  assert.equal(estimateProgress(-5000), 0);
});

test('a long-running request says it is still processing instead of claiming stages', () => {
  const early = progressMessage(1000);
  const late = progressMessage(EXPECTED_MS * 1.5);
  const veryLate = progressMessage(EXPECTED_MS * 5);

  assert.match(early, /transcript|extracting/i);
  assert.match(late, /longer than usual/i);
  assert.match(veryLate, /still processing/i);

  // Nothing in the copy claims a completed stage.
  for (const message of [early, late, veryLate]) {
    assert.doesNotMatch(message, /complete|finished|done|uploaded|stage \d/i);
  }
});

test('the accessible label reflects the real phase', () => {
  assert.match(progressLabel('running', 42), /in progress/i);
  assert.match(progressLabel('done'), /complete/i);
  assert.match(progressLabel('error'), /failed/i);
  assert.equal(progressLabel('idle'), '');
});
