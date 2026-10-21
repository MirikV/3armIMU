/**
 * Состояние приложения.
 *
 * Принципиальный момент: поток с часов — это 50–100 пакетов в секунду. Гонять их
 * через реактивность Vue бессмысленно и дорого, поэтому состояние разделено:
 *
 *   live      — обычный НЕреактивный объект, пишется на каждом пакете,
 *               читается из render loop Babylon;
 *   telemetry — реактивная витрина, обновляется таймером ~12 раз в секунду,
 *               только для панелей;
 *   settings  — реактивные настройки, сохраняются в localStorage.
 */

import Vue from 'vue';
import { MqttSource } from '../core/mqtt/MqttSource.js';
import { MockSource } from '../core/mqtt/MockSource.js';
import { ReplaySource } from '../core/mqtt/ReplaySource.js';
import { parseRecording, serializeRecording, recordingDuration } from '../core/mqtt/recording.js';
import { Calibration } from '../core/math/calibration.js';
import { QuatSmoother, RateMeter, angularSpeed } from '../core/math/filter.js';
import { ForearmAxisEstimator, NOMINAL_FOREARM_AXIS } from '../core/math/forearmAxis.js';
import { androidOrientationAngles, androidQuatToBabylon } from '../core/math/frames.js';
import { eulerYXZ } from '../core/math/euler.js';
import { quat, toDeg } from '../core/math/quat.js';
import { RobotModel } from '../core/robot/RobotModel.js';
import {
  mapArmToRobot,
  DEFAULT_GAIN,
  DEFAULT_DIRECT,
  DEFAULT_STRATEGY,
  ROBOT_STRATEGIES,
} from '../core/robot/armToRobot.js';
import { JointLimiter, DEFAULT_JOINT_LIMITS } from '../core/robot/JointLimiter.js';

const STORAGE_KEY = 'visual3arm.settings.v1';

const DEFAULT_SETTINGS = {
  source: 'mock', // 'mqtt' | 'mock' | 'replay'
  url: 'ws://localhost:9001',
  topic: 'robot/watch/rotation',
  username: '',
  password: '',
  clientId: '',
  format: 'auto',
  path: '',
  /** Единицы углов Эйлера, если часы шлют azimuth/pitch/roll: 'auto' | 'deg' | 'rad'. */
  angleUnit: 'auto',
  qos: 0,
  autoConnect: true,

  smoothingTau: 0.05,
  zeroMode: 'full',

  /**
   * Поза в момент нажатия «Обнулить по текущей позе» — СЫРАЯ, до калибровки.
   * Хранится именно она, а не готовый ноль: ноль зависит от mount, а mount меняется
   * кнопкой «Измерить скруткой» и ползунками установки (см. core/math/calibration.js).
   * null — ноль не взят. Живёт в настройках, чтобы переживать перезагрузку страницы:
   * у GAME_ROTATION_VECTOR курс относительный, и переснимать ноль после каждого F5 —
   * это ровно тот ручной ритуал, про который пользователь не обязан помнить.
   */
  zeroRaw: null,

  mountEulerDeg: { x: 0, y: 0, z: 0 },

  /**
   * Ось предплечья в осях корпуса часов — измеряется кнопкой «калибровать скруткой»
   * (см. core/math/forearmAxis.js). Дефолт — номинальные «12 часов к кисти»; для
   * реально надетых часов он почти всегда неверен, и именно от этого основание робота
   * уезжало вслед за скруткой кисти.
   */
  forearmAxis: { x: 0, y: 1, z: 0 },

  /** Воспроизведение записи пакетов. Сам файл в настройках не живёт — он грузится руками. */
  replay: {
    speed: 1,
    loop: true,
  },

  /**
   * Масштаб интерфейса. На плотных ноутбучных экранах (Acer Swift Go 14 и подобные)
   * браузер отдаёт devicePixelRatio > 1, но CSS-пиксели остаются мелкими, и панель
   * читается плохо. Множитель применяется к корневому размеру шрифта, а все размеры
   * в вёрстке заданы в rem — поэтому вместе со шрифтом растут отступы, поля ввода и
   * ширина колонки.
   */
  ui: {
    scale: 1.15,
  },

  robot: {
    enabled: true,
    follow: true,
    strategy: DEFAULT_STRATEGY,
    gain: { ...DEFAULT_GAIN },
    glbUrl: '',

    /** Настройки прямого отображения (стратегия 'direct'), см. armToRobot.js. */
    direct: { ...DEFAULT_DIRECT },

    /** Симуляция инерции приводов: цель отдельно, фактические углы догоняют. */
    limiter: true,
    jointLimits: structuredClone(DEFAULT_JOINT_LIMITS),
  },

  view: {
    showRobot: true,
    showWorldAxes: true,
    showGround: true,
  },
};

