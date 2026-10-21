/**
 * Робот: развязка трёх осей, использование хода и ограничитель приводов.
 *
 * Главный тест здесь — «каждая ось слушает только свою величину». Он воспроизводит
 * ровно те жалобы, с которых всё началось: «кручу кисть — едет основание» и
 * «поворачиваю руку — крутится голова». Чтобы тест не выродился в тавтологию
 * («код делает то, что делает»), рядом стоит НЕГАТИВНЫЙ КОНТРОЛЬ: то же движение
 * прогоняется через наивное отображение через углы Эйлера — самое естественное,
 * что напишет человек, не разбиравшийся с системами координат, — и там протечка
 * видна невооружённым глазом.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RobotModel } from '../src/core/robot/RobotModel.js';
import { mapArmToRobot, heldAzimuth } from '../src/core/robot/armToRobot.js';
import { JointLimiter, DEFAULT_JOINT_LIMITS } from '../src/core/robot/JointLimiter.js';
import { androidQuatToBabylon, androidOrientationToQuat } from '../src/core/math/frames.js';
import { eulerYXZ } from '../src/core/math/euler.js';
import { swingTwist } from '../src/core/math/swingTwist.js';
import { multiply, fromAxisAngle, toRad, toDeg } from '../src/core/math/quat.js';

const AX_X = { x: 1, y: 0, z: 0 };
const AX_Y = { x: 0, y: 1, z: 0 };
const AX_Z = { x: 0, y: 0, z: 1 };

const TWISTS = [-135, -90, -45, 45, 90, 135];

/** Ориентация часов: предплечье смотрит в (азимут, возвышение), кисть скручена. */
function watchAt(azimuthDeg, elevationDeg, twistDeg = 0) {
  return androidOrientationToQuat({
    azimuth: toRad(azimuthDeg),
    pitch: -toRad(elevationDeg), // pitch у getOrientation() — минус возвышение оси
    roll: toRad(twistDeg),
  });
}

/** Прогон одного кватерниона через стратегию. Модель передаём, чтобы жило удержание. */
function angles(model, qAndroid, options = {}) {
  const qb = androidQuatToBabylon(qAndroid);
  return mapArmToRobot('direct', qb, model, { watchQuatAndroid: qAndroid, ...options });
}

/**
 * НЕГАТИВНЫЙ КОНТРОЛЬ — наивное отображение «в лоб» через углы Эйлера сцены.
 *
 * Именно так выглядела удалённая стратегия 'orientation', и именно так напишет любой,
 * кто возьмёт кватернион сцены и разложит его на рыскание/тангаж/крен. Углы Эйлера
 * раскладывают поворот по ТРЁМ МИРОВЫМ осям, поэтому поворот вокруг собственной оси
 * предплечья в них не локализуется и растекается по всем трём. Тесты ниже требуют,
 * чтобы на тех же движениях этот вариант ломался: если он вдруг перестанет ломаться,
 * значит сломался сам тест, а не появилась «ещё одна правильная реализация».
 */
function naiveEuler(qAndroid) {
  const { yaw, pitch, roll } = eulerYXZ(androidQuatToBabylon(qAndroid));
  return { base: yaw, lift: pitch, wristRoll: roll };
}

/**
 * Второй НЕГАТИВНЫЙ КОНТРОЛЬ — swing-twist по оси предплечья, но на кватернионе СЦЕНЫ.
 *
 * Ровно это и стояло в коде до правки. Выглядит безупречно (разложение по оси звена,
 * а не по мировым осям), но берётся после перестановки мировых Y↔Z, из-за которой
 * «ось предплечья» (0,1,0) численно совпала с мировой вертикалью сцены. В итоге
 * поворот всей руки вокруг вертикали засчитывался как скрутка кисти один к одному.
 */
function naiveTwistInScene(qAndroid) {
  return swingTwist(androidQuatToBabylon(qAndroid), AX_Y).angle;
}

// ─────────────────────── развязка осей (регрессия на баг) ───────────────────────

