/**
 * Измерение оси предплечья по скрутке (core/math/forearmAxis.js).
 *
 * Здесь проверяется сама оценка на синтетике, где ответ известен точно. Проверка на
 * живой записи с часов — в twistLive.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ForearmAxisEstimator,
  estimateForearmAxis,
  mountFromForearmAxis,
  forearmAxisFromMount,
  orientAxis,
  NOMINAL_FOREARM_AXIS,
} from '../src/core/math/forearmAxis.js';
import { Calibration } from '../src/core/math/calibration.js';
import { forearmAim } from '../src/core/math/aim.js';
import {
  quat,
  multiply,
  fromAxisAngle,
  rotateVector,
  normalize,
  toRad,
  toDeg,
} from '../src/core/math/quat.js';

function unit(v) {
  const n = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

function angleBetweenAxes(a, b) {
  return toDeg(Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))));
}

/** Чистая скрутка вокруг оси axis (в осях корпуса) из позы q0. */
function twistSweep(q0, axis, fromDeg, toDeg_, stepDeg = 2) {
  const out = [];
  for (let phi = fromDeg; phi <= toDeg_; phi += stepDeg) {
    out.push(normalize(multiply(q0, fromAxisAngle(axis, toRad(phi)))));
  }
  return out;
}

test('ось: чистая скрутка вокруг произвольной оси корпуса восстанавливается точно', () => {
  const q0 = normalize(quat(0.2, -0.3, 0.1, 0.9));
  for (const axis of [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    unit({ x: 0.97, y: 0.22, z: 0.08 }), // ось из живой записи
    unit({ x: -0.3, y: 0.5, z: 0.81 }),
  ]) {
    const r = estimateForearmAxis(twistSweep(q0, axis, -70, 70), { reference: axis });
    assert.ok(
      angleBetweenAxes(r.axis, axis) < 0.05,
      `ось найдена с ошибкой ${angleBetweenAxes(r.axis, axis).toFixed(3)}°`,
    );
    assert.ok(r.quality > 0.999, `чистота одноосного жеста вышла ${r.quality.toFixed(3)}`);
    assert.ok(Math.abs(toDeg(r.sweep) - 140) < 1, `размах ${toDeg(r.sweep).toFixed(1)}° вместо 140°`);
  }
});

test('ось: размах считается по пути «туда и обратно», а не по разности концов', () => {
  const q0 = quat();
  const ax = { x: 0, y: 1, z: 0 };
  const there = twistSweep(q0, ax, 0, 90);
  const back = twistSweep(q0, ax, 90, 0, -2);
  const r = estimateForearmAxis([...there, ...back]);
  // Итог совпал со стартом, но рука прошла 90° — иначе калибровка отвергала бы
  // нормальные жесты «скрутил и вернул».
  assert.ok(Math.abs(toDeg(r.sweep) - 90) < 1, `размах ${toDeg(r.sweep).toFixed(1)}°`);
});

test('ось: размашистое движение не одной осью честно помечается низкой чистотой', () => {
  const q0 = quat();
  // Сначала поворот вокруг одной оси, потом вокруг другой — ровно то, что получится,
  // если человек вместо скрутки помашет рукой.
  const mixed = [...twistSweep(q0, { x: 0, y: 1, z: 0 }, 0, 60)];
  const q1 = mixed[mixed.length - 1];
  mixed.push(...twistSweep(q1, { x: 1, y: 0, z: 0 }, 0, 60));
  const r = estimateForearmAxis(mixed);
  assert.ok(r.quality < 0.9, `чистота ${r.quality.toFixed(3)} — такой жест должны отвергать`);
});

test('ось: покой не даёт оценки и не портит накопленную', () => {
  const est = new ForearmAxisEstimator();
  for (let i = 0; i < 200; i++) est.push(normalize(quat(0.001, 0.4, 0, 0.9)));
  const r = est.estimate();
  assert.equal(r.steps, 0);
  assert.equal(r.quality, 0);
  assert.equal(r.sweep, 0);
});