/**
 * Слияние сохранённой секции с дефолтной ПО КЛЮЧАМ ДЕФОЛТА.
 *
 * Обычный spread протащил бы мёртвые ключи из старого localStorage — а их там теперь
 * много: у всех, кто запускал прошлую версию, лежат gain.shoulder, gain.elbow,
 * jointLimits.elbow, длины костей руки и настройки удалённой стратегии 'reach'.
 * Всплыв в UI и в ограничителе, они дали бы ползунки несуществующих моторов.
 * Берём только те ключи, которые в дефолте есть сегодня, — и версию хранилища
 * поднимать не приходится.
 */
function pickKnown(defaults, saved) {
  const out = {};
  for (const [k, v] of Object.entries(defaults)) {
    const s = saved?.[k];
    out[k] = s === undefined || s === null ? v : s;
  }
  return out;
}

/**
 * Сохранённая сырая поза нуля. Кватернион — не «секция настроек», поэтому у него
 * своя проверка: мусор в localStorage (старый формат, обрезанный JSON) не должен
 * превратиться в тихо перекошенный ноль — лучше честно «ноль не взят».
 */
function pickZeroRaw(saved) {
  if (!saved) return null;
  const q = ['x', 'y', 'z', 'w'].map((k) => Number(saved[k]));
  if (!q.every(Number.isFinite)) return null;
  if (Math.hypot(...q) < 1e-6) return null;
  return { x: q[0], y: q[1], z: q[2], w: q[3] };
}

