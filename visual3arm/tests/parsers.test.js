import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePayload, normalizeTimestamp } from '../src/core/mqtt/parsers.js';
import { androidOrientationAngles } from '../src/core/math/frames.js';

const DEG = Math.PI / 180;

function close(a, b, eps = 1e-6) {
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
}

test('JSON-массив из 4 чисел', () => {
  const s = parsePayload('[0.1, 0.2, 0.3, 0.927361849]');
  close(s.quat.x, 0.1);
  close(s.quat.w, 0.927361849);
  assert.equal(s.accuracy, null);
});

test('JSON-массив из 5 чисел: пятое — точность курса', () => {
  const s = parsePayload('[0.1,0.2,0.3,0.927361849,0.05]');
  close(s.accuracy, 0.05);
});

test('плоский объект с x/y/z/w и меткой времени', () => {
  const s = parsePayload(JSON.stringify({ x: 0, y: 0, z: 0, w: 1, timestamp: 1737000000000 }));
  close(s.quat.w, 1);
  close(s.sensorTime, 1737000000);
});

test('вложенные values и accuracy', () => {
  const s = parsePayload(
    JSON.stringify({ sensor: 'rotation_vector', values: [0, 0, 0.7071068, 0.7071068], accuracy: 0.1 }),
  );
  close(s.quat.z, 0.7071068);
  close(s.accuracy, 0.1);
});

test('путь внутри JSON', () => {
  const s = parsePayload(JSON.stringify({ payload: { rv: { q: [0, 0, 0, 1] } } }), {
    path: 'payload.rv',
  });
  close(s.quat.w, 1);
});

test('числа через запятую', () => {
  const s = parsePayload('0.1;0.2 0.3,0.927361849');
  close(s.quat.y, 0.2);
});

test('шесть чисел: первое считается меткой времени', () => {
  const s = parsePayload('[123456789012345678, 0, 0, 0, 1, 0.02]');
  assert.ok(s.sensorTime > 1e8, 'метка времени должна быть переведена в секунды');
  close(s.quat.w, 1);
  close(s.accuracy, 0.02);
});

test('три числа: w достраивается', () => {
  const s = parsePayload('[0,0,0.5]');
  close(s.quat.w, Math.sqrt(0.75));
});

test('Uint8Array из mqtt.js', () => {
  const s = parsePayload(new TextEncoder().encode('[0,0,0,1]'));
  close(s.quat.w, 1);
});

test('линейное ускорение подхватывается, если его прислали', () => {
  const s = parsePayload(
    JSON.stringify({ t: 1737000000000, values: [0, 0, 0, 1], linearAccel: [0.1, -0.2, 9.8] }),
  );
  close(s.linearAccel.x, 0.1);
  close(s.linearAccel.z, 9.8);

  // Объектная запись тоже подходит.
  const s2 = parsePayload(JSON.stringify({ x: 0, y: 0, z: 0, w: 1, la: { x: 1, y: 2, z: 3 } }));
  close(s2.linearAccel.y, 2);

  // Без поля — null, а не мусор.
  assert.equal(parsePayload('[0,0,0,1]').linearAccel, null);
});

test('канонический пакет контракта: {ts, q:[x,y,z,w]}', () => {
  // Формат зафиксирован в .claude/contract-mqtt.md (решение от 2026-09-20): сырые
  // event.values датчика GAME_ROTATION_VECTOR, порядок x, y, z, w, ts — мс epoch.
  // Тест здесь ровно для того, чтобы часы не смогли поменять формат в одиночку.
  const packet = { ts: 1789730075081, q: [0.12, -0.03, 0.71, 0.69] };
  const s = parsePayload(JSON.stringify(packet));

  const n = Math.hypot(...packet.q);
  close(s.quat.x, packet.q[0] / n);
  close(s.quat.y, packet.q[1] / n);
  close(s.quat.z, packet.q[2] / n);
  close(s.quat.w, packet.q[3] / n);
  close(s.sensorTime, 1789730075.081, 1e-3);

  // У GAME_ROTATION_VECTOR нет values[4] — точность курса обязана быть null, а не нулём.
  assert.equal(s.accuracy, null);
  assert.equal(s.euler, null);
  assert.equal(s.angleUnit, null);

  // Голый массив [x,y,z,w] — вторая разрешённая контрактом форма.
  const bare = parsePayload(JSON.stringify(packet.q));
  close(bare.quat.z, packet.q[2] / n);
  assert.equal(bare.sensorTime, null);
});