test('знак оси по скрутке не наблюдаем — выбирается полушарие опорной оси', () => {
  const axis = unit({ x: 0.97, y: 0.22, z: 0.08 });
  const flipped = { x: -axis.x, y: -axis.y, z: -axis.z };
  // Одни и те же данные: знак определяет только опора.
  const data = twistSweep(quat(), axis, -60, 60);
  const a = estimateForearmAxis(data, { reference: axis });
  const b = estimateForearmAxis(data, { reference: flipped });
  assert.ok(angleBetweenAxes(a.axis, axis) < 0.05);
  assert.ok(angleBetweenAxes(b.axis, flipped) < 0.05);
  // Опора почти перпендикулярна — знак по ней не восстановить, берём правило
  // «наибольшая компонента положительна»: результат воспроизводим.
  const c = orientAxis(flipped, NOMINAL_FOREARM_AXIS);
  assert.ok(c.x > 0, 'правило выбора знака перестало быть детерминированным');
});

test('mount из оси: номинальная ось даёт единицу, любая другая — переводит в неё +Y', () => {
  const m0 = mountFromForearmAxis(NOMINAL_FOREARM_AXIS);
  assert.ok(Math.abs(m0.w - 1) < 1e-12, 'на номинальной оси установка обязана быть единичной');

  for (const axis of [
    unit({ x: 1, y: 0, z: 0 }),
    unit({ x: 0.97, y: 0.22, z: 0.08 }),
    unit({ x: 0, y: -1, z: 0 }), // ось смотрит ровно назад — вырождение кратчайшей дуги
  ]) {
    const m = mountFromForearmAxis(axis);
    const got = rotateVector(m, NOMINAL_FOREARM_AXIS);
    assert.ok(angleBetweenAxes(got, axis) < 1e-3, 'mount не перевёл +Y в заданную ось');
    assert.ok(angleBetweenAxes(forearmAxisFromMount(m), axis) < 1e-3, 'обратный разбор не сошёлся');
  }
});

test('калибровка с измеренной осью: скрутка вокруг неё не трогает прицел', () => {
  const axis = unit({ x: 0.97, y: 0.22, z: 0.08 });
  const cal = new Calibration();
  cal.setForearmAxis(axis);

  const q0 = normalize(quat(0.1, 0.2, -0.15, 0.96));
  const ref = forearmAim(cal.apply(q0));
  for (const phi of [-120, -60, -20, 20, 60, 120]) {
    const q = multiply(q0, fromAxisAngle(axis, toRad(phi)));
    const aim = forearmAim(cal.apply(q));
    assert.ok(
      Math.abs(toDeg(aim.azimuth - ref.azimuth)) < 1e-9,
      `скрутка ${phi}° увела азимут на ${toDeg(aim.azimuth - ref.azimuth)}°`,
    );
    assert.ok(
      Math.abs(toDeg(aim.elevation - ref.elevation)) < 1e-9,
      `скрутка ${phi}° увела возвышение на ${toDeg(aim.elevation - ref.elevation)}°`,
    );
    // И вся скрутка целиком попала в twist, а не растеклась.
    const got = toDeg(aim.twist - ref.twist);
    assert.ok(Math.abs(got - phi) < 1e-6, `в скрутку пришло ${got.toFixed(2)}° вместо ${phi}°`);
  }
});

test('калибровка: ручные углы установки остаются доводкой поверх измеренной оси', () => {
  const axis = unit({ x: 1, y: 0, z: 0 });
  const cal = new Calibration();
  cal.setForearmAxis(axis);
  const onlyAxis = { ...cal.mount };
  cal.setMountEulerDeg({ x: 0, y: 30, z: 0 });
  // Поворот вокруг +Y — это поворот вокруг САМОЙ оси предплечья, направление оси он
  // менять не должен: ручка «вокруг руки» крутит часы на руке, а не руку.
  assert.ok(
    angleBetweenAxes(forearmAxisFromMount(cal.mount), axis) < 1e-3,
    'ручная доводка вокруг руки сбила измеренную ось',
  );
  cal.setMountEulerDeg({ x: 0, y: 0, z: 0 });
  assert.ok(
    angleBetweenAxes(forearmAxisFromMount(cal.mount), forearmAxisFromMount(onlyAxis)) < 1e-3,
    'сброс ручных углов потерял измеренную ось',
  );
});
