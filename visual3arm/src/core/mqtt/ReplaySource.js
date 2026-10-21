/**
 * Воспроизведение записанного потока — тот же интерфейс, что у MqttSource и MockSource.
 *
 * Нужен, чтобы отлаживать кинематику на движениях РЕАЛЬНОГО пользователя, а не на
 * синусоидах симулятора: записал подход к роботу один раз — и дальше крутишь его
 * сколько угодно, с теми же паузами, тем же дрожанием и тем же паразитным уводом оси.
 *
 * Пакеты прогоняются через тот же parsePayload(), что и живой MQTT, — иначе запись
 * проверяла бы не тот тракт, который потом работает у пользователя.
 *
 * ── Время ──
 * Планировщик идёт по СТЕНным часам, а не по «одному setTimeout на пакет»: в фоновой
 * вкладке таймеры душатся до 1 Гц, и наивная цепочка растянула бы минутную запись на
 * час. На каждом тике отдаём все пакеты, чьё время уже наступило.
 *
 * Позиция хранится не якорем «когда началось воспроизведение», а НАКОПЛЕННЫМ временем
 * записи (`elapsed`): якорь пришлось бы пересчитывать при каждой паузе, смене скорости
 * и перемотке, и любая забытая пересборка давала бы скачок. С накоплением все три
 * операции — это просто «перестать прибавлять», «прибавлять с другим множителем» и
 * «присвоить другое значение».
 */

import { Emitter } from './emitter.js';
import { parsePayload } from './parsers.js';
import { parseRecording, recordingDuration } from './recording.js';

const TICK_MS = 20;

export class ReplaySource extends Emitter {
  /**
   * @param {{entries?: Array, text?: string, speed?: number, loop?: boolean,
   *          format?: string, path?: string, angleUnit?: string, name?: string,
   *          clock?: () => number}} options
   *        clock — источник времени в секундах; подменяется в тестах, чтобы гонять
   *        воспроизведение без реального ожидания.
   */
  constructor(options = {}) {
    super();
    this.options = { speed: 1, loop: true, format: 'auto', path: '', angleUnit: 'auto', ...options };
    this.entries = options.entries || (options.text ? parseRecording(options.text).entries : []);
    this.clock = options.clock || (() => performance.now() / 1000);
    this.timer = null;
    this.state = 'idle';
    this.index = 0;
    /** Проигранное время ЗАПИСИ от её начала, секунды. */
    this.elapsed = 0;
    /** Отметка стенных часов на прошлом тике. */
    this.lastTick = 0;
    this.paused = false;
    this.stats = { messages: 0, parseErrors: 0, lastError: null };
  }

  get isActive() {
    return this.state === 'connected';
  }

  get duration() {
    return recordingDuration(this.entries);
  }

  /** Текущая позиция в записи, секунды от её начала. */
  get position() {
    return Math.min(this.elapsed, this.duration);
  }

  /** Доля проигранного, 0…1 (для полосы прогресса). */
  get progress() {
    const d = this.duration;
    return d > 0 ? Math.min(1, Math.max(0, this.elapsed / d)) : 0;
  }

  get speed() {
    return Math.max(0.05, Number(this.options.speed) || 1);
  }

  connect(overrides = {}) {
    this.disconnect();
    this.options = { ...this.options, ...overrides };
    if (!this.entries.length) {
      const detail = 'запись не загружена — выберите файл';
      this.state = 'error';
      this.emit('status', { state: 'error', detail });
      this.emit('error', new Error(detail));
      return;
    }
    this.index = 0;
    this.elapsed = 0;
    this.paused = false;
    this.lastTick = this.clock();
    this.state = 'connected';
    this._emitStatus();
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  _emitStatus() {
    const name = this.options.name ? ` «${this.options.name}»` : '';
    this.emit('status', {
      state: 'connected',
      detail:
        `запись${name}: ${this.entries.length} пакетов, ${this.duration.toFixed(1)} с` +
        (this.paused ? ' — пауза' : ` — ×${this.speed}`),
    });
  }

  /** Пауза: время записи стоит, таймер продолжает тикать вхолостую. */
  pause() {
    if (this.paused) return;
    this.paused = true;
    if (this.isActive) this._emitStatus();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    // Стенное время, простоявшее на паузе, в запись не переносим.
    this.lastTick = this.clock();
    if (this.isActive) this._emitStatus();
  }

  setPaused(value) {
    if (value) this.pause();
    else this.resume();
  }

  /**
   * Скорость меняется без перезапуска: множитель применяется только к БУДУЩИМ тикам,
   * уже накопленная позиция остаётся на месте.
   */
  setSpeed(speed) {
    this.options.speed = speed;
    if (this.isActive) this._emitStatus();
  }

  setLoop(loop) {
    this.options.loop = !!loop;
  }

  /**
   * Перемотка на заданную секунду записи. Пакеты, оказавшиеся позади, не досылаются
   * очередью: перемотка — это скачок состояния, а не ускоренное воспроизведение.
   * @param {number} seconds
   */
  seek(seconds) {
    if (!this.entries.length) return;
    const target = Math.min(this.duration, Math.max(0, Number(seconds) || 0));
    const start = this.entries[0].t;
    this.elapsed = target;
    this.lastTick = this.clock();
    let i = 0;
    while (i < this.entries.length && this.entries[i].t - start <= target) i += 1;
    this.index = i;
  }

  _tick() {
    const now = this.clock();
    const dt = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    if (this.paused) return;

    this.elapsed += dt * this.speed;
    const start = this.entries[0].t;

    while (this.index < this.entries.length && this.entries[this.index].t - start <= this.elapsed) {
      this._emitEntry(this.entries[this.index], now);
      this.index += 1;
    }

    if (this.index >= this.entries.length) {
      if (this.options.loop) {
        this.index = 0;
        this.elapsed = 0;
      } else {
        this.disconnect();
        this.emit('status', { state: 'closed', detail: 'запись доиграна' });
      }
    }
  }

  _emitEntry(entry, now) {
    this.stats.messages += 1;
    this.emit('raw', { topic: entry.topic || 'replay', text: entry.payload });
    try {
      // recvTime — момент ВОСПРОИЗВЕДЕНИЯ, а не записи: на нём стоят и сглаживание,
      // и измеритель частоты, им нужно текущее время, иначе dt получится отрицательным.
      this.emit(
        'sample',
        parsePayload(entry.payload, {
          format: this.options.format,
          path: this.options.path,
          angleUnit: this.options.angleUnit,
          now,
        }),
      );
    } catch (err) {
      this.stats.parseErrors += 1;
      this.stats.lastError = err.message;
      this.emit('error', err);
    }
  }

  disconnect() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.state !== 'idle') {
      this.state = 'idle';
      this.emit('status', { state: 'idle', detail: '' });
    }
  }

  publish() {
    return false;
  }
}
