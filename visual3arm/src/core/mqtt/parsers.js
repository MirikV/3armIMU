/**
 * Разбор полезной нагрузки MQTT в единый сэмпл ориентации.
 *
 * Со стороны часов формат никем не стандартизован, поэтому парсер терпимый.
 * Понимает:
 *   [x, y, z]                         — rotation vector без w (w досчитаем)
 *   [x, y, z, w]
 *   [x, y, z, w, headingAccuracy]
 *   [t, x, y, z, w, headingAccuracy]  — 6 чисел: первое считаем меткой времени
 *   "x,y,z,w"                         — то же самое через запятую/пробел/;
 *   { x, y, z, w, accuracy?, timestamp? }
 *   { values: [...] } | { v: [...] } | { q: [...] } | { quaternion: [...] | {...} }
 *   { rotationVector: [...] } | { rotation_vector: [...] } | { data: <любое из выше> }
 *   { ts, azimuth, pitch, roll }      — готовые углы SensorManager.getOrientation()
 *
 * Метка времени нормализуется в секунды: Android отдаёт SensorEvent.timestamp
 * в наносекундах от загрузки, веб-обвязки часто шлют миллисекунды epoch.
 *
 * ── Про углы Эйлера ──
 * Часть прошивок шлёт не rotation vector, а уже посчитанные azimuth/pitch/roll.
 * Это лоссовое представление (на |pitch| = 90° курс с креном вырождаются) и оно
 * шумит сильнее кватерниона, так что если у прошивки есть выбор — лучше слать
 * кватернион. Но принять мы обязаны и такое.
 *
 * Единицы никак не помечены в самом пакете: Android отдаёт радианы, но почти все
 * обвязки переводят в градусы перед отправкой. Отсюда опция angleUnit:
 *   'deg' | 'rad' — как прислали, без гаданий (предпочтительно);
 *   'auto'        — градусы, если хоть один угол вылезает за радианный диапазон
 *                   (|azimuth| или |roll| > π, |pitch| > π/2), иначе радианы.
 * У 'auto' есть неустранимая дыра: часы почти в нуле (azimuth 2°, pitch 1°, roll 0°)
 * дают числа, неотличимые от радиан. Поэтому в UI единицы лучше задать явно.
 */

import {
  rotationVectorToQuat,
  rotationVectorAccuracy,
  androidOrientationToQuat,
} from '../math/frames.js';

const ARRAY_KEYS = [
  'values',
  'value',
  'v',
  'q',
  'quat',
  'quaternion',
  'rotationVector',
  'rotation_vector',
  'rv',
  'orientation',
  'data',
  'payload',
];

const TIME_KEYS = ['t', 'ts', 'time', 'timestamp', 'timeStamp', 'sensorTimestamp'];
const ACC_KEYS = ['accuracy', 'acc', 'headingAccuracy', 'heading_accuracy'];
/** Линейное ускорение (гравитация вычтена) — задел под расчёт координат. */
const LINEAR_ACCEL_KEYS = ['linearAccel', 'linear_accel', 'linearAcceleration', 'linear_acceleration', 'la'];

/** Синонимы углов Эйлера. Порядок внутри каждого списка — приоритет. */
const EULER_KEYS = {
  azimuth: ['azimuth', 'yaw', 'heading', 'az'],
  pitch: ['pitch', 'elevation'],
  roll: ['roll', 'bank'],
};

/** Наносекунды/миллисекунды/секунды → секунды. */
export function normalizeTimestamp(raw) {
  const t = Number(raw);
  if (!Number.isFinite(t) || t <= 0) return null;
  if (t > 1e15) return t / 1e9; // наносекунды (SensorEvent.timestamp)
  if (t > 1e11) return t / 1e3; // миллисекунды epoch
  return t; // уже секунды
}