/** То же, но на два уровня: { сустав: { maxSpeedDeg, maxAccelDeg } }. */
function pickKnownDeep(defaults, saved) {
  const out = {};
  for (const [k, v] of Object.entries(defaults)) out[k] = pickKnown(v, saved?.[k]);
  return out;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const saved = JSON.parse(raw);
    // Слияние по разделам, и каждый раздел — через pickKnown: новые поля не теряются,
    // удалённые не воскресают. Новый раздел ОБЯЗАН быть перечислен здесь, иначе он
    // приедет из saved целиком, вместе с чужими ключами.
    return {
      ...pickKnown(DEFAULT_SETTINGS, saved),
      zeroRaw: pickZeroRaw(saved.zeroRaw),
      mountEulerDeg: pickKnown(DEFAULT_SETTINGS.mountEulerDeg, saved.mountEulerDeg),
      forearmAxis: pickKnown(DEFAULT_SETTINGS.forearmAxis, saved.forearmAxis),
      replay: pickKnown(DEFAULT_SETTINGS.replay, saved.replay),
      ui: pickKnown(DEFAULT_SETTINGS.ui, saved.ui),
      robot: {
        ...pickKnown(DEFAULT_SETTINGS.robot, saved.robot),
        direct: pickKnown(DEFAULT_DIRECT, saved.robot?.direct),
        // В старом localStorage могла остаться удалённая стратегия ('reach', 'chain') —
        // в списке её больше нет, и select показал бы пустое значение.
        strategy: ROBOT_STRATEGIES.includes(saved.robot?.strategy)
          ? saved.robot.strategy
          : DEFAULT_STRATEGY,
        gain: pickKnown(DEFAULT_GAIN, saved.robot?.gain),
        jointLimits: pickKnownDeep(DEFAULT_JOINT_LIMITS, saved.robot?.jointLimits),
      },
      view: pickKnown(DEFAULT_SETTINGS.view, saved.view),
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export const settings = Vue.observable(loadSettings());

export const telemetry = Vue.observable({
  connection: { state: 'idle', detail: '' },
  messages: 0,
  parseErrors: 0,
  hz: 0,
  ageMs: null,
  accuracyDeg: null,
  quatRaw: { x: 0, y: 0, z: 0, w: 1 },
  quatCal: { x: 0, y: 0, z: 0, w: 1 },
  anglesAndroidDeg: { azimuth: 0, pitch: 0, roll: 0 },
  anglesBabylonDeg: { yaw: 0, pitch: 0, roll: 0 },
  omegaDegPerSec: 0,
  /** 'deg' | 'rad' | null — что применилось к последнему пакету углов. */
  angleUnit: null,
  robotAnglesDeg: {},
  /** Куда стратегия ЦЕЛИТСЯ (фактические углы отстают из-за ограничителя). */
  robotTargetDeg: {},
  robotSpeedsDeg: {},
  robotTcp: { x: 0, y: 0, z: 0 },
  /** Азимут удерживается: предплечье почти вертикально и курс вырожден. */
  azimuthHeld: false,
  /**
   * Калибровка оси предплечья: идёт ли сбор, сколько приращений набрано, размах
   * скрутки и «чистота» жеста. Обновляется тем же таймером на 80 мс — сама оценка
   * копится в обычном объекте, не в реактивности (см. шапку файла).
   */
  forearmCal: { active: false, steps: 0, sweepDeg: 0, quality: 0 },
  /** Отклонение настроенной оси предплечья от номинальных «12 часов», градусы. */
  forearmAxisDeg: 0,
  /** Взят ли ноль по текущей позе. Без него курс относительный и произвольный. */
  zeroSet: false,
  /**
   * Прицел предплечья — те самые ТРИ числа, которые вообще наблюдаемы с часов.
   * Показываем их в панели, чтобы пользователь видел живую ось, а не гадал.
   */
  aimDeg: { azimuth: 0, elevation: 0, twist: 0 },
  aimDegenerate: false,
  /** Доля механического хода, пройденная каждым мотором с момента сброса, %. */
  robotUsage: {},
  robotMissingNodes: [],
  glbStatus: '',
  lastRaw: '',
  /** Запись сырых пакетов и загруженная запись для воспроизведения. */
  recording: { active: false, packets: 0, seconds: 0, dropped: false },
  /**
   * Загруженная запись и положение головки. position обновляется тем же таймером на
   * 80 мс, что и остальная витрина: полоса прогресса на 12 кадрах в секунду выглядит
   * гладко, а гнать её попакетно через реактивность нельзя (см. шапку файла).
   */
  replay: {
    name: '',
    packets: 0,
    seconds: 0,
    skipped: 0,
    position: 0,
    playing: false,
    paused: false,
  },
  errors: [],
});

/** Горячее состояние — НЕ реактивное. */
export const live = {
  qRaw: quat(),
  qCal: quat(),
  qBabylon: quat(),
  lastRecvTime: 0,
  omega: 0,
  accuracy: null,
  angleUnit: null,
  hasData: false,
  /** Цель для моторов, радианы — пишется на пакете, читается из render loop. */
  robotTarget: {},
  /** Диагностика последней стратегии (рабочая зона, скрутка). */
  robotDiag: {},
  /** Прицел предплечья последнего пакета (азимут/возвышение/скрутка, радианы). */
  robotAim: null,
  /** Накопленный размах каждого мотора: { имя: {min, max} }, радианы. */
  robotTravel: {},
};

export const calibration = new Calibration();
export const smoother = new QuatSmoother(settings.smoothingTau);
export const rateMeter = new RateMeter(40);
export const robotModel = new RobotModel();
export const jointLimiter = new JointLimiter(robotModel, settings.robot.jointLimits);

let source = null;
/**
 * Сбор данных для калибровки оси предплечья. Обычный объект: кормится на каждом
 * пакете, а панель читает только счётчики из telemetry.
 */
const axisCal = { active: false, estimator: new ForearmAxisEstimator() };
let prevQ = null;
let prevT = null;
let telemetryTimer = null;
const rawLog = [];

/**
 * Запись сырых пакетов (см. core/mqtt/recording.js). Обычный массив, не реактивный:
 * пишется на каждом пакете, а панели читают только счётчик из telemetry.
 * Потолок — чтобы забытая на час запись не съела память вкладки.
 */
const MAX_RECORD_ENTRIES = 200000;
const recording = { active: false, t0: 0, entries: [], dropped: false };

/** Запись, загруженная для источника 'replay'. */
let replay = { name: '', entries: [], skipped: 0 };

function pushError(message) {
  const line = `${new Date().toLocaleTimeString()} — ${message}`;
  telemetry.errors = [line, ...telemetry.errors].slice(0, 8);
}

/** Пересчёт одного сэмпла: калибровка → сглаживание → прицел руки → углы робота. */
function onSample(sample) {
  const t = sample.recvTime;
  rateMeter.tick(t);

  live.qRaw = sample.quat;
  live.accuracy = sample.accuracy;
  live.angleUnit = sample.angleUnit ?? null;
  live.lastRecvTime = t;
  live.hasData = true;

  // Ось предплечья ищется по СЫРОМУ потоку: она живёт в осях корпуса часов, а mount —
  // как раз то, что мы по ней назначим. Сглаживание тут только смазало бы приращения.
  if (axisCal.active) axisCal.estimator.push(sample.quat);

  const qCal = calibration.apply(sample.quat);
  const qSmooth = smoother.push(qCal, t);
  live.qCal = qSmooth;
  live.qBabylon = androidQuatToBabylon(qSmooth);

  live.omega = prevQ ? angularSpeed(prevQ, qSmooth, t - prevT) : 0;
  prevQ = qSmooth;
  prevT = t;

  // На пакете считаем только ЦЕЛЬ. Сами углы догоняют её в render loop по реальному dt
  // (см. actions.stepRobot): скорость приводов не должна зависеть от частоты пакетов.
  if (settings.robot.enabled && settings.robot.follow) {
    const diag = {};
    live.robotTarget = mapArmToRobot(settings.robot.strategy, live.qBabylon, robotModel, {
      gain: settings.robot.gain,
      // Азимут, возвышение и скрутку считать можно только в правой тройке Android
      // (см. core/math/aim.js), поэтому отдаём стратегии калиброванный кватернион
      // ДО перевода в сцену — иначе ей пришлось бы разворачивать его обратно.
      watchQuatAndroid: qSmooth,
      direct: settings.robot.direct,
      diag,
    });
    live.robotDiag = diag;
    live.robotAim = diag.aim || null;
  }
}

/**
 * Накопление размаха моторов — по ФАКТИЧЕСКИМ углам, а не по цели: то, что ограничитель
 * или механический упор не пропустили, ходом называть нельзя. Живёт в live (не в
 * telemetry): пишется часто, а панели читают уже готовые проценты.
 */
function trackTravel() {
  for (const j of robotModel.joints) {
    const v = robotModel.angles[j.name];
    if (!Number.isFinite(v)) continue;
    const s = live.robotTravel[j.name];
    if (!s) live.robotTravel[j.name] = { min: v, max: v };
    else {
      if (v < s.min) s.min = v;
      if (v > s.max) s.max = v;
    }
  }
}

function usagePercent() {
  const out = {};
  for (const j of robotModel.joints) {
    const s = live.robotTravel[j.name];
    const full = j.limits[1] - j.limits[0];
    out[j.name] = s && full > 0 ? +((toDeg(s.max - s.min) / full) * 100).toFixed(0) : 0;
  }
  return out;
}

function refreshTelemetry() {
  const now = performance.now() / 1000;
  telemetry.hz = Math.round(rateMeter.hz * 10) / 10;
  telemetry.ageMs = live.hasData ? Math.round((now - live.lastRecvTime) * 1000) : null;
  telemetry.accuracyDeg = live.accuracy == null ? null : +toDeg(live.accuracy).toFixed(1);
  telemetry.quatRaw = round4(live.qRaw);
  telemetry.quatCal = round4(live.qCal);
  telemetry.omegaDegPerSec = +toDeg(live.omega).toFixed(1);
  telemetry.angleUnit = live.angleUnit;

  const a = androidOrientationAngles(live.qCal);
  telemetry.anglesAndroidDeg = {
    azimuth: +toDeg(a.azimuth).toFixed(1),
    pitch: +toDeg(a.pitch).toFixed(1),
    roll: +toDeg(a.roll).toFixed(1),
  };
  const b = eulerYXZ(live.qBabylon);
  telemetry.anglesBabylonDeg = {
    yaw: +toDeg(b.yaw).toFixed(1),
    pitch: +toDeg(b.pitch).toFixed(1),
    roll: +toDeg(b.roll).toFixed(1),
  };

  const deg = robotModel.getAnglesDeg();
  for (const k of Object.keys(deg)) deg[k] = +deg[k].toFixed(1);
  telemetry.robotAnglesDeg = deg;
  telemetry.robotTargetDeg = roundMapDeg(live.robotTarget);
  telemetry.robotSpeedsDeg = roundMap(jointLimiter.speedsDeg());
  telemetry.robotTcp = round3(robotModel.forward().tcp);

  trackTravel();
  telemetry.robotUsage = usagePercent();

  const aim = live.robotAim;
  if (aim) {
    telemetry.aimDeg = {
      azimuth: +toDeg(aim.azimuth).toFixed(1),
      elevation: +toDeg(aim.elevation).toFixed(1),
      twist: +toDeg(aim.twist).toFixed(1),
    };
    telemetry.aimDegenerate = !!aim.degenerate;
  }

  telemetry.azimuthHeld = !!live.robotDiag?.azimuthHeld;

  const est = axisCal.estimator.estimate(settings.forearmAxis);
  telemetry.forearmCal = {
    active: axisCal.active,
    steps: est.steps,
    sweepDeg: +toDeg(est.sweep).toFixed(0),
    quality: +est.quality.toFixed(3),
  };
  telemetry.zeroSet = !!calibration.zeroRaw;
  telemetry.forearmAxisDeg = +toDeg(
    Math.acos(
      Math.max(-1, Math.min(1, calibration.forearmAxis.y)),
    ),
  ).toFixed(0);

  if (source) {
    telemetry.messages = source.stats.messages;
    telemetry.parseErrors = source.stats.parseErrors;
  }
  telemetry.lastRaw = rawLog[0] || '';
  telemetry.recording = {
    active: recording.active,
    packets: recording.entries.length,
    seconds: +recordingDuration(recording.entries).toFixed(1),
    dropped: recording.dropped,
  };

  if (source instanceof ReplaySource) {
    telemetry.replay = {
      ...telemetry.replay,
      position: +source.position.toFixed(2),
      playing: source.isActive,
      paused: source.paused,
    };
  } else if (telemetry.replay.playing) {
    telemetry.replay = { ...telemetry.replay, playing: false, paused: false };
  }
}

function round4(q) {
  return { x: +q.x.toFixed(4), y: +q.y.toFixed(4), z: +q.z.toFixed(4), w: +q.w.toFixed(4) };
}
function round3(v) {
  return { x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) };
}
function roundMap(map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) out[k] = +Number(v).toFixed(1);
  return out;
}
function roundMapDeg(map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) out[k] = +toDeg(Number(v)).toFixed(1);
  return out;
}

