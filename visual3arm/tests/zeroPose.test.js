/**
 * Обнуление по текущей позе должно обнулять ПОСЛЕ калибровки, а не до неё.
 *
 * ── Что здесь пинится ──
 * Калибровка считается как q_eff = zero⁻¹ ⊗ q_raw ⊗ mount. Когда mount был единичным
 * («12 часов к кисти»), достаточно было запомнить zero = q_raw: подстановка давала
 * ровно единицу. С появлением измеряемой оси предплечья mount перестал быть единичным
 * (mount = A ⊗ E, см. core/math/calibration.js), и та же подстановка даёт
 * q_eff = mount, то есть ось предплечья после «обнуления» смотрит не вперёд, а туда,
 * куда её развернул A. Азимут при этом остаётся равным отклонению оси от «12 часов» —
 * на живой записи это 77°, у часов, надетых с разворотом на 45°, ровно 45°, и робот
 * стоит наискось при вытянутой вперёд руке.
 *
 * Поэтому ноль берётся от УЖЕ калиброванной позы: zero = q_raw ⊗ mount. И, раз mount
 * может смениться позже (человек нажал «Измерить скруткой» после обнуления), ноль
 * пересчитывается из сохранённой сырой позы при каждой смене mount.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Calibration } from '../src/core/math/calibration.js';
import { forearmAim } from '../src/core/math/aim.js';
import {
  quat,
  fromAxisAngle,
  multiply,
  toRad,
  toDeg,
  normalize,
  invert,
} from '../src/core/math/quat.js';

const AX_X = { x: 1, y: 0, z: 0 };
const AX_Y = { x: 0, y: 1, z: 0 };
const AX_Z = { x: 0, y: 0, z: 1 };

/** Произвольная, заведомо «некруглая» поза руки в момент нажатия кнопки. */
const POSE = normalize(
  multiply(
    multiply(fromAxisAngle(AX_Z, toRad(37)), fromAxisAngle(AX_X, toRad(-21))),
    fromAxisAngle(AX_Y, toRad(64)),
  ),
);

/**
 * Поворот всей руки по курсу на deg градусов (компасный: по часовой от «севера»).
 * Это поворот МИРОВОЙ системы, поэтому умножение слева — как и в splitHeading().
 */
function turn(qRaw, deg) {
  return normalize(multiply(fromAxisAngle(AX_Z, -toRad(deg)), qRaw));
}

/** Ось предплечья, отклонённая на deg градусов от «12 часов» в плоскости XY корпуса. */
function tiltedAxis(deg) {
  return { x: Math.sin(toRad(deg)), y: Math.cos(toRad(deg)), z: 0 };
}

function aimAfterZero(axis, qZero, qNow, mode = 'full') {
  const cal = new Calibration();
  cal.setForearmAxis(axis);
  cal.captureZero(qZero, mode);
  return forearmAim(cal.apply(qNow));
}

test('после обнуления текущая поза даёт нулевой азимут при любом развороте часов', () => {
  for (const deg of [0, 15, 45, 77, 120, -45]) {
    const aim = aimAfterZero(tiltedAxis(deg), POSE, POSE);
    assert.ok(
      Math.abs(toDeg(aim.azimuth)) < 1e-6,
      `ось отклонена на ${deg}°: азимут после нуля ${toDeg(aim.azimuth).toFixed(1)}°`,
    );
    assert.ok(
      Math.abs(toDeg(aim.elevation)) < 1e-6,
      `ось отклонена на ${deg}°: возвышение после нуля ${toDeg(aim.elevation).toFixed(1)}°`,
    );
  }
});

/**
 * Сырая поза часов, дающая заданную КАЛИБРОВАННУЮ ориентацию при данной оси
 * предплечья: q_raw = q_cal ⊗ mount⁻¹. Так синтетика описывает руку, а не корпус
 * часов, — «предплечье горизонтально, курс такой-то» независимо от того, как часы
 * надеты.
 */
function rawFor(axis, qCal) {
  const cal = new Calibration();
  cal.setForearmAxis(axis);
  return normalize(multiply(qCal, invert(cal.mount)));
}