function decodeText(payload) {
  if (typeof payload === 'string') return payload;
  if (payload instanceof Uint8Array || (typeof Buffer !== 'undefined' && payload instanceof Buffer)) {
    return new TextDecoder('utf-8').decode(payload);
  }
  if (payload && typeof payload.toString === 'function') return payload.toString();
  return String(payload);
}

function numbersFromText(text) {
  const parts = text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const nums = parts.map(Number);
  return nums.every(Number.isFinite) ? nums : null;
}

function pickByPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function findFirstKey(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

/**
 * Достать массив из 3..6 чисел откуда угодно внутри объекта.
 * Возвращает { nums, timestamp, accuracy } либо null.
 */
function extractFromObject(obj, depth = 0) {
  if (depth > 3 || obj == null) return null;

  if (Array.isArray(obj)) {
    const nums = obj.map(Number);
    return nums.every(Number.isFinite) ? { nums } : null;
  }
  if (typeof obj === 'string') {
    const nums = numbersFromText(obj);
    return nums ? { nums } : null;
  }
  if (typeof obj !== 'object') return null;

  const timestamp = normalizeTimestamp(findFirstKey(obj, TIME_KEYS));
  const accRaw = findFirstKey(obj, ACC_KEYS);
  const accuracy = Number.isFinite(Number(accRaw)) ? Number(accRaw) : null;
  const linearAccel = toVec3(findFirstKey(obj, LINEAR_ACCEL_KEYS));

  // Плоский объект с компонентами. Кватернион точнее углов, поэтому проверяем первым.
  if (Number.isFinite(Number(obj.x)) && Number.isFinite(Number(obj.y)) && Number.isFinite(Number(obj.z))) {
    const nums = [Number(obj.x), Number(obj.y), Number(obj.z)];
    if (Number.isFinite(Number(obj.w))) nums.push(Number(obj.w));
    return { nums, timestamp, accuracy, linearAccel };
  }

  const euler = toEuler(obj);
  if (euler) return { euler, timestamp, accuracy, linearAccel };

  const nested = findFirstKey(obj, ARRAY_KEYS);
  if (nested !== undefined) {
    const inner = extractFromObject(nested, depth + 1);
    if (inner) {
      return {
        nums: inner.nums,
        euler: inner.euler,
        timestamp: inner.timestamp ?? timestamp,
        accuracy: inner.accuracy ?? accuracy,
        linearAccel: inner.linearAccel ?? linearAccel,
      };
    }
  }
  return null;
}

/**
 * Объект с азимутом/тангажом/креном → { azimuth, pitch, roll } в ИСХОДНЫХ единицах.
 * Требует все три угла: два из трёх — это не ориентация, а обрезанный пакет,
 * и молча подставлять ноль вместо недостающего значит врать сцене.
 */
function toEuler(obj) {
  const out = {};
  for (const [name, keys] of Object.entries(EULER_KEYS)) {
    const v = Number(findFirstKey(obj, keys));
    if (!Number.isFinite(v)) return null;
    out[name] = v;
  }
  return out;
}

/**
 * Градусы или радианы? Радианный azimuth/roll не выходит за ±π, а pitch — за ±π/2
 * (он снимается через asin). Любое превышение — значит градусы.
 */
function looksLikeDegrees({ azimuth, pitch, roll }) {
  return (
    Math.abs(azimuth) > Math.PI || Math.abs(roll) > Math.PI || Math.abs(pitch) > Math.PI / 2
  );
}

/** Углы в исходных единицах → радианы согласно настройке. */
function eulerToRadians(euler, angleUnit) {
  const unit = angleUnit === 'auto' ? (looksLikeDegrees(euler) ? 'deg' : 'rad') : angleUnit;
  const k = unit === 'deg' ? Math.PI / 180 : 1;
  return {
    values: { azimuth: euler.azimuth * k, pitch: euler.pitch * k, roll: euler.roll * k },
    unit,
  };
}

/** Массив/объект из трёх чисел → { x, y, z }; иначе null. */
function toVec3(raw) {
  if (!raw) return null;
  if (Array.isArray(raw) && raw.length >= 3) {
    const n = raw.slice(0, 3).map(Number);
    return n.every(Number.isFinite) ? { x: n[0], y: n[1], z: n[2] } : null;
  }
  if (typeof raw === 'object') {
    const n = [Number(raw.x), Number(raw.y), Number(raw.z)];
    return n.every(Number.isFinite) ? { x: n[0], y: n[1], z: n[2] } : null;
  }
  return null;
}

/**
 * @typedef {Object} OrientationSample
 * @property {{x:number,y:number,z:number,w:number}} quat нормированный кватернион (система Android)
 * @property {number|null} accuracy оценка точности курса, рад
 * @property {number|null} sensorTime метка времени источника, сек
 * @property {number} recvTime момент приёма в браузере, сек
 * @property {{x:number,y:number,z:number}|null} linearAccel линейное ускорение в осях
 *           устройства, м/с² — если часы его шлют (нужно для расчёта координат)
 * @property {{azimuth:number,pitch:number,roll:number}|null} euler углы в радианах —
 *           заполнены только когда пакет пришёл углами, а не кватернионом
 * @property {'deg'|'rad'|null} angleUnit какие единицы в итоге применились к углам
 * @property {number[]} raw исходные числа
 */

/**
 * @param {string|Uint8Array|object} payload
 * @param {{format?: 'auto'|'json'|'csv', path?: string, angleUnit?: 'auto'|'deg'|'rad',
 *          now?: number}} [options]
 * @returns {OrientationSample}
 */
export function parsePayload(payload, options = {}) {
  const {
    format = 'auto',
    path = '',
    angleUnit = 'auto',
    now = performance.now() / 1000,
  } = options;

  let extracted = null;

  if (typeof payload === 'object' && payload !== null && !(payload instanceof Uint8Array)) {
    extracted = extractFromObject(pickByPath(payload, path));
  } else {
    const text = decodeText(payload).trim();
    if (format !== 'csv') {
      try {
        const json = JSON.parse(text);
        extracted = extractFromObject(pickByPath(json, path));
      } catch {
        extracted = null;
      }
    }
    if (!extracted && format !== 'json') {
      const nums = numbersFromText(text);
      if (nums) extracted = { nums };
    }
  }

  if (!extracted || (!extracted.euler && !(extracted.nums?.length >= 3))) {
    throw new Error(`Не удалось разобрать пакет: ${decodeText(payload).slice(0, 120)}`);
  }

  const sensorTimeFromObj = extracted.timestamp ?? null;

  // Пакет углами: { ts, azimuth, pitch, roll }.
  if (extracted.euler) {
    const { values, unit } = eulerToRadians(extracted.euler, angleUnit);
    return {
      quat: androidOrientationToQuat(values),
      // У углов нет values[4], так что точность курса — только если её прислали отдельно.
      accuracy: extracted.accuracy ?? null,
      linearAccel: extracted.linearAccel ?? null,
      euler: values,
      angleUnit: unit,
      sensorTime: sensorTimeFromObj,
      recvTime: now,
      raw: [extracted.euler.azimuth, extracted.euler.pitch, extracted.euler.roll],
    };
  }

  let nums = extracted.nums;
  let sensorTime = sensorTimeFromObj;

  // 6 чисел — считаем, что первым идёт время.
  if (nums.length >= 6) {
    sensorTime = sensorTime ?? normalizeTimestamp(nums[0]);
    nums = nums.slice(1);
  }

  return {
    quat: rotationVectorToQuat(nums),
    accuracy: extracted.accuracy ?? rotationVectorAccuracy(nums),
    linearAccel: extracted.linearAccel ?? null,
    euler: null,
    angleUnit: null,
    sensorTime,
    recvTime: now,
    raw: nums,
  };
}
