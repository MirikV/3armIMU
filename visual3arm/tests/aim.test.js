/**
 * Прицел предплечья: азимут, возвышение, скрутка.
 *
 * Главный тест здесь — «поворот всей руки вокруг вертикали не трогает скрутку кисти».
 * Он воспроизводит дефект, из-за которого управление ощущалось перепутанным: скрутка
 * считалась на кватернионе СЦЕНЫ, где перестановка мировых осей Y↔Z превращает ось
 * предплечья (0,1,0) в мировую вертикаль, и поворот корпуса на 90° засчитывался как
 * 90° скрутки кисти. Ниже это показано отдельным тестом — чтобы было видно, что дело
 * не в тесте, а в системе координат.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { forearmAim, forearmAimFromBabylon } from '../src/core/math/aim.js';
import { androidQuatToBabylon, babylonQuatToAndroid, androidOrientationToQuat } from '../src/core/math/frames.js';
import { swingTwist } from '../src/core/math/swingTwist.js';
import { quat, multiply, normalize, fromAxisAngle, angleBetween, toRad, toDeg } from '../src/core/math/quat.js';

const AX_X = { x: 1, y: 0, z: 0 };
const AX_Y = { x: 0, y: 1, z: 0 };
const AX_Z = { x: 0, y: 0, z: 1 };

/** Ориентация часов: предплечье смотрит в (азимут, возвышение), кисть скручена на twist. */
function watchQuat(azimuthDeg, elevationDeg, twistDeg = 0) {
  // pitch у getOrientation() — минус возвышение оси устройства, roll — скрутка вокруг неё.
  return androidOrientationToQuat({
    azimuth: toRad(azimuthDeg),
    pitch: -toRad(elevationDeg),
    roll: toRad(twistDeg),
  });
}

test('frames: перевод в сцену и обратно — точное обращение', () => {
  const cases = [
    quat(),
    multiply(fromAxisAngle(AX_Z, toRad(41)), fromAxisAngle(AX_X, toRad(-27))),
    normalize(quat(0.21, -0.45, 0.33, 0.8)),
    watchQuat(-130, 62, 17),
  ];
  for (const q of cases) {
    // 1e-7, а не 1e-12: angleBetween = 2·acos(|dot|), и у acos возле единицы
    // производная бесконечна — метрика сама по себе не точнее ~1e-8.
    assert.ok(angleBetween(babylonQuatToAndroid(androidQuatToBabylon(q)), q) < 1e-7);
  }
});

test('прицел: азимут, возвышение и скрутка читаются такими, какими их задали', () => {
  for (const az of [-150, -40, 0, 75]) {
    for (const el of [-70, -20, 0, 35]) {
      for (const tw of [-120, 0, 55]) {
        const aim = forearmAim(watchQuat(az, el, tw));
        assert.ok(Math.abs(toDeg(aim.azimuth) - az) < 1e-9, `азимут ${toDeg(aim.azimuth)} вместо ${az}`);
        assert.ok(Math.abs(toDeg(aim.elevation) - el) < 1e-9, `возвышение ${toDeg(aim.elevation)} вместо ${el}`);
        assert.ok(Math.abs(toDeg(aim.twist) - tw) < 1e-9, `скрутка ${toDeg(aim.twist)} вместо ${tw}`);
      }
    }
  }
});

test('ДЕФЕКТ 1: поворот всей руки вокруг вертикали не меняет скрутку ни на градус', () => {
  // Возвышение до −89°: строго вертикальное предплечье — гимбал-лок, там азимут
  // не определён и физически неотличим от скрутки (та же дыра, что у getOrientation()).
  for (const el of [-89, -80, -60, -30, 0, 30, 60]) {
    const base = watchQuat(0, el, 33);
    const twist0 = forearmAim(base).twist;
    for (const yaw of [-170, -90, -25, 25, 90, 170]) {
      // Поворот ВСЕЙ руки вокруг мировой вертикали ENU (+Z) — умножение СЛЕВА.
      const turned = multiply(fromAxisAngle(AX_Z, toRad(yaw)), base);
      const aim = forearmAim(turned);
      assert.ok(
        Math.abs(toDeg(aim.twist - twist0)) < 1e-9,
        `возвышение ${el}°, поворот ${yaw}°: скрутка уехала на ${toDeg(aim.twist - twist0)}°`,
      );
      // Возвышение при этом обязано сохраниться, а азимут — сдвинуться ровно на поворот
      // (со знаком минус: азимут компасный, по часовой, а поворот вокруг +Z — против).
      assert.ok(Math.abs(toDeg(aim.elevation) - el) < 1e-9);
      const d = wrapPi(aim.azimuth + toRad(yaw));
      assert.ok(Math.abs(toDeg(d)) < 1e-9, `азимут сдвинулся на ${toDeg(aim.azimuth)}° вместо ${-yaw}°`);
    }
  }
});

test('ДЕФЕКТ 1: наивный swing-twist на кватернионе СЦЕНЫ ломается — вот доказательство', () => {
  // Документируем причину, а не только её отсутствие. Если этот тест однажды позеленеет
  // «сам собой», значит кто-то поменял P или Q в frames.js — и чинить надо не тут.
  const base = watchQuat(0, 0, 0);
  const turned = multiply(fromAxisAngle(AX_Z, toRad(90)), base); // рука повернулась на 90°
  const naive = swingTwist(androidQuatToBabylon(turned), AX_Y).angle;
  assert.ok(
    Math.abs(toDeg(naive)) > 85,
    `ожидалась почти полная протечка поворота в «скрутку», получено ${toDeg(naive)}°`,
  );
  // А правильный расчёт на том же движении даёт ноль.
  assert.ok(Math.abs(toDeg(forearmAimFromBabylon(androidQuatToBabylon(turned)).twist)) < 1e-9);
});

test('прицел: скрутка кисти не трогает ни азимут, ни возвышение', () => {
  const base = watchQuat(-37, -25, 0);
  const ref = forearmAim(base);
  for (const phi of [-170, -90, -33, 17, 75, 160]) {
    // Скрутка вокруг СОБСТВЕННОЙ оси предплечья (+Y устройства) — умножение справа.
    const aim = forearmAim(multiply(base, fromAxisAngle(AX_Y, toRad(phi))));
    assert.ok(Math.abs(toDeg(aim.azimuth - ref.azimuth)) < 1e-9, `азимут поехал при скрутке ${phi}°`);
    assert.ok(Math.abs(toDeg(aim.elevation - ref.elevation)) < 1e-9, `возвышение поехало при скрутке ${phi}°`);
    assert.ok(Math.abs(toDeg(wrapPi(aim.twist - ref.twist - toRad(phi)))) < 1e-9);
  }
});

test('прицел: у вертикального предплечья честно сообщается о вырождении азимута', () => {
  const down = forearmAim(watchQuat(0, -90, 0));
  assert.ok(down.horizontal < 1e-9, `horizontal = ${down.horizontal}, ожидался ~0`);
  const side = forearmAim(watchQuat(0, 0, 0));
  assert.ok(Math.abs(side.horizontal - 1) < 1e-9);
});

function wrapPi(a) {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}
