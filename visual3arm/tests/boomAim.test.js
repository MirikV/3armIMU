/**
 * Направление стрелы против направления предплечья.
 *
 * Это регрессия на жалобу «рука вперёд — а робот смотрит вверх». Проверяется не
 * равенство чисел на выходе стратегии (число само по себе ничего не значит: «наклон
 * 23°» — это много или мало?), а ФИЗИЧЕСКОЕ направление стрелы, посчитанное прямой
 * кинематикой RobotModel. Если завтра поменяется отсчёт угла наклона, знак оси или
 * длина мачты, тест продолжит спрашивать то же самое: куда в итоге показывает железка.
 *
 * До правки отображение растягивало «комфортный» ход руки на ход стрелы, и опорные
 * позы расходились: горизонтально вытянутая рука давала стрелу, задранную на 67° над
 * горизонтом, а возвышения +30° и +90° обе уводили стрелу назад за мачту.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RobotModel } from '../src/core/robot/RobotModel.js';
import { mapArmToRobot } from '../src/core/robot/armToRobot.js';
import { androidQuatToBabylon, androidOrientationToQuat } from '../src/core/math/frames.js';
import { toRad, toDeg } from '../src/core/math/quat.js';

/** Ориентация часов: предплечье смотрит в (азимут, возвышение), кисть скручена. */
function watchAt(azimuthDeg, elevationDeg, twistDeg = 0) {
  return androidOrientationToQuat({
    azimuth: toRad(azimuthDeg),
    pitch: -toRad(elevationDeg), // pitch у getOrientation() — минус возвышение оси
    roll: toRad(twistDeg),
  });
}

/**
 * Куда физически показывает стрела, градусы.
 *
 * Берём прямую кинематику и меряем направление от шарнира наклона (вершина мачты,
 * она же единственная точка цепи, которую поворот основания не двигает) к TCP.
 * Возвышение — над горизонтом сцены, азимут — от +Z к +X, как и у основания.
 */
function boomAimDeg(model) {
  const pivotY = model.linkLength('base');
  const tcp = model.forward().tcp;
  const d = { x: tcp.x, y: tcp.y - pivotY, z: tcp.z };
  const horiz = Math.hypot(d.x, d.z);
  return {
    elevation: toDeg(Math.atan2(d.y, horiz)),
    azimuth: toDeg(Math.atan2(d.x, d.z)),
  };
}

/** Прогон позы руки через стратегию и лимиты — то же, что делает render loop. */
function aimRobotAt(model, azimuthDeg, elevationDeg, twistDeg = 0, options = {}) {
  const qa = watchAt(azimuthDeg, elevationDeg, twistDeg);
  const target = mapArmToRobot('direct', androidQuatToBabylon(qa), model, {
    watchQuatAndroid: qa,
    ...options,
  });
  model.setAngles(target);
  return boomAimDeg(model);
}

// ───────────────────────────── опорные позы ─────────────────────────────

test('стрела: три опорные позы совпадают с рукой — вперёд, вверх, вниз', () => {
  const model = new RobotModel();

  const forward = aimRobotAt(model, 0, 0);
  assert.ok(
    Math.abs(forward.elevation) < 1e-9,
    `рука горизонтально вперёд, а стрела задрана на ${forward.elevation.toFixed(1)}°`,
  );
  assert.ok(Math.abs(forward.azimuth) < 1e-9, `стрела ушла по азимуту на ${forward.azimuth}°`);

  const up = aimRobotAt(model, 0, 90);
  assert.ok(
    Math.abs(up.elevation - 90) < 1e-9,
    `рука вертикально вверх, а стрела на ${up.elevation.toFixed(1)}°`,
  );

  const down = aimRobotAt(model, 0, -90);
  assert.ok(
    Math.abs(down.elevation + 90) < 1e-9,
    `рука опущена вниз, а стрела на ${down.elevation.toFixed(1)}°`,
  );
});

// ───────────────────────── весь диапазон, а не одна точка ─────────────────────────

test('стрела: возвышение повторяется один в один на всём диапазоне', () => {
  const model = new RobotModel();
  for (let el = -90; el <= 90; el += 10) {
    const got = aimRobotAt(model, 0, el).elevation;
    assert.ok(
      Math.abs(got - el) < 1e-9,
      `возвышение руки ${el}° → стрела на ${got.toFixed(1)}° (расхождение ${(got - el).toFixed(1)}°)`,
    );
  }
});