test('развязка: скрутка кисти двигает только голову — и ничего больше', () => {
  for (const el of [-60, -30, 0, 30]) {
    const model = new RobotModel();
    const ref = angles(model, watchAt(0, el));
    const naiveRef = naiveEuler(watchAt(0, el));
    let naiveLeak = 0;

    for (const phi of TWISTS) {
      const a = angles(model, watchAt(0, el, phi));
      assert.ok(
        Math.abs(toDeg(a.base - ref.base)) < 1e-9,
        `возвышение ${el}°: скрутка ${phi}° увела основание на ${toDeg(a.base - ref.base)}°`,
      );
      assert.ok(
        Math.abs(toDeg(a.lift - ref.lift)) < 1e-9,
        `возвышение ${el}°: скрутка ${phi}° увела наклон на ${toDeg(a.lift - ref.lift)}°`,
      );
      // А голова обязана отработать ровно на угол скрутки. Знак минус — переход из
      // правой тройки Android в левую тройку сцены, см. twistToWristRoll().
      const got = toDeg(a.wristRoll - ref.wristRoll);
      assert.ok(Math.abs(got + phi) < 1e-9, `голова проехала ${got}° вместо ${-phi}°`);

      const n = naiveEuler(watchAt(0, el, phi));
      naiveLeak = Math.max(naiveLeak, Math.abs(toDeg(n.lift - naiveRef.lift)));
    }

    // Негативный контроль: наивное отображение на этих же движениях течёт.
    assert.ok(
      naiveLeak > 5,
      `на возвышении ${el}° наивный вариант протёк всего на ${naiveLeak.toFixed(1)}° — ` +
        'тест выше перестал что-либо доказывать',
    );
  }
});

test('развязка: поворот руки вокруг вертикали двигает только основание', () => {
  for (const el of [-80, -40, 0, 40]) {
    const model = new RobotModel();
    const base = watchAt(0, el, 25);
    const ref = angles(model, base);
    const naiveRef = naiveTwistInScene(base);
    let naiveLeak = 0;

    for (const yaw of [-120, -60, 60, 120]) {
      // Поворот ВСЕЙ руки вокруг мировой вертикали ENU (+Z) — умножение слева.
      const turned = multiply(fromAxisAngle(AX_Z, toRad(yaw)), base);
      const a = angles(model, turned);
      assert.ok(
        Math.abs(toDeg(a.wristRoll - ref.wristRoll)) < 1e-9,
        `возвышение ${el}°: поворот руки на ${yaw}° провернул голову на ` +
          `${toDeg(a.wristRoll - ref.wristRoll)}°`,
      );
      assert.ok(
        Math.abs(toDeg(a.lift - ref.lift)) < 1e-9,
        `возвышение ${el}°: поворот руки на ${yaw}° тронул наклон`,
      );

      naiveLeak = Math.max(naiveLeak, Math.abs(toDeg(naiveTwistInScene(turned) - naiveRef)));
    }

    // Негативный контроль здесь ДРУГОЙ, и это не лень: углы Эйлера раскладывают поворот
    // как Y·X·Z, поэтому рыскание вокруг мирового +Y попадает ровно в член yaw и в крен
    // не течёт — на этом движении наивный Эйлер случайно прав. А вот наивный swing-twist
    // на кватернионе СЦЕНЫ (то, что было в коде до правки) на нём разваливается
    // полностью, и именно он давал жалобу «поворачиваю руку — крутится голова».
    assert.ok(naiveLeak > 5, `негативный контроль не сработал: протечка ${naiveLeak.toFixed(1)}°`);
  }
});

test('развязка: поднятие и опускание руки двигает только наклон', () => {
  const model = new RobotModel();
  // Углы модели скармливаем обратно, как это делает render loop: удержание азимута
  // смотрит на текущий угол основания, и без обратной связи тест мерил бы не то.
  const ref = angles(model, watchAt(30, 0, 25));
  model.setAngles(ref);
  for (const el of [-80, -40, 20, 45]) {
    const a = angles(model, watchAt(30, el, 25));
    assert.ok(
      Math.abs(toDeg(a.base - ref.base)) < 1e-9,
      `возвышение ${el}° увело основание на ${toDeg(a.base - ref.base)}°`,
    );
    assert.ok(Math.abs(toDeg(a.wristRoll - ref.wristRoll)) < 1e-9, `возвышение ${el}° тронуло голову`);
    model.setAngles(a);
  }
});

// ─────────────── чувствительность основания к паразитному уводу оси ───────────────

