/**
 * Живая запись с часов: скрутка кисти не должна уводить основание.
 *
 * ── Что за данные ──
 * tests/fixtures/twist-live.ndjson — 5 секунд настоящего потока с Galaxy Watch 6,
 * снятые кнопкой записи в панели. Человек крутил кистью вокруг предплечья туда и
 * обратно, стараясь больше ничем не шевелить. Именно на этой записи воспроизводился
 * баг «кручу кисть — уезжает основание».
 *
 * ── Зачем отдельно от синтетики ──
 * Синтетические тесты развязки в robot.test.js зелёные и были зелёными всё время,
 * пока баг жил: они крутят кисть вокруг ТОЙ ЖЕ оси, которую конвейер считает осью
 * предплечья, и при таком движении развязка действительно точная. На руке ось другая
 * — часы надеты как надеты, — и всё разъезжается. Поэтому запись прогоняется по той
 * же цепочке, что и приложение, целиком.
 *
 * Прогон намеренно повторяет store.onSample(): parsePayload → Calibration →
 * QuatSmoother → androidQuatToBabylon → mapArmToRobot, с обратной связью по углам
 * модели (удержание азимута читает текущий угол основания).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseRecording } from '../src/core/mqtt/recording.js';
import { parsePayload } from '../src/core/mqtt/parsers.js';
import { Calibration } from '../src/core/math/calibration.js';
import { QuatSmoother } from '../src/core/math/filter.js';
import { androidQuatToBabylon } from '../src/core/math/frames.js';
import { estimateForearmAxis, NOMINAL_FOREARM_AXIS } from '../src/core/math/forearmAxis.js';
import { RobotModel } from '../src/core/robot/RobotModel.js';
import { mapArmToRobot } from '../src/core/robot/armToRobot.js';
import { forearmAim } from '../src/core/math/aim.js';
import { toDeg } from '../src/core/math/quat.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/twist-live.ndjson', import.meta.url));

/** Сырые кватернионы записи — ровно то, что пришло бы из MQTT. */
function loadRaw() {
  const { entries } = parseRecording(readFileSync(FIXTURE, 'utf8'));
  const out = [];
  for (const e of entries) {
    const s = parsePayload(e.payload, {});
    if (s) out.push({ t: e.t, quat: s.quat });
  }
  return out;
}

/**
 * Прогон записи через весь конвейер с заданной осью предплечья.
 * @returns {{span: Record<string, number>}} размах каждого мотора, градусы
 */
function run(samples, forearmAxis) {
  const cal = new Calibration();
  cal.setForearmAxis(forearmAxis);
  const smoother = new QuatSmoother(0.05);
  const model = new RobotModel();

  const range = {};
  const note = (name, deg) => {
    const r = range[name] || (range[name] = { min: deg, max: deg });
    if (deg < r.min) r.min = deg;
    if (deg > r.max) r.max = deg;
  };

  for (const s of samples) {
    const q = smoother.push(cal.apply(s.quat), s.t);
    const target = mapArmToRobot('direct', androidQuatToBabylon(q), model, {
      watchQuatAndroid: q,
    });
    // Без ограничителя: он только размазал бы цель во времени, а мерим мы цель.
    model.setAngles(target);
    for (const [name, rad] of Object.entries(target)) note(name, toDeg(rad));
  }

  const span = {};
  for (const [name, r] of Object.entries(range)) span[name] = r.max - r.min;
  return { span };
}

const samples = loadRaw();

test('запись: в ней действительно почти одна скрутка, и ось — не «12 часов»', () => {
  assert.ok(samples.length > 200, `в записи разобралось всего ${samples.length} пакетов`);

  const est = estimateForearmAxis(samples.map((s) => s.quat));
  // 99% угловой «энергии» вокруг одной оси — движение и правда одноосное, значит
  // требовать развязки на этих данных законно.
  assert.ok(est.quality > 0.98, `чистота движения всего ${est.quality.toFixed(3)}`);
  assert.ok(toDeg(est.sweep) > 120, `размах скрутки ${toDeg(est.sweep).toFixed(0)}°`);
  // И ось эта далека от номинальной: часы надеты «поперёк» ожидания примерно на 77°.
  // Пока эта величина не ноль, номинальная ось +Y физически неверна.
  const deviation = toDeg(est.deviation);
  assert.ok(
    deviation > 60,
    `ось отклонена всего на ${deviation.toFixed(0)}° — запись перестала воспроизводить баг`,
  );
});

test('запись: с номинальной осью основание уезжает за скруткой (тот самый баг)', () => {
  // НЕГАТИВНЫЙ КОНТРОЛЬ и одновременно описание симптома: так ведёт себя код без
  // измеренной оси. Если этот тест однажды начнёт падать, значит правка ниже стала
  // не нужна — но тогда объяснять надо её, а не подкручивать порог здесь.
  const { span } = run(samples, NOMINAL_FOREARM_AXIS);
  assert.ok(
    span.base > 100,
    `основание прошло всего ${span.base.toFixed(0)}° — баг больше не воспроизводится`,
  );
});

test('запись: с измеренной осью скрутка остаётся в голове, основание почти стоит', () => {
  const est = estimateForearmAxis(samples.map((s) => s.quat));
  const { span } = run(samples, est.axis);

  // Ход головы — вся скрутка целиком.
  assert.ok(span.wristRoll > 120, `голова прошла ${span.wristRoll.toFixed(0)}° вместо ~135°`);

  // Порог не «на глаз»: остаточные 6° — это реальное движение предплечья на записи
  // (человек крутит кистью не в вакууме, локоть и плечо тоже живут). Полного нуля
  // здесь быть не может и не должно: основание обязано следовать за настоящим
  // поворотом руки. Запас до 12° — на смену параметров сглаживания.
  assert.ok(
    span.base < 12,
    `основание всё ещё гуляет на ${span.base.toFixed(0)}° при ${span.wristRoll.toFixed(0)}° скрутки`,
  );
  // Наклон стрелы растянут с возвышения (см. DEFAULT_DIRECT), поэтому его порог выше
  // в отношении диапазонов: 120° хода стрелы на 125° хода руки.
  assert.ok(
    span.lift < 12,
    `наклон стрелы гуляет на ${span.lift.toFixed(0)}° — скрутка течёт и туда`,
  );

  // И главное число отчёта: во сколько раз стало лучше.
  const before = run(samples, NOMINAL_FOREARM_AXIS).span.base;
  assert.ok(before / span.base > 10, `увод основания улучшился всего в ${(before / span.base).toFixed(1)} раза`);
});

test('запись: после обнуления по первой позе азимут ноль, а не отклонение оси', () => {
  // Второй симптом на тех же данных: «рука вперёд — робот наискось». Ноль берётся
  // ПОСЛЕ mount (см. core/math/calibration.js); пока он брался до, «обнулить по
  // текущей позе» оставляло азимут ровно равным отклонению оси — на этой записи 77°.
  const est = estimateForearmAxis(samples.map((s) => s.quat));
  for (const mode of ['full', 'heading']) {
    const cal = new Calibration();
    cal.setForearmAxis(est.axis);
    cal.captureZero(samples[0].quat, mode);
    const azDeg = toDeg(forearmAim(cal.apply(samples[0].quat)).azimuth);
    assert.ok(
      Math.abs(azDeg) < 1e-6,
      `режим ${mode}: после нуля азимут ${azDeg.toFixed(1)}° (отклонение оси ${toDeg(est.deviation).toFixed(0)}°)`,
    );
  }
});