test('«вперёд» даёт ноль, «вправо» и «влево» — симметричные ±90°', () => {
  const axis = tiltedAxis(45);
  // Предплечье горизонтально и смотрит в произвольную сторону: калиброванная поза —
  // чистый курс, возвышение и скрутка нулевые. Это и есть «рука вытянута вперёд».
  const forwardRaw = rawFor(axis, fromAxisAngle(AX_Z, -toRad(40)));

  const forward = aimAfterZero(axis, forwardRaw, forwardRaw);
  const right = aimAfterZero(axis, forwardRaw, turn(forwardRaw, 90));
  const left = aimAfterZero(axis, forwardRaw, turn(forwardRaw, -90));

  assert.ok(Math.abs(toDeg(forward.azimuth)) < 1e-6, `вперёд: ${toDeg(forward.azimuth)}°`);
  assert.ok(Math.abs(toDeg(right.azimuth) - 90) < 1e-6, `вправо: ${toDeg(right.azimuth)}°`);
  assert.ok(Math.abs(toDeg(left.azimuth) + 90) < 1e-6, `влево: ${toDeg(left.azimuth)}°`);
  assert.ok(
    Math.abs(toDeg(right.azimuth) + toDeg(left.azimuth)) < 1e-9,
    'вправо и влево обязаны быть симметричны',
  );
});

test('обнуление по курсу оставляет физический наклон, но гасит азимут', () => {
  const axis = tiltedAxis(45);
  const aim = aimAfterZero(axis, POSE, POSE, 'heading');
  assert.ok(Math.abs(toDeg(aim.azimuth)) < 1e-6, `азимут остался: ${toDeg(aim.azimuth)}°`);
  // Возвышение — физическая величина, её «только курс» трогать не должен.
  const cal = new Calibration();
  cal.setForearmAxis(axis);
  const free = forearmAim(cal.apply(POSE));
  assert.ok(
    Math.abs(toDeg(aim.elevation) - toDeg(free.elevation)) < 1e-6,
    `возвышение поехало: ${toDeg(aim.elevation)}° против ${toDeg(free.elevation)}°`,
  );
});

test('ось предплечья, измеренная после обнуления, ноль не ломает', () => {
  const cal = new Calibration();
  cal.captureZero(POSE, 'full');
  // Человек сначала обнулил, потом вспомнил про «Измерить скруткой».
  cal.setForearmAxis(tiltedAxis(77));
  const aim = forearmAim(cal.apply(POSE));
  assert.ok(
    Math.abs(toDeg(aim.azimuth)) < 1e-6,
    `ноль не пересчитался под новую ось: азимут ${toDeg(aim.azimuth).toFixed(1)}°`,
  );

  // И ручная доводка установки — тоже.
  cal.setMountEulerDeg({ x: 0, y: 30, z: 0 });
  const after = forearmAim(cal.apply(POSE));
  assert.ok(
    Math.abs(toDeg(after.azimuth)) < 1e-6,
    `ноль не пережил mount-углы: азимут ${toDeg(after.azimuth).toFixed(1)}°`,
  );
});

test('сброс нуля возвращает необнулённую ориентацию', () => {
  const axis = tiltedAxis(45);

  const never = new Calibration();
  never.setForearmAxis(axis);

  const cleared = new Calibration();
  cleared.setForearmAxis(axis);
  cleared.captureZero(POSE, 'full');
  cleared.clearZero();

  assert.ok(Math.abs(cleared.zero.w - 1) < 1e-12, 'после сброса ноль обязан быть единичным');
  assert.ok(
    Math.abs(forearmAim(cleared.apply(POSE)).azimuth - forearmAim(never.apply(POSE)).azimuth) < 1e-12,
    'сброс нуля не вернул исходный азимут',
  );

  // И повторная смена оси не должна воскресить сброшенный ноль.
  cleared.setForearmAxis(tiltedAxis(10));
  assert.ok(Math.abs(cleared.zero.w - 1) < 1e-12, 'сброшенный ноль вернулся при смене оси');
});
