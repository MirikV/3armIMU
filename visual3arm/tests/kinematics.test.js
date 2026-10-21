import test from 'node:test';
import assert from 'node:assert/strict';

import { Calibration } from '../src/core/math/calibration.js';
import { RobotModel } from '../src/core/robot/RobotModel.js';
import { mapArmToRobot } from '../src/core/robot/armToRobot.js';
import { QuatSmoother } from '../src/core/math/filter.js';
import { androidOrientationAngles, androidQuatToBabylon } from '../src/core/math/frames.js';
import { quat, fromAxisAngle, multiply, angleBetween, toRad, toDeg } from '../src/core/math/quat.js';

const AX_X = { x: 1, y: 0, z: 0 };
const AX_Z = { x: 0, y: 0, z: 1 };

test('полное обнуление делает текущую позу единичной', () => {
  const cal = new Calibration();
  const q = multiply(fromAxisAngle(AX_Z, toRad(40)), fromAxisAngle(AX_X, toRad(25)));
  cal.captureZero(q, 'full');
  assert.ok(angleBetween(cal.apply(q), quat()) < 1e-9);
});

test('обнуление по курсу снимает азимут, но оставляет наклон', () => {
  const cal = new Calibration();
  const q = multiply(fromAxisAngle(AX_Z, toRad(40)), fromAxisAngle(AX_X, toRad(25)));
  cal.captureZero(q, 'heading');
  const out = cal.apply(q);
  const a = androidOrientationAngles(out);
  assert.ok(Math.abs(toDeg(a.azimuth)) < 1e-6, `азимут остался: ${toDeg(a.azimuth)}`);
  assert.ok(Math.abs(Math.abs(toDeg(a.pitch)) - 25) < 1e-6, `тангаж поехал: ${toDeg(a.pitch)}`);
});

test('mount-смещение поворачивает локальные оси устройства', () => {
  const cal = new Calibration();
  cal.setMountEulerDeg({ x: 0, y: 90, z: 0 });
  const out = cal.apply(quat());
  assert.ok(Math.abs(toDeg(angleBetween(out, quat())) - 90) < 1e-6);
});

test('робот: углы обрезаются по лимитам', () => {
  const model = new RobotModel();
  // Сами числа лимитов берём из модели: геометрия — это данные, и тест про обрезку
  // не должен ломаться от того, что манипулятору расширили ход.
  const [lo, hi] = model.jointByName('lift').limits;
  model.setAngles({ lift: toRad(hi + 300) });
  assert.ok(Math.abs(toDeg(model.angles.lift) - hi) < 1e-9);
  model.setAngles({ lift: toRad(lo - 300) });
  assert.ok(Math.abs(toDeg(model.angles.lift) - lo) < 1e-9);
});

test('робот: прямая кинематика даёт вытянутую цепь в нулевой позе', () => {
  const model = new RobotModel();
  model.setAngles({ base: 0, lift: 0, wristRoll: 0 });
  const { tcp, links } = model.forward();
  const total = model.joints.reduce((s, j) => s + j.length, 0);
  assert.ok(Math.abs(tcp.y - total) < 1e-9);
  assert.equal(links.length, model.joints.length);
});

test('робот: неизвестное имя стратегии не роняет конвейер, а падает в дефолтную', () => {
  // Имя стратегии приезжает из localStorage, то есть из внешнего мира. Версия оттуда
  // может быть старой ('reach', 'chain'), и поток пакетов из-за этого встать не должен.
  const model = new RobotModel();
  const qb = androidQuatToBabylon(fromAxisAngle(AX_Z, toRad(30)));
  const angles = mapArmToRobot('такой-стратегии-нет', qb, model, {});
  for (const j of model.joints) assert.ok(Number.isFinite(angles[j.name]), j.name);
  assert.ok(Math.abs(angles.base) > 1e-3, 'основание должно поворачиваться вслед за курсом');
});

test('сглаживание тянется к цели и не выходит за пределы', () => {
  const sm = new QuatSmoother(0.1);
  const target = fromAxisAngle(AX_X, toRad(90));
  sm.push(quat(), 0);
  let last = 0;
  for (let i = 1; i <= 20; i += 1) {
    const v = sm.push(target, i * 0.02);
    const a = toDeg(angleBetween(quat(), v));
    assert.ok(a >= last - 1e-9 && a <= 90 + 1e-6, `угол ${a}`);
    last = a;
  }
  assert.ok(last > 45, `за 0.4 c должно дотянуть больше половины, а дотянуло ${last}`);
});
