/**
 * Ограничитель привода: превращает «мгновенную» цель стратегии в физически достижимое
 * движение шаговых двигателей.
 *
 * ── Зачем ──
 * Стратегия выдаёт цель на каждом пакете (50–100 Гц). Реальный шаговик так не умеет:
 * у него есть максимальная скорость (упирается в частоту шагов и момент) и максимальное
 * ускорение (иначе пропуск шагов). Поэтому модель в сцене теперь живёт так же, как
 * железо: цель отдельно, фактический угол подтягивается к ней с ограничениями.
 * Резко дёрнули рукой — робот заметно отстал и догнал за доли секунды. Это не баг.
 *
 * Публикации наружу нет: G-code и MQTT-команды сюда не входят, это только симуляция.
 *
 * ── Закон управления ──
 * Классический трапецеидальный профиль «разгон — полка — торможение», посчитанный
 * из тормозного пути. Скорость, с которой ещё успеваем остановиться на цели:
 *   v_stop = sqrt(2·a_max·|err|)     (из v² = 2·a·S)
 * Желаемая скорость: v_des = sign(err)·min(v_max, v_stop).
 * Фактическая тянется к желаемой не быстрее a_max:
 *   v ← v + clamp(v_des − v, ±a_max·dt),  затем clamp(v, ±v_max)
 *   θ ← θ + v·dt,                          затем clamp по лимитам шарнира
 *
 * ── Честные оговорки ──
 * 1. Ограничение по ускорению соблюдается строго ТОЛЬКО НА РАЗГОНЕ. Торможение может
 *    оказаться резче a_max в двух местах: на «посадке» точно в цель и при ударе в
 *    лимит угла. Так и правильно: остановиться мотор может всегда (в пределе — упереться),
 *    а вот разогнаться сверх момента — нет. Разгон и есть то, что ограничивает железо.
 * 2. Без «посадки» дискретный профиль не сходится точно, а зависает в автоколебании
 *    шириной ~2·a·dt² вокруг цели (для 400 °/с² и 60 кадров это ~0.2°). Поэтому шаг,
 *    который перескочил бы цель, укорачивается ровно до цели, а скорость обнуляется.
 * 3. dt берётся из render loop (реальное время кадра), а НЕ из моментов прихода пакетов:
 *    иначе при просадке потока робот замедлялся бы вместе с ней, чего в железе не бывает.
 *    Слишком большой dt (вкладка была свёрнута) режется MAX_DT, чтобы модель не
 *    телепортировалась.
 */

import { toRad, toDeg } from '../math/quat.js';

/** Максимальный шаг интегрирования, с. Больше — считаем, что кадры просто пропали. */
const MAX_DT = 0.1;

/**
 * Дефолтные пределы приводов. Скорость — °/с, ускорение — °/с².
 * Порядок величин «как у настольного манипулятора на NEMA-17 с редуктором»:
 * наклон тащит всю стрелу и потому медленнее всех, основание легче, голова почти
 * безынерционная и крутится быстрее всех.
 */
export const DEFAULT_JOINT_LIMITS = {
  base: { maxSpeedDeg: 120, maxAccelDeg: 400 },
  lift: { maxSpeedDeg: 90, maxAccelDeg: 300 },
  wristRoll: { maxSpeedDeg: 180, maxAccelDeg: 600 },
};

function clampNum(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export class JointLimiter {
  /**
   * @param {import('./RobotModel.js').RobotModel} model нужен только для лимитов углов
   * @param {Record<string, {maxSpeedDeg:number, maxAccelDeg:number}>} [limits]
   */
  constructor(model, limits = DEFAULT_JOINT_LIMITS) {
    this.model = model;
    this.setLimits(limits);
    /** Фактические углы, рад. */
    this.angles = {};
    /** Фактические скорости, рад/с. */
    this.velocities = {};
    this.sync(model.angles);
  }

  /** Пределы приводов из UI (в градусах) → внутренние радианы. */
  setLimits(limits) {
    this.limits = {};
    for (const j of this.model.joints) {
      const src = limits?.[j.name] ?? DEFAULT_JOINT_LIMITS[j.name] ?? {};
      this.limits[j.name] = {
        maxSpeed: toRad(Math.max(1e-3, src.maxSpeedDeg ?? 120)),
        maxAccel: toRad(Math.max(1e-3, src.maxAccelDeg ?? 400)),
      };
    }
  }

  /** Принять текущие углы модели за фактические и обнулить скорости. */
  sync(anglesRad = this.model.angles) {
    for (const j of this.model.joints) {
      this.angles[j.name] = anglesRad[j.name] ?? 0;
      this.velocities[j.name] = 0;
    }
    return this.angles;
  }

  /** Диагностика для панели: скорости в °/с. */
  speedsDeg() {
    const out = {};
    for (const [k, v] of Object.entries(this.velocities)) out[k] = toDeg(v);
    return out;
  }

  /**
   * Один шаг интегрирования по реальному времени.
   * @param {Record<string, number>} targetsRad цель, радианы (частичная карта — можно)
   * @param {number} dt секунды
   * @returns {Record<string, number>} фактические углы, радианы
   */
  step(targetsRad, dt) {
    const h = clampNum(Number(dt) || 0, 0, MAX_DT);
    if (h <= 0) return this.angles;

    for (const j of this.model.joints) {
      const name = j.name;
      const [lo, hi] = this.model.limitsRad(name);
      const raw = targetsRad?.[name];
      // Цель сразу режем по лимитам угла: иначе привод вечно упирался бы в стенку
      // с ненулевой «желаемой» скоростью и в панели висела бы несуществующая ошибка.
      const target = clampNum(Number.isFinite(raw) ? raw : this.angles[name], lo, hi);

      const { maxSpeed, maxAccel } = this.limits[name];
      let pos = this.angles[name];
      let vel = this.velocities[name];

      const err = target - pos;
      const vStop = Math.sqrt(2 * maxAccel * Math.abs(err));
      const vDes = Math.sign(err) * Math.min(maxSpeed, vStop);

      vel += clampNum(vDes - vel, -maxAccel * h, maxAccel * h);
      vel = clampNum(vel, -maxSpeed, maxSpeed);

      const stepRad = vel * h;
      if (stepRad * err > 0 && Math.abs(stepRad) >= Math.abs(err)) {
        // Долетели за один кадр — садимся ровно на цель и встаём (см. оговорку 2).
        pos = target;
        vel = 0;
      } else {
        pos += stepRad;
      }

      if (pos <= lo) {
        pos = lo;
        vel = 0;
      } else if (pos >= hi) {
        pos = hi;
        vel = 0;
      }

      this.angles[name] = pos;
      this.velocities[name] = vel;
    }
    return this.angles;
  }
}