test('основание: паразитный увод оси на 5° не усиливается сверх геометрического предела', () => {
  // Полностью убрать движение основания отсюда нельзя и не нужно: основание — это
  // азимут направления, а у направления, наклонённого на δ, азимут по чистой геометрии
  // меняется на величину до δ/cos(возвышение) — горизонтальная окружность на возвышении
  // имеет радиус cos. Запрещаем мы не это, а УСИЛЕНИЕ: всё сверх геометрического
  // предела робот добавил от себя. Допуск 5% + 0.5° — на нелинейность (увод сам меняет
  // возвышение) и на округление.
  const wander = 5;
  for (const el of [-60, -30, 0, 30]) {
    const model = new RobotModel();
    const ref = angles(model, watchAt(0, el));
    const bound = (wander / Math.cos(toRad(el))) * 1.05 + 0.5;
    for (const phi of TWISTS) {
      const qa = multiply(
        multiply(watchAt(0, el), fromAxisAngle(AX_Y, toRad(phi))),
        fromAxisAngle(AX_X, toRad(wander)),
      );
      const moved = Math.abs(toDeg(angles(model, qa).base - ref.base));
      assert.ok(
        moved <= bound,
        `возвышение ${el}°: увод оси ${wander}° раскрутил основание на ${moved.toFixed(1)}° ` +
          `при геометрическом пределе ${bound.toFixed(1)}°`,
      );
    }
  }
});

test('основание: у вертикального предплечья азимут удерживается, а не швыряет ось', () => {
  const model = new RobotModel();
  model.setAngles({ base: 0 });
  // Рука висит почти вертикально: азимут тут вырожден и прыгает на десятки градусов
  // от миллиметрового дрожания. Основание обязано реагировать вяло.
  const steep = Math.abs(toDeg(angles(model, watchAt(60, -87)).base));
  const flat = Math.abs(toDeg(angles(model, watchAt(60, -10)).base));
  assert.ok(steep < flat * 0.5, `у вертикали основание проехало ${steep}°, у горизонтали ${flat}°`);
  assert.ok(steep > 0.5, 'основание примёрзло совсем — это уже не удержание, а отказ');
});

test('удержание азимута: непрерывно по проекции и идёт кратчайшим путём через ±180°', () => {
  // Скачка при пересечении порога быть не должно: коэффициент непрерывен по проекции.
  const near = heldAzimuth(toRad(90), 0.0999, 0.1, 0);
  const at = heldAzimuth(toRad(90), 0.1, 0.1, 0);
  assert.ok(Math.abs(toDeg(near - at)) < 0.2, `на пороге скачок ${toDeg(near - at)}°`);
  // В самом вырождении держим предыдущий угол.
  assert.equal(heldAzimuth(toRad(90), 0, 0.1, toRad(33)), toRad(33));
  // Через разрыв ±180° едем коротким путём (на 20°), а не длинным (на 340°).
  const wrapped = heldAzimuth(toRad(-170), 1, 0.1, toRad(170));
  assert.ok(Math.abs(toDeg(wrapped) - 190) < 1e-9, `поехали длинной дорогой: ${toDeg(wrapped)}°`);
});

// ─────────────────────────── использование хода моторов ───────────────────────────

/** Полный размах руки: сколько хода реально использует каждая ось, %. */
function travelUsage() {
  const model = new RobotModel();
  const span = {};
  for (const j of model.joints) span[j.name] = { min: Infinity, max: -Infinity };

  const elevations = [];
  // До −89°, а не до −90°: строго вертикальное предплечье — гимбал-лок, азимут там
  // не определён. Точка меры нуль, руку так не держат.
  for (let el = -89; el < 45; el += 5) elevations.push(el);
  elevations.push(45);

  for (let az = -90; az <= 90; az += 5) {
    for (const el of elevations) {
      for (let tw = -180; tw <= 180; tw += 30) {
        // Считаем по УЖЕ ОБРЕЗАННЫМ углам: то, что мотор физически не проедет,
        // ходом называть нельзя.
        const a = model.setAngles(angles(model, watchAt(az, el, tw)));
        for (const j of model.joints) {
          span[j.name].min = Math.min(span[j.name].min, a[j.name]);
          span[j.name].max = Math.max(span[j.name].max, a[j.name]);
        }
      }
    }
  }

  const out = {};
  for (const j of model.joints) {
    out[j.name] = (toDeg(span[j.name].max - span[j.name].min) / (j.limits[1] - j.limits[0])) * 100;
  }
  return out;
}

test('ход моторов: на полном размахе руки живёт каждая из трёх осей', () => {
  const usage = travelUsage();
  // Наклон: до перехода на три оси эта ось (тогда «плечо») проходила 24° из 200 — 12%,
  // и ни разу не уходила в плюс, потому что всё вертикальное движение съедал локоть.
  assert.ok(usage.lift >= 50, `наклон использует ${usage.lift.toFixed(0)}% хода`);
  // Основание: азимут отображается один к одному, поэтому на размахе ±90° выходит
  // ровно половина хода ±180°. Полный оборот руки дал бы все 100%.
  assert.ok(usage.base >= 49, `основание использует ${usage.base.toFixed(0)}% хода`);
  // Голова: скрутка тоже один к одному, ±180 на ±180.
  assert.ok(usage.wristRoll >= 99, `голова использует ${usage.wristRoll.toFixed(0)}% хода`);
});