test('пакет часов с углами: {ts, azimuth, pitch, roll} в градусах', () => {
  const packet = {
    ts: 1789730075081,
    azimuth: -76.9131414886803,
    pitch: 6.829161226542664,
    roll: 8.68314009088811,
  };
  const s = parsePayload(JSON.stringify(packet));

  assert.equal(s.angleUnit, 'deg');
  close(s.sensorTime, 1789730075.081, 1e-3);

  // Кватернион должен разбираться обратно ровно в те же углы.
  const back = androidOrientationAngles(s.quat);
  close(back.azimuth / DEG, packet.azimuth, 1e-9);
  close(back.pitch / DEG, packet.pitch, 1e-9);
  close(back.roll / DEG, packet.roll, 1e-9);

  // У углов нет ни точности курса, ни ускорения.
  assert.equal(s.accuracy, null);
  assert.equal(s.linearAccel, null);
});

test('углы: авто-детект единиц и явное указание', () => {
  const big = JSON.stringify({ azimuth: -76.9, pitch: 6.8, roll: 8.7 });
  assert.equal(parsePayload(big).angleUnit, 'deg');

  // Всё влезает в радианный диапазон — 'auto' считает радианами.
  const small = JSON.stringify({ azimuth: 1.2, pitch: 0.3, roll: -0.8 });
  assert.equal(parsePayload(small).angleUnit, 'rad');
  close(parsePayload(small).euler.azimuth, 1.2);

  // Явная настройка сильнее эвристики — ровно ради таких «мелких» пакетов.
  const forced = parsePayload(small, { angleUnit: 'deg' });
  assert.equal(forced.angleUnit, 'deg');
  close(forced.euler.azimuth, 1.2 * DEG);

  // Один только pitch за ±90° тоже выдаёт градусы.
  assert.equal(parsePayload(JSON.stringify({ azimuth: 0.1, pitch: 2, roll: 0.2 })).angleUnit, 'deg');
});

test('углы: синонимы ключей и вложенность', () => {
  const s = parsePayload(JSON.stringify({ yaw: 90, elevation: 0, bank: 0 }));
  close(androidOrientationAngles(s.quat).azimuth / DEG, 90, 1e-9);

  const nested = parsePayload(JSON.stringify({ data: { azimuth: 45, pitch: 10, roll: -5 } }));
  close(androidOrientationAngles(nested.quat).roll / DEG, -5, 1e-9);
});

test('углы: неполный набор — не ориентация, а битый пакет', () => {
  assert.throws(() => parsePayload(JSON.stringify({ azimuth: 10, pitch: 5 })), /Не удалось разобрать/);
});

test('кватернион приоритетнее углов, если пришло и то и другое', () => {
  const s = parsePayload(JSON.stringify({ x: 0, y: 0, z: 0, w: 1, azimuth: 90, pitch: 0, roll: 0 }));
  close(s.quat.w, 1);
  assert.equal(s.euler, null);
  assert.equal(s.angleUnit, null);
});

test('мусор приводит к понятной ошибке', () => {
  assert.throws(() => parsePayload('не пакет вовсе'), /Не удалось разобрать/);
});

test('нормализация меток времени', () => {
  close(normalizeTimestamp(1.5e18), 1.5e9); // наносекунды
  close(normalizeTimestamp(1737000000000), 1737000000); // миллисекунды
  close(normalizeTimestamp(12.5), 12.5); // секунды
  assert.equal(normalizeTimestamp(undefined), null);
});
