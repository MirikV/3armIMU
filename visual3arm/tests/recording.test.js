/**
 * Формат записи пакетов. Это контракт с внешним миром: такой файл должен читаться
 * обычным node-скриптом, поэтому проверяем именно построчность и терпимость к мусору.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  serializeRecording,
  parseRecording,
  recordingDuration,
} from '../src/core/mqtt/recording.js';
import { parsePayload } from '../src/core/mqtt/parsers.js';

const SAMPLE = [
  { t: 0, topic: 'robot/watch/rotation', payload: '{"q":[0,0,0,1]}' },
  { t: 0.02, topic: 'robot/watch/rotation', payload: '[0.1,0,0,0.995]' },
  { t: 0.041, topic: 'robot/watch/rotation', payload: '{"ts":1789730075081,"azimuth":-76.9,"pitch":6.8,"roll":8.7}' },
];

test('запись: одна строка — один пакет, и каждая строка сама по себе валидный JSON', () => {
  const text = serializeRecording(SAMPLE);
  const lines = text.split('\n');
  assert.equal(lines.length, SAMPLE.length);
  for (const line of lines) {
    const obj = JSON.parse(line);
    assert.equal(typeof obj.payload, 'string');
    assert.ok(Number.isFinite(obj.t));
  }
});

test('запись: круговой прогон сохраняет и время, и полезную нагрузку дословно', () => {
  const { entries, skipped } = parseRecording(serializeRecording(SAMPLE));
  assert.equal(skipped, 0);
  assert.deepEqual(entries, SAMPLE);
  assert.ok(Math.abs(recordingDuration(entries) - 0.041) < 1e-9);
});

test('запись: битые строки пропускаются, а не роняют весь файл', () => {
  // Обрезанный на середине хвост — самый частый способ испортить запись.
  const text = `${serializeRecording(SAMPLE)}\n\n{"t":1.0,"topic":"x","pay`;
  const { entries, skipped } = parseRecording(text);
  assert.equal(entries.length, 3);
  assert.equal(skipped, 1);
});

test('запись: строка без времени встаёт за предыдущей, а не в ноль', () => {
  const { entries } = parseRecording(
    ['{"t":5,"payload":"[0,0,0,1]"}', '{"payload":"[0,0,0,1]"}'].join('\n'),
  );
  assert.equal(entries.length, 2);
  assert.ok(entries[1].t > entries[0].t, 'вторая строка должна оказаться позже первой');
});

test('запись: воспроизведённая нагрузка разбирается тем же парсером, что и живой поток', () => {
  const { entries } = parseRecording(serializeRecording(SAMPLE));
  for (const e of entries) {
    const sample = parsePayload(e.payload, { now: 0 });
    assert.ok(Number.isFinite(sample.quat.w));
  }
});