test('отображение монотонно: подняли руку — стрела выпрямилась, повернули — основание за ней', () => {
  const model = new RobotModel();
  let prevLift = Infinity;
  for (const el of [-80, -40, 0, 20, 45]) {
    const lift = angles(model, watchAt(0, el)).lift;
    assert.ok(lift < prevLift, `наклон не уменьшился на возвышении ${el}°: ${toDeg(lift)}°`);
    prevLift = lift;
  }
  // Азимут — один к одному, без всяких коэффициентов.
  for (const az of [-120, -45, 0, 45, 120]) {
    const base = angles(model, watchAt(az, 0)).base;
    assert.ok(Math.abs(toDeg(base) - az) < 1e-9, `основание ${toDeg(base)}° вместо ${az}°`);
  }
});

test('коэффициенты передачи и рабочее окно наклона настраиваются', () => {
  const model = new RobotModel();
  // Окно наклона — это ОГРАНИЧЕНИЕ, а не растяжение: внутри него отображение остаётся
  // тождественным (наклон = 90° − возвышение), на краю стрела просто упирается.
  // Раньше здесь стояло растяжение диапазона, и возвышение 45° при окне ±90° давало
  // наклон −90°, то есть стрелу, заваленную назад за мачту. Это и был баг
  // «рука вперёд — робот смотрит вверх»; физическую сторону пинит tests/boomAim.test.js.
  const narrow = angles(model, watchAt(0, 45), { direct: { liftTopDeg: 60, liftBottomDeg: 120 } });
  assert.ok(Math.abs(toDeg(narrow.lift) - 60) < 1e-9, `наклон ${toDeg(narrow.lift)}° вместо 60°`);
  const inside = angles(model, watchAt(0, 10), { direct: { liftTopDeg: 60, liftBottomDeg: 120 } });
  assert.ok(Math.abs(toDeg(inside.lift) - 80) < 1e-9, `наклон ${toDeg(inside.lift)}° вместо 80°`);
  const half = angles(model, watchAt(40, 0), { gain: { base: 0.5 } });
  assert.ok(Math.abs(toDeg(half.base) - 20) < 1e-9, `коэффициент не применился: ${toDeg(half.base)}°`);
});

// ─────────────────────────── прямая кинематика ───────────────────────────

test('кинематика: голова крутится вокруг собственной оси и не двигает TCP', () => {
  const model = new RobotModel();
  model.setAngles({ base: toRad(30), lift: toRad(55) });
  const a = model.forward().tcp;
  model.setAngles({ wristRoll: toRad(137) });
  const b = model.forward().tcp;
  assert.ok(
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-12,
    'поворот вокруг собственной оси звена не должен двигать TCP',
  );
});

test('кинематика: наклон 90° кладёт стрелу горизонтально, а основание крутит её по азимуту', () => {
  const model = new RobotModel();
  const L1 = model.linkLength('base');
  const reach = model.linkLength('lift') + model.linkLength('wristRoll');

  model.setAngles({ base: 0, lift: toRad(90), wristRoll: 0 });
  let tcp = model.forward().tcp;
  // Стрела легла горизонтально вперёд: высота осталась на оси наклона, вылет полный.
  assert.ok(Math.abs(tcp.y - L1) < 1e-12, `высота ${tcp.y} вместо ${L1}`);
  assert.ok(Math.abs(tcp.z - reach) < 1e-12, `вылет ${tcp.z} вместо ${reach}`);
  assert.ok(Math.abs(tcp.x) < 1e-12);

  // Основание повернуло на 90° — вылет ушёл из +Z в +X (азимут считается от +Z к +X).
  model.setAngles({ base: toRad(90) });
  tcp = model.forward().tcp;
  assert.ok(Math.abs(tcp.x - reach) < 1e-12, `вылет по X ${tcp.x} вместо ${reach}`);
  assert.ok(Math.abs(tcp.z) < 1e-12);

  // Наклон 0 — стрела строго вверх.
  model.setAngles({ base: 0, lift: 0 });
  tcp = model.forward().tcp;
  assert.ok(Math.abs(tcp.y - (L1 + reach)) < 1e-12);
});

