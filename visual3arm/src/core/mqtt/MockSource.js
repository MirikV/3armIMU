/**
 * Генератор синтетического потока — тот же интерфейс, что у MqttSource.
 * Нужен, чтобы крутить сцену и калибровку без часов и брокера.
 */

import { Emitter } from './emitter.js';
import { fromAxisAngle, multiply, normalize, toRad } from '../math/quat.js';

const AX_X = { x: 1, y: 0, z: 0 };
const AX_Y = { x: 0, y: 1, z: 0 };
const AX_Z = { x: 0, y: 0, z: 1 };

export class MockSource extends Emitter {
  constructor(options = {}) {
    super();
    this.options = { hz: 50, amplitudeDeg: 55, periodSec: 6, ...options };
    this.timer = null;
    this.state = 'idle';
    this.t0 = 0;
    this.stats = { messages: 0, parseErrors: 0, lastError: null };
  }

  get isActive() {
    return this.state === 'connected';
  }

  connect(overrides = {}) {
    this.disconnect();
    this.options = { ...this.options, ...overrides };
    this.t0 = performance.now() / 1000;
    this.state = 'connected';
    this.emit('status', { state: 'connected', detail: 'симулятор' });

    const periodMs = 1000 / this.options.hz;
    this.timer = setInterval(() => this._tick(), periodMs);
  }

  _tick() {
    const now = performance.now() / 1000;
    const t = now - this.t0;
    const a = toRad(this.options.amplitudeDeg);
    const w = (2 * Math.PI) / this.options.periodSec;

    // Правдоподобная «рука»: курс гуляет медленно, наклон и крен быстрее.
    const azimuth = a * 0.8 * Math.sin(w * 0.35 * t);
    const pitch = a * Math.sin(w * t);
    const roll = a * 0.6 * Math.sin(w * 0.7 * t + 1.1);

    const q = normalize(
      multiply(
        multiply(fromAxisAngle(AX_Z, azimuth), fromAxisAngle(AX_X, pitch)),
        fromAxisAngle(AX_Y, roll),
      ),
    );

    this.stats.messages += 1;
    const raw = [q.x, q.y, q.z, q.w, 0.05];
    this.emit('raw', { topic: 'sim/rotation', text: JSON.stringify(raw.map((v) => +v.toFixed(5))) });
    this.emit('sample', {
      quat: q,
      accuracy: 0.05,
      sensorTime: now,
      recvTime: now,
      raw,
    });
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