function makeSource() {
  let s;
  if (settings.source === 'mqtt') {
    s = new MqttSource({
      url: settings.url,
      topic: settings.topic,
      username: settings.username,
      password: settings.password,
      clientId: settings.clientId,
      format: settings.format,
      path: settings.path,
      angleUnit: settings.angleUnit,
      qos: settings.qos,
    });
  } else if (settings.source === 'replay') {
    s = new ReplaySource({
      entries: replay.entries,
      name: replay.name,
      speed: settings.replay.speed,
      loop: settings.replay.loop,
      format: settings.format,
      path: settings.path,
      angleUnit: settings.angleUnit,
    });
  } else {
    s = new MockSource();
  }

  s.on('status', (st) => {
    telemetry.connection = st;
  });
  s.on('error', (err) => pushError(err.message));
  s.on('sample', onSample);
  s.on('raw', ({ topic, text }) => {
    rawLog.unshift(`${topic}: ${text}`);
    if (rawLog.length > 50) rawLog.pop();
    captureRaw(topic, text);
  });
  return s;
}

/** Положить пакет в запись, если она идёт. Дословно, без разбора. */
function captureRaw(topic, text) {
  if (!recording.active) return;
  if (recording.entries.length >= MAX_RECORD_ENTRIES) {
    recording.dropped = true;
    return;
  }
  recording.entries.push({ t: performance.now() / 1000 - recording.t0, topic, payload: text });
}