// ─────────────────────────── ограничитель приводов ───────────────────────────

test('ограничитель: не превышает скорость, разгоняется не быстрее ускорения, доходит до цели', () => {
  const model = new RobotModel();
  const limiter = new JointLimiter(model, DEFAULT_JOINT_LIMITS);
  limiter.sync({ base: 0, lift: 0, wristRoll: 0 });

  // Цель внутри механических лимитов: наклон ходит от 0° (стрела вверх) до 180°
  // (стрела вниз), и цель за упором проверяется отдельным тестом ниже.
  const target = { base: toRad(150), lift: toRad(160), wristRoll: toRad(-170) };
  const dt = 1 / 60;
  let prevPos = { ...limiter.angles };
  let prevVel = { ...limiter.velocities };

  for (let i = 0; i < 600; i += 1) {
    limiter.step(target, dt);
    for (const j of model.joints) {
      const lim = limiter.limits[j.name];
      const v = (limiter.angles[j.name] - prevPos[j.name]) / dt;
      assert.ok(
        Math.abs(v) <= lim.maxSpeed + 1e-9,
        `${j.name}: скорость ${toDeg(v)}°/с > ${toDeg(lim.maxSpeed)}°/с`,
      );
      // Ускорение ограничиваем только на РАЗГОНЕ: тормозить резче мотор всегда может
      // (в пределе — упереться), а разогнаться сверх момента — нет. См. JointLimiter.
      const now = limiter.velocities[j.name];
      const was = prevVel[j.name];
      if (Math.abs(now) > Math.abs(was)) {
        assert.ok(
          Math.abs(now - was) <= lim.maxAccel * dt + 1e-9,
          `${j.name}: разгон ${toDeg((now - was) / dt)}°/с² > ${toDeg(lim.maxAccel)}°/с²`,
        );
      }
      // И ни в какой момент не выходим за механические лимиты угла.
      const [lo, hi] = model.limitsRad(j.name);
      assert.ok(limiter.angles[j.name] >= lo - 1e-12 && limiter.angles[j.name] <= hi + 1e-12);
    }
    prevPos = { ...limiter.angles };
    prevVel = { ...limiter.velocities };
  }

  for (const j of model.joints) {
    assert.ok(
      Math.abs(limiter.angles[j.name] - target[j.name]) < 1e-9,
      `${j.name} не сошёлся: ${toDeg(limiter.angles[j.name])}° вместо ${toDeg(target[j.name])}°`,
    );
    assert.equal(limiter.velocities[j.name], 0, `${j.name} остановился не до конца`);
  }
});

test('ограничитель: робот заметно отстаёт от резкого движения', () => {
  const model = new RobotModel();
  const limiter = new JointLimiter(model, DEFAULT_JOINT_LIMITS);
  limiter.sync({ base: 0, lift: 0, wristRoll: 0 });
  const target = { base: toRad(150) };
  // База: 120 °/с и 400 °/с². За 0.1 с физически не проехать больше ~12°.
  for (let i = 0; i < 6; i += 1) limiter.step(target, 1 / 60);
  const moved = toDeg(limiter.angles.base);
  assert.ok(moved > 0.5, `привод вообще не тронулся: ${moved}°`);
  assert.ok(moved < 13, `за 0.1 с проехал ${moved}° — ограничение не работает`);
});

test('ограничитель: цель за механическим лимитом упирается в лимит, а не звенит', () => {
  const model = new RobotModel();
  const limiter = new JointLimiter(model);
  limiter.sync({ base: 0, lift: 0, wristRoll: 0 });
  const liftMax = model.jointByName('lift').limits[1];
  for (let i = 0; i < 600; i += 1) limiter.step({ lift: toRad(liftMax + 300) }, 1 / 60);
  assert.ok(Math.abs(toDeg(limiter.angles.lift) - liftMax) < 1e-9);
  assert.equal(limiter.velocities.lift, 0);
});

test('ограничитель: нулевой и гигантский dt не ломают состояние', () => {
  const model = new RobotModel();
  const limiter = new JointLimiter(model);
  limiter.sync({ base: 0, lift: 0, wristRoll: 0 });
  limiter.step({ base: toRad(90) }, 0);
  assert.equal(limiter.angles.base, 0);
  limiter.step({ base: toRad(90) }, 1e6);
  for (const j of model.joints) assert.ok(Number.isFinite(limiter.angles[j.name]));
  // Кадр длиной в миллион секунд режется MAX_DT — телепорта нет.
  assert.ok(toDeg(limiter.angles.base) < 90);
});
