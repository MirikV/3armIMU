/**
 * Системы координат и перевод между ними.
 *
 * ── Что реально отдаёт Android TYPE_ROTATION_VECTOR (Wear OS 4 / Galaxy Watch 6) ──
 * SensorEvent.values:
 *   values[0] = x * sin(θ/2)
 *   values[1] = y * sin(θ/2)
 *   values[2] = z * sin(θ/2)
 *   values[3] = cos(θ/2)          // есть с API 18; если приходит 3 числа — считаем сами
 *   values[4] = оценка точности курса, рад (опционально, только у ROTATION_VECTOR)
 * То есть это единичный кватернион (x, y, z, w) без нормировочных сюрпризов,
 * а не «вектор поворота» в смысле оси*угол. Отсюда правило: если пришло 3 числа,
 * w = sqrt(1 - (x²+y²+z²)) (с клампом, потому что float).
 *
 * Кватернион поворачивает вектор ИЗ системы устройства В мировую:
 *   v_world = q * v_device * q̄
 *
 * Система устройства (телефон/часы, экран к себе):
 *   +X — вправо, +Y — вверх (к верху экрана), +Z — из экрана на наблюдателя. Правая тройка.
 * Мировая система Android — ENU:
 *   +X — восток, +Y — север, +Z — вверх (от центра Земли). Правая тройка.
 *
 * ── Babylon ──
 * Babylon по умолчанию ЛЕВОсторонний, Y — вверх. Берём отображение осей:
 *   babylon.x = android.x (восток)
 *   babylon.y = android.z (вверх)
 *   babylon.z = android.y (север)
 * Перестановка Y↔Z имеет det = -1, ровно она и меняет хиральность — как раз то,
 * что нужно при переходе из правой тройки в левую.
 *
 * Меш часов в сцене авторится в «естественных» осях Babylon:
 *   локальный +X — вправо по корпусу, +Y — к «12 часам» циферблата,
 *   +Z — В экран (в левой тройке «из экрана» это -Z).
 * Отсюда локальная перестановка Q = diag(1, 1, -1).
 *
 * Итоговая матрица для Babylon:  R_b = P · R_android · Q
 * (det = (-1)·(+1)·(-1) = +1 — корректный поворот, зеркалить ничего не нужно).
 */

import {
  quat,
  normalize,
  multiply,
  invert,
  toMatrix3,
  fromMatrix3,
  fromAxisAngle,
  matMul,
} from './quat.js';

/** P: android(ENU) → babylon(Y-up, LH). row-major 3x3. */
const P = [
  1, 0, 0,
  0, 0, 1,
  0, 1, 0,
];

/** Орты для сборки поворотов из углов Эйлера. */
const AXIS_X = { x: 1, y: 0, z: 0 };
const AXIS_Y = { x: 0, y: 1, z: 0 };
const AXIS_Z = { x: 0, y: 0, z: 1 };

/** Q: локальные оси устройства → локальные оси меша. row-major 3x3. */
const Q = [
  1, 0, 0,
  0, 1, 0,
  0, 0, -1,
];

/**
 * Собрать кватернион из «сырого» массива rotation vector.
 * Принимает 3, 4 или 5 элементов. Возвращает нормированный { x, y, z, w }.
 */
export function rotationVectorToQuat(values) {
  if (!values || values.length < 3) {
    throw new Error(`rotationVectorToQuat: ожидалось >= 3 чисел, пришло ${values && values.length}`);
  }
  const x = Number(values[0]);
  const y = Number(values[1]);
  const z = Number(values[2]);
  let w;
  if (values.length >= 4 && Number.isFinite(Number(values[3]))) {
    w = Number(values[3]);
  } else {
    const t = 1 - (x * x + y * y + z * z);
    w = t > 0 ? Math.sqrt(t) : 0;
  }
  return normalize(quat(x, y, z, w));
}

/** Оценка точности курса (values[4]), рад, или null если её не прислали. */
export function rotationVectorAccuracy(values) {
  if (values && values.length >= 5 && Number.isFinite(Number(values[4]))) {
    return Number(values[4]);
  }
  return null;
}

/**
 * Кватернион Android (ENU, правая тройка) → кватернион Babylon (Y-up, левая тройка).
 * Результат можно скармливать в BABYLON.Quaternion как есть.
 */
