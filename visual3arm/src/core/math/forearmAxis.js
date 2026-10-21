/**
 * Ось предплечья в осях корпуса часов — измеряемая величина, а не константа.
 *
 * ── Почему это вообще понадобилось ──
 * Вся развязка осей робота (см. aim.js и armToRobot.js) держится на одном
 * предположении: длинная ось предплечья совпадает с осью +Y устройства («12 часов»
 * циферблата смотрят к кисти). Пока это так, чистая скрутка кисти — это поворот
 * ВОКРУГ +Y, она не двигает направление +Y, а значит не может тронуть ни азимут,
 * ни возвышение, ни, следовательно, основание робота.
 *
 * На живой записи с часов предположение оказалось неверным. Разбор файла
 * tests/fixtures/twist-live.ndjson (человек крутил кистью и почти ничем больше):
 * весь поток — это поворот на 134° вокруг ОДНОЙ оси корпуса (0.973, 0.220, 0.075),
 * то есть практически вокруг +X; на эту ось приходится 99.1% всей угловой «энергии»
 * движения. Ось +Y при этом описывает конус в 134° — и азимут вместе с ней:
 * основание уезжало на 141° при 148° хода головы. Внутри модели это выглядит не как
 * скрутка, а как размашистый взмах предплечьем, и робот честно отрабатывает взмах.
 *
 * Причина у этого бытовая: часы сидят на запястье так, как их надел человек, и «12
 * часов к кисти» — всего лишь один из вариантов. Лечится не подкруткой коэффициентов,
 * а измерением: ось предплечья снимается с самого движения и дальше живёт в
 * калибровке как разворот часов на запястье (Calibration.setForearmAxis).
 *
 * ── Как измеряется ──
 * Скрутка кисти — поворот вокруг оси, НЕПОДВИЖНОЙ В ОСЯХ КОРПУСА. Для соседних
 * замеров r = qᵢ₋₁⁻¹ ⊗ qᵢ — это приращение именно в осях корпуса; его вектор поворота
 * v = ось·угол при чистой скрутке всегда коллинеарен искомой оси. Копим матрицу
 * M = Σ vᵢ vᵢᵀ и берём её главный собственный вектор: он минимизирует сумму квадратов
 * поперечных составляющих, то есть это прямая, вдоль которой легли все приращения.
 * Вес каждого приращения выходит равным |v|² сам собой — быстрые движения весят
 * больше, дрожание в покое не весит почти ничего, порогов вводить не нужно.
 * Отношение λ₁/tr(M) — доля движения, объяснённая одной осью: готовая оценка того,
 * насколько чистым был жест (1.0 — идеально одноосное движение).
 *
 * ── Чего измерить нельзя ──
 * Знак. Поворот вокруг +a и вокруг −a — это одно и то же множество поворотов, и по
 * скрутке различить «ось смотрит к кисти» и «ось смотрит к локтю» невозможно в
 * принципе. Выбираем полушарие по опорной оси (обычно — предыдущей настройке), а
 * если опора почти перпендикулярна, делаем наибольшую компоненту положительной.
 * Ошибка знака видна мгновенно: основание смотрит ровно в противоположную сторону,
 * а возвышение меняет знак. Поэтому в UI есть кнопка «развернуть ось» — это честнее,
 * чем угадывать.
 */

import { quat, normalize, multiply, invert, rotateVector, toRad } from './quat.js';

/** Номинальная ось: «12 часов» циферблата смотрят к кисти. */
export const NOMINAL_FOREARM_AXIS = Object.freeze({ x: 0, y: 1, z: 0 });

/** Приращения мельче этого — шум АЦП и дрожание, в матрицу не идут. */
const MIN_STEP = toRad(0.02);

/** Потолок на число приращений: забытая калибровка не должна съесть память. */
const MAX_STEPS = 20000;

