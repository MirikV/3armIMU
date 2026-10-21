import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rotationVectorToQuat,
  rotationVectorAccuracy,
  androidQuatToBabylon,
  androidOrientationAngles,
  androidOrientationToQuat,
  splitHeading,
} from '../src/core/math/frames.js';
import {
  quat,
  fromAxisAngle,
  rotateVector,
  multiply,
  invert,
  toDeg,
  toRad,
  angleBetween,
} from '../src/core/math/quat.js';

const AX_X = { x: 1, y: 0, z: 0 };
const AX_Y = { x: 0, y: 1, z: 0 };
const AX_Z = { x: 0, y: 0, z: 1 };

function closeVec(actual, expected, eps = 1e-6) {
  assert.ok(
    Math.abs(actual.x - expected.x) < eps &&
      Math.abs(actual.y - expected.y) < eps &&
      Math.abs(actual.z - expected.z) < eps,
    `ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`,
  );
}

test('rotation vector из 3 чисел: w достраивается', () => {
  const q = rotationVectorToQuat([0.5, 0, 0]);
  assert.ok(Math.abs(q.w - Math.sqrt(0.75)) < 1e-9);
  assert.ok(Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 1e-9);
});

test('rotation vector из 5 чисел: w берётся как есть, точность отдельно', () => {
  const values = [0.1, 0.2, 0.3, 0.927361849, 0.0873];
  const q = rotationVectorToQuat(values);
  assert.ok(Math.abs(q.w - 0.927361849) < 1e-6);
  assert.equal(rotationVectorAccuracy(values), 0.0873);
  assert.equal(rotationVectorAccuracy([0.1, 0.2, 0.3, 0.9]), null);
});

test('единичный кватернион: оси устройства ложатся на оси Babylon', () => {
  const qb = androidQuatToBabylon(quat());
  // локальный +X (вправо по корпусу) -> восток (+X)
  closeVec(rotateVector(qb, AX_X), { x: 1, y: 0, z: 0 });
  // локальный +Y («12 часов») -> север (+Z)
  closeVec(rotateVector(qb, AX_Y), { x: 0, y: 0, z: 1 });
  // локальный -Z (из экрана) -> вверх (+Y)
  closeVec(rotateVector(qb, { x: 0, y: 0, z: -1 }), { x: 0, y: 1, z: 0 });
});

test('поворот на 90° вокруг вертикали ENU уводит «12 часов» на запад', () => {
  const qa = fromAxisAngle(AX_Z, Math.PI / 2); // против часовой, если смотреть сверху
  const qb = androidQuatToBabylon(qa);
  // Север -> запад. Запад в Babylon это -X.
  closeVec(rotateVector(qb, AX_Y), { x: -1, y: 0, z: 0 });
  // Экран по-прежнему смотрит вверх.
  closeVec(rotateVector(qb, { x: 0, y: 0, z: -1 }), { x: 0, y: 1, z: 0 });
});

test('наклон на 90° вокруг оси X устройства: верх смотрит в небо, экран — на юг', () => {
  const qb = androidQuatToBabylon(fromAxisAngle(AX_X, Math.PI / 2));
  closeVec(rotateVector(qb, AX_Y), { x: 0, y: 1, z: 0 }); // «12 часов» вверх
  closeVec(rotateVector(qb, { x: 0, y: 0, z: -1 }), { x: 0, y: 0, z: -1 }); // экран на юг
});

test('переход в Babylon сохраняет углы между позами', () => {
  // Модуль ориентации меняется (у меша своя нулевая поза), но ОТНОСИТЕЛЬНЫЙ поворот
  // между двумя замерами — это сопряжение ортогональной матрицей, он обязан сохраниться.
  const cases = [
    [quat(), fromAxisAngle(AX_X, toRad(37))],
    [fromAxisAngle(AX_Y, toRad(-112)), fromAxisAngle(AX_Z, toRad(64))],
    [fromAxisAngle({ x: 0.3, y: -0.7, z: 0.2 }, toRad(88)), fromAxisAngle(AX_X, toRad(-15))],
  ];
  for (const [q1, q2] of cases) {
    const before = angleBetween(q1, q2);
    const after = angleBetween(androidQuatToBabylon(q1), androidQuatToBabylon(q2));
    assert.ok(Math.abs(before - after) < 1e-9, `${toDeg(before)}° -> ${toDeg(after)}°`);
  }
});