export const actions = {
  init() {
    calibration.setForearmAxis(settings.forearmAxis);
    calibration.setMountEulerDeg(settings.mountEulerDeg);
    // Ноль восстанавливается ПОСЛЕ mount — он считается уже в калиброванной системе.
    if (settings.zeroRaw) calibration.captureZero(settings.zeroRaw, settings.zeroMode);
    smoother.setTau(settings.smoothingTau);
    jointLimiter.setLimits(settings.robot.jointLimits);
    actions.applyUiScale();
    live.robotTarget = { ...robotModel.angles };
    jointLimiter.sync(robotModel.angles);
    telemetryTimer = setInterval(refreshTelemetry, 80);
    if (settings.autoConnect) actions.connect();
  },

  connect() {
    actions.disconnect();
    source = makeSource();
    source.connect();
    actions.saveSettings();
  },

  disconnect() {
    source?.disconnect();
    source = null;
    rateMeter.reset();
    smoother.reset();
    live.angleUnit = null;
    prevQ = null;
    prevT = null;
  },

  get source() {
    return source;
  },

  /**
   * Запомнить текущую позу как нулевую. Сохраняем СЫРУЮ позу: сам ноль пересчитается
   * из неё под текущий mount и переживёт последующую калибровку оси предплечья
   * (см. core/math/calibration.js).
   */
  captureZero() {
    if (!live.hasData) {
      pushError('Нечего обнулять: данных с часов ещё не было');
      return false;
    }
    calibration.captureZero(live.qRaw, settings.zeroMode);
    const q = calibration.zeroRaw;
    Vue.set(settings, 'zeroRaw', { x: q.x, y: q.y, z: q.z, w: q.w });
    smoother.reset();
    actions.saveSettings();
    return true;
  },

  clearZero() {
    calibration.clearZero();
    Vue.set(settings, 'zeroRaw', null);
    smoother.reset();
    actions.saveSettings();
  },

  /** Смена режима нуля: поза уже сохранена, переснимать её незачем. */
  applyZeroMode() {
    calibration.setZeroMode(settings.zeroMode);
    smoother.reset();
    actions.saveSettings();
  },

  applyMount() {
    calibration.setMountEulerDeg(settings.mountEulerDeg);
    actions.saveSettings();
  },

  // ── Ось предплечья (см. core/math/forearmAxis.js) ──

  /**
   * Начать измерение оси. Дальше человек 2–3 секунды крутит кистью вокруг предплечья
   * — этого хватает: в записи с часов на 134° скрутки пришлось 99% движения, и ось
   * находится с точностью в доли градуса.
   */
  startForearmCalibration() {
    axisCal.estimator.reset();
    axisCal.active = true;
  },

  /**
   * Закончить и применить. Жест мог оказаться никаким (человек не двигался или
   * помахал рукой вместо скрутки) — тогда ничего не меняем и честно говорим почему.
   * @returns {{ok:boolean, reason?:string, sweepDeg?:number, quality?:number, deviationDeg?:number}}
   */
  finishForearmCalibration() {
    axisCal.active = false;
    const est = axisCal.estimator.estimate(settings.forearmAxis);
    const sweepDeg = toDeg(est.sweep);
    if (est.steps < 10 || sweepDeg < 30) {
      pushError(`Скрутки почти не было (${sweepDeg.toFixed(0)}°) — ось не изменилась`);
      return { ok: false, reason: 'мало движения', sweepDeg, quality: est.quality };
    }
    if (est.quality < 0.9) {
      pushError(
        `Движение вышло не одноосным (чистота ${(est.quality * 100).toFixed(0)}%) — ось не изменилась`,
      );
      return { ok: false, reason: 'движение не вокруг одной оси', sweepDeg, quality: est.quality };
    }
    actions.setForearmAxis(est.axis);
    return {
      ok: true,
      sweepDeg,
      quality: est.quality,
      deviationDeg: toDeg(est.deviation),
    };
  },

  cancelForearmCalibration() {
    axisCal.active = false;
    axisCal.estimator.reset();
  },

  /**
   * Поставить ось как есть, без выбора полушария: знак уже выбран тем, кто её принёс
   * (estimate() — по предыдущей настройке, «развернуть» — намеренно наоборот).
   */
  setForearmAxis(axis) {
    Vue.set(settings, 'forearmAxis', { x: axis.x, y: axis.y, z: axis.z });
    calibration.setForearmAxis(axis);
    smoother.reset();
    actions.saveSettings();
  },

  /**
   * Развернуть ось на 180°. По скрутке знак не определяется в принципе (см. шапку
   * forearmAxis.js): если основание смотрит ровно в противоположную сторону, а
   * возвышение перевёрнуто — это он.
   */
  flipForearmAxis() {
    const a = settings.forearmAxis;
    actions.setForearmAxis({ x: -a.x, y: -a.y, z: -a.z });
  },

  /** Вернуть номинальные «12 часов к кисти». */
  resetForearmAxis() {
    actions.setForearmAxis(NOMINAL_FOREARM_AXIS);
  },

  applySmoothing() {
    smoother.setTau(settings.smoothingTau);
    actions.saveSettings();
  },

  /**
   * Масштаб интерфейса. Меняем корневой font-size, а не zoom: zoom в Firefox не
   * поддерживается и вдобавок масштабировал бы канвас Babylon, ухудшая картинку.
   * Вся вёрстка сидит на rem, поэтому за шрифтом едут и отступы, и ширина панели.
   */
  applyUiScale() {
    const k = Math.min(2, Math.max(0.8, Number(settings.ui.scale) || 1));
    document.documentElement.style.setProperty('--ui-scale', String(k));
    actions.saveSettings();
  },

  /**
   * Шаг приводов по реальному времени кадра. Вызывается из render loop Babylon —
   * это единственное место, где известен честный dt. Компонент сам модель не трогает.
   * @param {number} dt секунды
   */
  stepRobot(dt) {
    if (!settings.robot.enabled) return;
    if (!settings.robot.follow) {
      // Ручной режим: углы ставят ползунки, ограничителю остаётся только не потерять
      // текущее состояние, чтобы при возврате в авто не было скачка.
      jointLimiter.sync(robotModel.angles);
      return;
    }
    if (!settings.robot.limiter) {
      robotModel.setAngles(live.robotTarget);
      jointLimiter.sync(robotModel.angles);
      return;
    }
    robotModel.setAngles(jointLimiter.step(live.robotTarget, dt));
  },

  applyRobot() {
    jointLimiter.setLimits(settings.robot.jointLimits);
    actions.saveSettings();
  },

  setRobotAngleDeg(name, deg) {
    robotModel.setAngleDeg(name, deg);
    jointLimiter.sync(robotModel.angles);
  },

  robotHome() {
    robotModel.goHome();
    jointLimiter.sync(robotModel.angles);
  },

  saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (err) {
      pushError(`Не сохранились настройки: ${err.message}`);
    }
  },

  resetSettings() {
    const fresh = structuredClone(DEFAULT_SETTINGS);
    for (const k of Object.keys(fresh)) Vue.set(settings, k, fresh[k]);
    // В дефолте zeroRaw = null, значит сброс настроек снимает и ноль — иначе он
    // остался бы висеть в калибровке, не будучи виден ни в одной настройке.
    actions.clearZero();
    actions.setForearmAxis(settings.forearmAxis);
    actions.applyMount();
    actions.applySmoothing();
    actions.applyUiScale();
    actions.applyRobot();
    actions.resetTravel();
  },

  rawLog() {
    return rawLog;
  },

  // ── Запись и воспроизведение пакетов (диагностика) ──

  /** Начать запись сырых пакетов. Старая запись при этом выбрасывается. */
  startRecording() {
    recording.entries = [];
    recording.dropped = false;
    recording.t0 = performance.now() / 1000;
    recording.active = true;
  },

  stopRecording() {
    recording.active = false;
  },

  clearRecording() {
    recording.active = false;
    recording.entries = [];
    recording.dropped = false;
  },

  /** Запись в формате NDJSON — то, что уходит в файл. */
  recordingText() {
    return serializeRecording(recording.entries);
  },

  recordingEntries() {
    return recording.entries;
  },

  /**
   * Загрузить запись для воспроизведения. Если источник уже 'replay' — переподключаемся,
   * чтобы новая запись поехала сразу, без ручного «Подключить».
   */
  loadReplay(name, text) {
    const { entries, skipped } = parseRecording(text);
    replay = { name, entries, skipped };
    telemetry.replay = {
      name,
      packets: entries.length,
      seconds: +recordingDuration(entries).toFixed(1),
      skipped,
      position: 0,
      playing: false,
      paused: false,
    };
    if (!entries.length) pushError(`В записи «${name}» не нашлось ни одного пакета`);
    else if (skipped) pushError(`В записи «${name}» пропущено битых строк: ${skipped}`);
    if (settings.source === 'replay') actions.connect();
  },

  /** Перемотать воспроизведение в начало. */
  restartReplay() {
    if (settings.source === 'replay') actions.connect();
  },

  /** Есть ли что воспроизводить (панель по этому гасит кнопки). */
  hasReplay() {
    return replay.entries.length > 0;
  },

  /**
   * Пауза/продолжение. Живёт не в settings, а в самом источнике: это состояние
   * сеанса, его незачем переживать перезагрузку страницы.
   */
  setReplayPaused(paused) {
    if (source instanceof ReplaySource) source.setPaused(paused);
  },

  toggleReplayPause() {
    if (source instanceof ReplaySource) source.setPaused(!source.paused);
  },

  /** Перемотка на секунду записи — без перезапуска источника. */
  seekReplay(seconds) {
    if (source instanceof ReplaySource) source.seek(seconds);
  },

  /**
   * Скорость применяется на лету: перезапуск сбросил бы позицию, а пользователь
   * обычно замедляет запись именно на интересном месте.
   */
  applyReplaySpeed(save = true) {
    if (source instanceof ReplaySource) source.setSpeed(settings.replay.speed);
    // save=false — для тяги ползунка: сохранять в localStorage на каждом кадре
    // перетаскивания незачем, настройка пишется один раз по отпусканию.
    if (save) actions.saveSettings();
  },

  applyReplayLoop() {
    if (source instanceof ReplaySource) source.setLoop(settings.replay.loop);
    actions.saveSettings();
  },

  /** Сбросить накопленный размах моторов (панель «сколько хода используется»). */
  resetTravel() {
    live.robotTravel = {};
    telemetry.robotUsage = {};
  },

  pushError,

  dispose() {
    clearInterval(telemetryTimer);
    actions.disconnect();
  },
};