export function androidQuatToBabylon(q) {
  const rb = matMul(matMul(P, toMatrix3(q)), Q);
  return fromMatrix3(rb);
}

/**
 * Обратное к androidQuatToBabylon(): кватернион сцены → кватернион Android (ENU).
 *
 * И P, и Q — инволюции (P·P = I, Q·Q = I), поэтому обращение записывается теми же
 * матрицами: из R_b = P·R_a·Q следует R_a = P⁻¹·R_b·Q⁻¹ = P·R_b·Q.
 *
 * Зачем это нужно. Часть величин имеет смысл ТОЛЬКО в правой тройке Android: скрутка
 * кисти вокруг оси предплечья, азимут и возвышение предплечья. В системе Babylon их
 * считать нельзя — перестановка P меняет местами мировые Y и Z, и «ось предплечья»
 * (0,1,0) превращается в мировую вертикаль, после чего поворот всей руки вокруг
 * вертикали неотличим от скрутки кисти. Поэтому такие величины считаются на
 * android-кватернионе, а в сцену переводится уже результат.
 */
export function babylonQuatToAndroid(q) {
  return fromMatrix3(matMul(matMul(P, toMatrix3(q)), Q));
}

/**
 * Углы ориентации в терминах Android SensorManager.getOrientation(), радианы.
 * azimuth: курс относительно севера, [-π, π]; pitch: наклон «от себя/на себя»;
 * roll: крен. Нужны только для читаемой телеметрии на панели — в сцену идёт кватернион.
 */
export function androidOrientationAngles(q) {
  const m = toMatrix3(q);
  const azimuth = Math.atan2(m[1], m[4]);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m[7])));
  const roll = Math.atan2(-m[6], m[8]);
  return { azimuth, pitch, roll };
}

/**
 * Обратное к androidOrientationAngles(): углы курса/тангажа/крена (радианы) → кватернион
 * устройство→мир (ENU). Нужно, когда часы шлют не rotation vector, а уже готовые
 * azimuth/pitch/roll (см. parsers.js).
 *
 * Разложение выводится из формул извлечения выше и равно R = Rz(-azimuth)·Rx(-pitch)·Ry(roll):
 * азимут компасный (по часовой от севера), поэтому вокруг мирового +Z он идёт с минусом;
 * тангаж — вокруг оси X устройства, крен — вокруг оси Y. Round-trip
 * androidOrientationAngles(androidOrientationToQuat(a)) === a внутри области определения
 * (|pitch| < π/2 — на «стойке на голове» крен с азимутом вырождаются, как и у Android).
 */
export function androidOrientationToQuat({ azimuth = 0, pitch = 0, roll = 0 } = {}) {
  return normalize(
    multiply(
      multiply(fromAxisAngle(AXIS_Z, -azimuth), fromAxisAngle(AXIS_X, -pitch)),
      fromAxisAngle(AXIS_Y, roll),
    ),
  );
}

/** Единичные орты устройства, выраженные в мире ENU (полезно для отладки). */
export function deviceAxesInWorld(q) {
  const m = toMatrix3(q);
  return {
    right: { x: m[0], y: m[3], z: m[6] },
    up: { x: m[1], y: m[4], z: m[7] },
    screen: { x: m[2], y: m[5], z: m[8] },
  };
}

/** Поворот вокруг мировой вертикали ENU (+Z) на заданный угол, правило правой руки. */
export function headingQuat(angleRad) {
  return fromAxisAngle({ x: 0, y: 0, z: 1 }, angleRad);
}

/**
 * Разложить поворот на «курс вокруг мирового верха» и остаток: q = yaw ⊗ tilt.
 * Нужно для обнуления только азимута (он плывёт вслед за магнитометром), не трогая наклон.
 *
 * Знак: азимут — компасный, считается ПО часовой от севера, а поворот вокруг +Z
 * по правилу правой руки идёт ПРОТИВ часовой, отсюда минус.
 */
export function splitHeading(q) {
  const { azimuth } = androidOrientationAngles(q);
  const yaw = headingQuat(-azimuth);
  return { yaw, tilt: multiply(invert(yaw), q), azimuth };
}

/** Внутренние матрицы — открыты для тестов. */
export const __frames = { P, Q };