function norm3(v) {
  const n = Math.hypot(v.x, v.y, v.z);
  if (n < 1e-12) return { ...NOMINAL_FOREARM_AXIS };
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

function dot3(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function neg3(v) {
  return { x: -v.x, y: -v.y, z: -v.z };
}

/**
 * Кватернион установки часов: кратчайший поворот, переводящий номинальную ось +Y
 * в измеренную. Именно он кладётся в Calibration.mount — после него эффективная
 * ось предплечья снова равна (0,1,0), и весь код ниже по течению (aim.js, стратегии)
 * не меняется ни строкой.
 *
 * Кратчайшая дуга: q = (a×b, 1 + a·b), нормировать. Вырождение a·b ≈ −1 (ось смотрит
 * ровно назад) — поворот на 180°, ось любая перпендикулярная; берём +Z, она
 * перпендикулярна +Y по построению.
 */
export function mountFromForearmAxis(axis) {
  const b = norm3(axis || NOMINAL_FOREARM_AXIS);
  const a = NOMINAL_FOREARM_AXIS;
  const d = dot3(a, b);
  if (d < -1 + 1e-9) return quat(0, 0, 1, 0);
  const cross = {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
  return normalize(quat(cross.x, cross.y, cross.z, 1 + d));
}

/** Обратно: какая ось корпуса объявлена осью предплечья этим mount'ом. */
export function forearmAxisFromMount(mount) {
  return rotateVector(normalize(mount || quat()), NOMINAL_FOREARM_AXIS);
}

/**
 * Выбор знака оси. reference — ось, относительно которой хотим остаться в одном
 * полушарии (обычно предыдущая настройка). Если она почти перпендикулярна измеренной,
 * знак по ней не восстанавливается — тогда правило «наибольшая компонента
 * положительна»: произвольное, зато воспроизводимое.
 */
export function orientAxis(axis, reference = NOMINAL_FOREARM_AXIS) {
  const a = norm3(axis);
  const d = dot3(a, norm3(reference));
  if (Math.abs(d) > 0.2) return d < 0 ? neg3(a) : a;
  const comps = [a.x, a.y, a.z];
  let k = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(comps[i]) > Math.abs(comps[k])) k = i;
  return comps[k] < 0 ? neg3(a) : a;
}

/** Главный собственный вектор симметричной 3x3 (row-major) степенной итерацией. */
function principalAxis(M) {
  // Старт — колонка с наибольшей нормой: она заведомо не ортогональна главному
  // вектору (иначе её норма была бы нулевой).
  const cols = [
    { x: M[0], y: M[3], z: M[6] },
    { x: M[1], y: M[4], z: M[7] },
    { x: M[2], y: M[5], z: M[8] },
  ];
  let u = cols[0];
  for (const c of cols) if (Math.hypot(c.x, c.y, c.z) > Math.hypot(u.x, u.y, u.z)) u = c;
  if (Math.hypot(u.x, u.y, u.z) < 1e-18) return { axis: { ...NOMINAL_FOREARM_AXIS }, lambda: 0 };
  u = norm3(u);
  for (let i = 0; i < 128; i++) {
    const w = {
      x: M[0] * u.x + M[1] * u.y + M[2] * u.z,
      y: M[3] * u.x + M[4] * u.y + M[5] * u.z,
      z: M[6] * u.x + M[7] * u.y + M[8] * u.z,
    };
    const n = Math.hypot(w.x, w.y, w.z);
    if (n < 1e-18) break;
    u = { x: w.x / n, y: w.y / n, z: w.z / n };
  }
  const w = {
    x: M[0] * u.x + M[1] * u.y + M[2] * u.z,
    y: M[3] * u.x + M[4] * u.y + M[5] * u.z,
    z: M[6] * u.x + M[7] * u.y + M[8] * u.z,
  };
  return { axis: u, lambda: dot3(u, w) };
}

/**
 * @typedef {Object} ForearmAxisResult
 * @property {{x,y,z}} axis      измеренная ось в осях корпуса (единичная)
 * @property {number} quality    доля движения, объяснённая одной осью, 0…1
 * @property {number} sweep      размах скрутки вокруг найденной оси, рад
 * @property {number} steps      сколько приращений вошло в оценку
 * @property {number} deviation  угол между измеренной осью и номинальной +Y, рад
 */

/**
 * Накопитель приращений. Кормить СЫРЫМИ кватернионами с часов: ось живёт в осях
 * корпуса, а mount — как раз то, что мы по ней и собираемся назначить. Обнуление
 * (zero) на ось не влияет вовсе — это левое умножение, оно крутит мир, а не корпус.
 */
export class ForearmAxisEstimator {
  constructor() {
    this.reset();
  }

  reset() {
    this.prev = null;
    this.steps = [];
    this.M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  }

  /** @param {{x,y,z,w}} qRaw */
  push(qRaw) {
    const q = normalize(qRaw || quat());
    if (!this.prev) {
      this.prev = q;
      return;
    }
    let r = normalize(multiply(invert(this.prev), q));
    this.prev = q;
    // Двойное накрытие: q и −q — один поворот, но векторы поворота противоположны.
    if (r.w < 0) r = quat(-r.x, -r.y, -r.z, -r.w);
    const s = Math.hypot(r.x, r.y, r.z);
    if (s < 1e-12) return;
    const angle = 2 * Math.atan2(s, r.w);
    if (Math.abs(angle) < MIN_STEP) return;
    const v = { x: (r.x / s) * angle, y: (r.y / s) * angle, z: (r.z / s) * angle };
    if (this.steps.length < MAX_STEPS) this.steps.push(v);
    const c = [v.x, v.y, v.z];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) this.M[a * 3 + b] += c[a] * c[b];
  }

  get count() {
    return this.steps.length;
  }

  /**
   * Текущая оценка. Дешёвая — можно звать хоть на каждый кадр панели.
   * @param {{x,y,z}} [reference] ось, задающая полушарие для выбора знака
   * @returns {ForearmAxisResult}
   */
  estimate(reference = NOMINAL_FOREARM_AXIS) {
    const trace = this.M[0] + this.M[4] + this.M[8];
    if (!this.steps.length || trace < 1e-18) {
      return {
        axis: { ...NOMINAL_FOREARM_AXIS },
        quality: 0,
        sweep: 0,
        steps: this.steps.length,
        deviation: 0,
      };
    }
    const { axis: raw, lambda } = principalAxis(this.M);
    const axis = orientAxis(raw, reference);

    // Размах: интегрируем проекции приращений на ось и берём peak-to-peak. Движение
    // «туда и обратно» так не схлопывается в ноль, в отличие от простой суммы.
    let acc = 0;
    let lo = 0;
    let hi = 0;
    for (const v of this.steps) {
      acc += dot3(v, axis);
      if (acc < lo) lo = acc;
      if (acc > hi) hi = acc;
    }

    return {
      axis,
      quality: Math.max(0, Math.min(1, lambda / trace)),
      sweep: hi - lo,
      steps: this.steps.length,
      deviation: Math.acos(Math.max(-1, Math.min(1, dot3(axis, NOMINAL_FOREARM_AXIS)))),
    };
  }
}

/**
 * То же одним вызовом для готовой последовательности (тесты, разбор записи).
 * @param {Array<{x,y,z,w}>} quats сырые кватернионы подряд
 * @param {{reference?: {x,y,z}}} [options]
 * @returns {ForearmAxisResult}
 */
export function estimateForearmAxis(quats, options = {}) {
  const est = new ForearmAxisEstimator();
  for (const q of quats || []) est.push(q);
  return est.estimate(options.reference || NOMINAL_FOREARM_AXIS);
}
