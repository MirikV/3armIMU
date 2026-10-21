/**
 * Источник ориентации поверх MQTT-брокера.
 *
 * ВАЖНО про транспорт: из браузера подключиться к «голому» MQTT (tcp/1883) нельзя,
 * нужен WebSocket-листенер брокера — url вида ws://host:9001 или wss://host:8084.
 * Для mosquitto это строки в конфиге:
 *     listener 9001
 *     protocol websockets
 *
 * События:
 *   'status'  -> { state, detail }  state: idle|connecting|connected|reconnecting|closed|error
 *   'sample'  -> OrientationSample  (см. parsers.js)
 *   'raw'     -> { topic, text }    последний пакет как текст (для панели отладки)
 *   'error'   -> Error
 */

import mqtt from 'mqtt';
import { Emitter } from './emitter.js';
import { parsePayload } from './parsers.js';

const DEFAULT_OPTIONS = {
  url: 'ws://localhost:9001',
  topic: 'robot/watch/rotation',
  username: '',
  password: '',
  clientId: '',
  format: 'auto',
  path: '',
  angleUnit: 'auto',
  qos: 0,
  reconnectPeriod: 2000,
  connectTimeout: 8000,
};

export class MqttSource extends Emitter {
  constructor(options = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.client = null;
    this.state = 'idle';
    this.stats = { messages: 0, parseErrors: 0, lastError: null };
  }

  get isActive() {
    return this.state === 'connected' || this.state === 'connecting' || this.state === 'reconnecting';
  }

  _setState(state, detail = '') {
    this.state = state;
    this.emit('status', { state, detail });
  }

  connect(overrides = {}) {
    this.disconnect();
    this.options = { ...this.options, ...overrides };
    const { url, topic, username, password, clientId, qos, reconnectPeriod, connectTimeout } =
      this.options;

    if (!/^wss?:\/\//i.test(url)) {
      const err = new Error(
        `Браузер умеет только WebSocket-транспорт. Ожидается ws:// или wss://, получено "${url}".`,
      );
      this.stats.lastError = err.message;
      this._setState('error', err.message);
      this.emit('error', err);
      return;
    }

    this._setState('connecting', url);

    this.client = mqtt.connect(url, {
      clientId: clientId || `visual3arm-${Math.random().toString(16).slice(2, 10)}`,
      username: username || undefined,
      password: password || undefined,
      clean: true,
      reconnectPeriod,
      connectTimeout,
    });

    this.client.on('connect', () => {
      this._setState('connected', url);
      this.client.subscribe(topic, { qos }, (err) => {
        if (err) {
          this.stats.lastError = err.message;
          this.emit('error', err);
          this._setState('error', `подписка на "${topic}": ${err.message}`);
        } else {
          this.emit('status', { state: 'connected', detail: `подписан на ${topic}` });
        }
      });
    });

    this.client.on('reconnect', () => this._setState('reconnecting', url));
    this.client.on('close', () => {
      if (this.state !== 'error') this._setState('closed', url);
    });
    this.client.on('offline', () => this._setState('reconnecting', 'offline'));

    this.client.on('error', (err) => {
      this.stats.lastError = err.message;
      this.emit('error', err);
      this._setState('error', err.message);
    });

    this.client.on('message', (msgTopic, payload) => {
      this.stats.messages += 1;
      let text = '';
      try {
        text = new TextDecoder('utf-8').decode(payload);
      } catch {
        text = '<binary>';
      }
      this.emit('raw', { topic: msgTopic, text });
      try {
        const sample = parsePayload(payload, {
          format: this.options.format,
          path: this.options.path,
          angleUnit: this.options.angleUnit,
          now: performance.now() / 1000,
        });
        this.emit('sample', sample);
      } catch (err) {
        this.stats.parseErrors += 1;
        this.stats.lastError = err.message;
        this.emit('error', err);
      }
    });
  }

  disconnect() {
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
      this.client = null;
    }
    if (this.state !== 'idle') this._setState('idle');
  }

  /** Опубликовать команду обратно (задел под управление роботом с той же шины). */
  publish(topic, payload, opts = {}) {
    if (!this.client || this.state !== 'connected') return false;
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.client.publish(topic, body, { qos: this.options.qos, ...opts });
    return true;
  }
}