test('стрела: то же самое на любом азимуте и при любой скрутке кисти', () => {
  const model = new RobotModel();
  // Азимут вне зоны удержания (|возвышение| < порога), иначе меряли бы удержание,
  // а не отображение: у почти вертикального предплечья азимут вырожден by design.
  for (const az of [-120, -45, 0, 60, 150]) {
    for (const el of [-70, -30, 0, 30, 70]) {
      for (const tw of [-90, 0, 120]) {
        const got = aimRobotAt(model, az, el, tw);
        assert.ok(
          Math.abs(got.elevation - el) < 1e-9,
          `азимут ${az}°, скрутка ${tw}°: возвышение стрелы ${got.elevation.toFixed(1)}° вместо ${el}°`,
        );
        assert.ok(
          Math.abs(got.azimuth - az) < 1e-9,
          `возвышение ${el}°: азимут стрелы ${got.azimuth.toFixed(1)}° вместо ${az}°`,
        );
      }
    }
  }
});

test('стрела: возвышение монотонно и без скачков по всему ходу руки', () => {
  const model = new RobotModel();
  let prev = -Infinity;
  let prevEl = null;
  for (let el = -90; el <= 90; el += 1) {
    const got = aimRobotAt(model, 0, el).elevation;
    assert.ok(got > prev - 1e-9, `на ${el}° стрела поехала вниз: ${got.toFixed(2)}° после ${prev.toFixed(2)}°`);
    if (prevEl !== null) {
      // Шаг руки 1° — стрела не имеет права прыгнуть заметно больше.
      assert.ok(
        Math.abs(got - prev) < 1.001,
        `скачок ${Math.abs(got - prev).toFixed(2)}° на переходе ${prevEl}° → ${el}°`,
      );
    }
    prev = got;
    prevEl = el;
  }
});

// ───────────────────── корректность при не-дефолтных настройках ─────────────────────

test('стрела: подрезанное окно наклона только упирает края, но не сдвигает отображение', () => {
  const model = new RobotModel();
  // Пользователь сузил ход стрелы до 30°…120° от вертикали, то есть до возвышений
  // от +60° до −30°. Внутри окна отображение обязано остаться точным.
  const direct = { liftTopDeg: 30, liftBottomDeg: 120 };
  for (const el of [-30, -10, 0, 25, 60]) {
    const got = aimRobotAt(model, 0, el, 0, { direct }).elevation;
    assert.ok(Math.abs(got - el) < 1e-9, `внутри окна расхождение: ${got.toFixed(1)}° вместо ${el}°`);
  }
  // За краем окна — упор, а не перекос: стрела встаёт на границе и дальше не идёт.
  assert.ok(Math.abs(aimRobotAt(model, 0, -80, 0, { direct }).elevation + 30) < 1e-9);
  assert.ok(Math.abs(aimRobotAt(model, 0, 85, 0, { direct }).elevation - 60) < 1e-9);
});

test('стрела: отрицательный коэффициент зеркалит наклон, но горизонт остаётся горизонтом', () => {
  const model = new RobotModel();
  const gain = { lift: -1 };
  // Коэффициент умножает ОТКЛОНЕНИЕ от горизонта: точка «рука вперёд» никуда не едет.
  assert.ok(Math.abs(aimRobotAt(model, 0, 0, 0, { gain }).elevation) < 1e-9);
  for (const el of [-60, -20, 20, 60]) {
    const got = aimRobotAt(model, 0, el, 0, { gain }).elevation;
    assert.ok(Math.abs(got + el) < 1e-9, `зеркало не сошлось: ${got.toFixed(1)}° вместо ${-el}°`);
  }
});

// ─────────── азимут не пострадал от правки наклона (регрессия на прошлый баг) ───────────

test('стрела: поворот руки вбок крутит только мачту и не трогает наклон', () => {
  const model = new RobotModel();
  const ref = aimRobotAt(model, 0, 20).elevation;
  for (const az of [-150, -60, 45, 135]) {
    const got = aimRobotAt(model, az, 20);
    assert.ok(
      Math.abs(got.elevation - ref) < 1e-9,
      `поворот на ${az}° увёл возвышение стрелы на ${(got.elevation - ref).toFixed(2)}°`,
    );
    assert.ok(Math.abs(got.azimuth - az) < 1e-9, `мачта встала на ${got.azimuth.toFixed(1)}° вместо ${az}°`);
  }
});

// ─────────────────────────── механика не спорит с полом ───────────────────────────

test('стрела: ни одна достижимая поза не уходит под пол', () => {
  const model = new RobotModel();
  // Робот стоит на полу сцены, начало цепи — на уровне пола (RobotRig, y = −0.9).
  // Значит ни одна точка цепи не имеет права уйти в минус по Y.
  for (let el = -90; el <= 90; el += 5) {
    aimRobotAt(model, 0, el);
    for (const link of model.forward().links) {
      assert.ok(
        link.end.y > -1e-9,
        `возвышение ${el}°: звено ${link.name} ушло под пол на ${(-link.end.y).toFixed(3)} м`,
      );
    }
  }
});
