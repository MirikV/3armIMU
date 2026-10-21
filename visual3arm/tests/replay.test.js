/**
 * Воспроизведение записи: темп, пауза, скорость, перемотка, зацикливание.
 *
 * Время подменяется часами из опций, а тики вызываются руками — иначе тест зависел бы
 * от планировщика node и от реальных 20 мс. Проверяем именно то, ради чего источник
 * вообще нужен: запись должна играть В ТЕМПЕ записи, а не выстреливать очередью.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ReplaySource } from '../src/core/mqtt/ReplaySource.js';
import { serializeRecording } from '../src/core/mqtt/recording.js';

/** Запись на 1 с: 11 пакетов с шагом 0.1 с. */
function makeEntries(count = 11, step = 0.1) {
  return Array.from({ length: count }, (_, i) => ({
    t: +(i * step).toFixed(3),
    topic: 'robot/watch/rotation',
    payload: JSON.stringify({ q: [0, 0, 0, 1], n: i }),
  }));
}

/** Источник с рукотворными часами: clock.t двигаем сами, тики зовём сами. */
function makeSource(options = {}) {
  const clock = { t: 100 };
  const src = new ReplaySource({
    entries: makeEntries(),
    clock: () => clock.t,
    ...options,
  });
  const samples = [];
  const statuses = [];
  src.on('sample', (s) => samples.push(s));
  src.on('status', (s) => statuses.push(s));
  src.connect();
  // Собственный таймер источника гасим: он тикал бы параллельно с ручными вызовами
  // и по настоящим часам. Состояние при этом остаётся «подключено».
  clearInterval(src.timer);
  src.timer = null;
  return { src, clock, samples, statuses };
}

test('воспроизведение: пакеты выдаются в темпе записи, а не очередью', () => {
  const { src, clock, samples } = makeSource();
  clock.t += 0.25;
  src._tick();
  // Прошло 0.25 с — успели выйти пакеты на 0, 0.1 и 0.2 с, и только они.
  assert.equal(samples.length, 3);
  clock.t += 0.2;
  src._tick();
  assert.equal(samples.length, 5);
  src.disconnect();
});

test('воспроизведение: пауза останавливает время записи, а после снятия нет залпа', () => {
  const { src, clock, samples } = makeSource();
  clock.t += 0.25;
  src._tick();
  const before = samples.length;
  const position = src.position;

  src.pause();
  clock.t += 10; // На паузе стенные часы ушли далеко вперёд.
  src._tick();
  assert.equal(samples.length, before, 'на паузе пакетов быть не должно');
  assert.equal(src.position, position, 'позиция на паузе не двигается');

  src.resume();
  clock.t += 0.1;
  src._tick();
  assert.equal(samples.length, before + 1, 'после снятия паузы простой не досылается залпом');
  src.disconnect();
});

test('воспроизведение: скорость меняется на лету и не сбрасывает позицию', () => {
  const { src, clock, samples } = makeSource();
  clock.t += 0.25;
  src._tick();
  const position = src.position;

  src.setSpeed(2);
  assert.ok(Math.abs(src.position - position) < 1e-12, 'смена скорости не трогает позицию');

  clock.t += 0.25; // при ×2 это 0.5 с записи: позиция уезжает до 0.75 с
  src._tick();
  assert.ok(Math.abs(src.position - (position + 0.5)) < 1e-9);
  assert.equal(samples.length, 8);
  src.disconnect();
});

test('воспроизведение: перемотка ставит позицию и не досылает пропущенное очередью', () => {
  const { src, clock, samples } = makeSource();
  clock.t += 0.05;
  src._tick();
  assert.equal(samples.length, 1);

  src.seek(0.7);
  assert.ok(Math.abs(src.position - 0.7) < 1e-9);
  clock.t += 0.15;
  src._tick();
  // Пакеты с 0.1 по 0.7 остались позади и в поток не пошли — вышел только следующий.
  assert.equal(samples.length, 2);
  assert.equal(JSON.parse(src.entries[src.index - 1].payload).n, 8);
  src.disconnect();
});

test('воспроизведение: перемотка зажимается границами записи', () => {
  const { src } = makeSource();
  src.seek(-5);
  assert.equal(src.position, 0);
  src.seek(999);
  assert.ok(Math.abs(src.position - src.duration) < 1e-9);
  assert.ok(src.progress <= 1);
  src.disconnect();
});

test('воспроизведение: зацикливание начинает запись заново, без зацикливания — закрывает источник', () => {
  const loop = makeSource({ loop: true });
  loop.clock.t += 5;
  loop.src._tick();
  assert.equal(loop.src.position, 0, 'после конца головка вернулась в начало');
  assert.equal(loop.samples.length, 11);
  loop.src.disconnect();

  const once = makeSource({ loop: false });
  once.clock.t += 5;
  once.src._tick();
  assert.equal(once.samples.length, 11);
  assert.equal(once.src.isActive, false);
  assert.ok(
    once.statuses.some((s) => s.state === 'closed'),
    'доигранная запись должна сообщить о себе статусом',
  );
});

test('воспроизведение: пустая запись — это ошибка подключения, а не тихий простой', () => {
  const errors = [];
  const src = new ReplaySource({ entries: [], clock: () => 0 });
  src.on('error', (e) => errors.push(e));
  src.connect();
  assert.equal(src.isActive, false);
  assert.equal(errors.length, 1);
  src.disconnect();
});

test('воспроизведение: нагрузка проходит через тот же парсер, что и живой поток', () => {
  const text = serializeRecording([
    { t: 0, topic: 'robot/watch/rotation', payload: '{"ts":1,"q":[0,0,0,1]}' },
    { t: 0.02, topic: 'robot/watch/rotation', payload: '[0.1,0,0,0.995]' },
  ]);
  const clock = { t: 0 };
  const src = new ReplaySource({ text, clock: () => clock.t, loop: false });
  const samples = [];
  src.on('sample', (s) => samples.push(s));
  src.connect();
  clearInterval(src.timer);
  src.timer = null;
  clock.t += 1;
  src._tick();
  assert.equal(samples.length, 2);
  for (const s of samples) assert.ok(Number.isFinite(s.quat.w));
  // recvTime — момент воспроизведения, иначе сглаживание получит отрицательный dt.
  assert.ok(samples[1].recvTime >= samples[0].recvTime);
  src.disconnect();
});
