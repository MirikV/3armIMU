/**
 * Сглаживание потока и измерение частоты пакетов.
 */

import { slerp, normalize, angleBetween } from './quat.js';

/**
 * Экспоненциальное сглаживание кватерниона с постоянной времени tau (сек).
 * Не зависит от частоты пакетов: alpha = 1 - exp(-dt / tau).
 * tau = 0 — сглаживание выключено.
 */
export class QuatSmoother {
  constructor(tauSeconds = 0.06) {
    this.tau = tauSeconds;
    this.value = null;
    this.lastT = null;
  }

  setTau(tauSeconds) {
    this.tau = Math.max(0, tauSeconds);
  }

  reset() {
    this.value = null;
    this.lastT = null;
  }

  /**
   * @param {{x,y,z,w}} q новая измеренная ориентация
   * @param {number} tSeconds момент времени (монотонный), сек
   */
  push(q, tSeconds) {
    const next = normalize(q);
    if (!this.value || this.tau <= 0) {
      this.value = next;
      this.lastT = tSeconds;
      return this.value;
    }
    const dt = Math.max(0, tSeconds - (this.lastT ?? tSeconds));
    this.lastT = tSeconds;
    const alpha = dt > 0 ? 1 - Math.exp(-dt / this.tau) : 0;
    this.value = slerp(this.value, next, alpha);
    return this.value;
  }
}

/** Скользящая оценка частоты пакетов, Гц. */
export class RateMeter {
  constructor(windowSize = 30) {
    this.windowSize = windowSize;
    this.stamps = [];
  }

  tick(tSeconds) {
    this.stamps.push(tSeconds);
    if (this.stamps.length > this.windowSize) this.stamps.shift();
  }

  get hz() {
    if (this.stamps.length < 2) return 0;
    const span = this.stamps[this.stamps.length - 1] - this.stamps[0];
    if (span <= 0) return 0;
    return (this.stamps.length - 1) / span;
  }

  reset() {
    this.stamps = [];
  }
}

/**
 * Угловая скорость между двумя замерами, рад/с (по модулю).
 * Пригодится и для детекции «рука стоит» при будущей интеграции акселерометра.
 */
export function angularSpeed(qPrev, qNext, dtSeconds) {
  if (!qPrev || !qNext || !dtSeconds) return 0;
  return angleBetween(qPrev, qNext) / dtSeconds;
}