test('углы ориентации Android считаются как в getOrientation', () => {
  const flat = androidOrientationAngles(quat());
  assert.ok(Math.abs(toDeg(flat.azimuth)) < 1e-6);
  assert.ok(Math.abs(toDeg(flat.pitch)) < 1e-6);
  assert.ok(Math.abs(toDeg(flat.roll)) < 1e-6);

  // Поворот на +90° вокруг вертикали (против часовой сверху) уводит верх устройства
  // на запад, а компасный азимут считается по часовой — значит -90°.
  const turned = androidOrientationAngles(fromAxisAngle(AX_Z, toRad(90)));
  assert.ok(Math.abs(toDeg(turned.azimuth) + 90) < 1e-6, `азимут ${toDeg(turned.azimuth)}`);

  // Наклон на 30° вокруг оси X устройства.
  const tilted = androidOrientationAngles(fromAxisAngle(AX_X, toRad(30)));
  assert.ok(Math.abs(toDeg(tilted.pitch) + 30) < 1e-6, `тангаж ${toDeg(tilted.pitch)}`);
});

test('splitHeading раскладывает поворот на курс и наклон', () => {
  const q = multiply(fromAxisAngle(AX_Z, toRad(65)), fromAxisAngle(AX_X, toRad(-24)));
  const { yaw, tilt, azimuth } = splitHeading(q);
  assert.ok(Math.abs(toDeg(azimuth) + 65) < 1e-6, `азимут ${toDeg(azimuth)}`);
  // Обратная сборка должна дать исходный поворот.
  assert.ok(angleBetween(multiply(yaw, tilt), q) < 1e-8);
  // В остатке курса уже нет.
  assert.ok(Math.abs(androidOrientationAngles(tilt).azimuth) < 1e-8);
  // И «ноль по курсу» снимает именно курс.
  assert.ok(angleBetween(multiply(invert(yaw), q), tilt) < 1e-8);
});

test('androidOrientationToQuat — точное обратное к androidOrientationAngles', () => {
  const cases = [
    { azimuth: 0, pitch: 0, roll: 0 },
    { azimuth: -76.9131414886803, pitch: 6.829161226542664, roll: 8.68314009088811 },
    { azimuth: 179.4, pitch: -88.1, roll: -170.2 },
    { azimuth: -120, pitch: 45, roll: 90 },
    { azimuth: 33.3, pitch: -12.5, roll: 2.2 },
  ];
  for (const c of cases) {
    const q = androidOrientationToQuat({
      azimuth: toRad(c.azimuth),
      pitch: toRad(c.pitch),
      roll: toRad(c.roll),
    });
    const back = androidOrientationAngles(q);
    assert.ok(Math.abs(toDeg(back.azimuth) - c.azimuth) < 1e-9, `azimuth ${c.azimuth}`);
    assert.ok(Math.abs(toDeg(back.pitch) - c.pitch) < 1e-9, `pitch ${c.pitch}`);
    assert.ok(Math.abs(toDeg(back.roll) - c.roll) < 1e-9, `roll ${c.roll}`);
  }
});

test('углы из часов согласованы с осями мира ENU', () => {
  // Часы плашмя экраном вверх, «12 часов» смотрят на север — единичный поворот.
  const flat = androidOrientationToQuat({ azimuth: 0, pitch: 0, roll: 0 });
  assert.ok(angleBetween(flat, quat()) < 1e-9);

  // Тот же наклон, но повёрнут на восток: верх устройства должен смотреть на восток (+X ENU).
  const east = androidOrientationToQuat({ azimuth: toRad(90), pitch: 0, roll: 0 });
  const up = rotateVector(east, { x: 0, y: 1, z: 0 });
  assert.ok(Math.abs(up.x - 1) < 1e-9, `верх устройства должен лечь на восток, получили ${JSON.stringify(up)}`);
});
