/**
 * Калибровка потока ориентации.
 *
 * Итоговый кватернион:  q_eff = zero⁻¹ ⊗ q_raw ⊗ mount
 *
 *  - zero  — «где был ноль мира» в момент нажатия кнопки. Левое умножение, потому
 *            что это поворот МИРОВОЙ системы (перекладываем ENU в удобную нам).
 *  - mount — как часы надеты на запястье (корпус повёрнут относительно предплечья).
 *            Правое умножение — это поворот ЛОКАЛЬНОЙ системы устройства.
 *
 * ── Из чего собран mount ──
 *   mount = A ⊗ E
 *  - A — разворот, переводящий номинальную ось предплечья (0,1,0) в ИЗМЕРЕННУЮ
 *        (см. core/math/forearmAxis.js). Это главная часть: от неё зависит, что
 *        конвейер считает скруткой кисти, а что — взмахом предплечья. Раньше она
 *        подразумевалась единичной, то есть «12 часов всегда смотрят к кисти», и на
 *        живых часах это оказалось неправдой — скрутка приезжала в азимут и уводила
 *        основание робота на 141°.
 *  - E — ручные углы установки, доводка уже в системе предплечья. Порядок именно
 *        такой: сначала ставим ось, потом крутим вокруг неё руками.
 * При номинальной оси A = 1, и mount = E — ровно прежнее поведение.
 *
 * ── Ноль берётся ПОСЛЕ mount, а не до ──
 * Подставим сырую позу в формулу: q_eff = zero⁻¹ ⊗ q_raw ⊗ mount. Чтобы она дала
 * единицу, нужен zero = q_raw ⊗ mount. Пока mount был единичным, хватало zero = q_raw,
 * и разницы никто не видел. С измеряемой осью предплечья mount перестал быть единичным,
 * и zero = q_raw стал оставлять q_eff = mount: ось предплечья после «обнуления» смотрит
 * не вперёд, а туда, куда её развернул A. Азимут при этом ровно равен отклонению
 * измеренной оси от «12 часов» — на живой записи 77°, у часов, надетых с разворотом
 * на 45°, ровно 45°. Симптом: рука вытянута вперёд, а робот стоит наискось.
 *
 * Отсюда два правила:
 *  1. ноль считается от УЖЕ калиброванной позы: zero = f(q_raw ⊗ mount);
 *  2. хранится не сам zero, а сырая поза zeroRaw в момент нажатия — при каждой смене
 *     mount (измерили ось, подкрутили ручные углы) ноль пересчитывается из неё заново.
 *     Иначе «Измерить скруткой» после обнуления молча ломало бы ноль, а порядок
 *     нажатия кнопок пользователю знать неоткуда.
 *
 * Режимы обнуления:
 *  - 'full'    — гасим всю текущую ориентацию (удобно для стенда);
 *  - 'heading' — гасим только азимут (он уезжает вслед за магнитометром),
 *                наклон остаётся физическим.
 */

import { quat, multiply, invert, normalize, fromAxisAngle, toRad } from './quat.js';
import { splitHeading } from './frames.js';
import { mountFromForearmAxis, NOMINAL_FOREARM_AXIS } from './forearmAxis.js';

export const ZERO_MODES = ['full', 'heading'];

export class Calibration {
  constructor() {
    this.zero = quat();
    /** Сырая поза в момент нажатия кнопки; null — ноль не взят. */
    this.zeroRaw = null;
    this.zeroMode = 'full';
    this.mount = quat();
    this.mountEulerDeg = { x: 0, y: 0, z: 0 };
    this.mountEuler = quat();
    this.forearmAxis = { ...NOMINAL_FOREARM_AXIS };
    this.forearmMount = quat();
  }

  /**
   * Запомнить текущую позу как нулевую.
   * @param {{x:number,y:number,z:number,w:number}} qRaw сырая ориентация с часов
   * @param {'full'|'heading'} mode
   */
  captureZero(qRaw, mode = 'full') {
    this.zeroRaw = normalize(qRaw || quat());
    this.zeroMode = ZERO_MODES.includes(mode) ? mode : 'full';
    return this.composeZero();
  }

  clearZero() {
    this.zeroRaw = null;
    this.zero = quat();
  }

  /** Сменить режим нуля, не переснимая позу. */
  setZeroMode(mode) {
    this.zeroMode = ZERO_MODES.includes(mode) ? mode : 'full';
    return this.composeZero();
  }

  /**
   * Пересчёт нуля из сохранённой сырой позы под ТЕКУЩИЙ mount. Зовётся и при
   * обнулении, и при каждой смене mount — см. шапку файла.
   */
  composeZero() {
    if (!this.zeroRaw) {
      this.zero = quat();
      return this.zero;
    }
    const qCal = normalize(multiply(this.zeroRaw, this.mount));
    this.zero = this.zeroMode === 'heading' ? splitHeading(qCal).yaw : qCal;
    return this.zero;
  }

  /**
   * Углы установки часов на запястье, градусы, в осях устройства.
   * Порядок применения — Z, затем Y, затем X (yaw → pitch → roll).
   */
  setMountEulerDeg({ x = 0, y = 0, z = 0 } = {}) {
    this.mountEulerDeg = { x, y, z };
    const qx = fromAxisAngle({ x: 1, y: 0, z: 0 }, toRad(x));
    const qy = fromAxisAngle({ x: 0, y: 1, z: 0 }, toRad(y));
    const qz = fromAxisAngle({ x: 0, y: 0, z: 1 }, toRad(z));
    this.mountEuler = normalize(multiply(multiply(qz, qy), qx));
    return this.composeMount();
  }

  /**
   * Измеренная ось предплечья в осях корпуса часов (единичная, к кисти).
   * @param {{x:number,y:number,z:number}} axis
   */
  setForearmAxis(axis) {
    const a = axis || NOMINAL_FOREARM_AXIS;
    const n = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
    this.forearmAxis = n > 1e-9
      ? { x: a.x / n, y: a.y / n, z: a.z / n }
      : { ...NOMINAL_FOREARM_AXIS };
    this.forearmMount = mountFromForearmAxis(this.forearmAxis);
    return this.composeMount();
  }

  composeMount() {
    this.mount = normalize(multiply(this.forearmMount, this.mountEuler));
    // Ноль живёт в калиброванной системе, а её только что сдвинули — пересобираем.
    this.composeZero();
    return this.mount;
  }

  reset() {
    this.clearZero();
    this.setForearmAxis(NOMINAL_FOREARM_AXIS);
    this.setMountEulerDeg({ x: 0, y: 0, z: 0 });
  }

  /** Применить калибровку к сырой ориентации. */
  apply(qRaw) {
    return normalize(multiply(multiply(invert(this.zero), qRaw), this.mount));
  }
}
