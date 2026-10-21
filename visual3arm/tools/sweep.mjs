/**
 * Замер использования хода моторов на полном размахе руки.
 *
 * Это диагностический инструмент, а не тест: он гоняет синтетическую руку по всей
 * комфортной области и печатает, какую долю своего механического хода при этом
 * использует каждая ось. Ось, у которой выходит 12%, — это ось, которой пользователь
 * не может управлять; ровно так и выглядел баг «не могу двигать плечо вниз и назад».
 *
 * Запуск из каталога visual3arm:
 *   node tools/sweep.mjs            # дефолтная стратегия
 *   node tools/sweep.mjs direct
 */

import { RobotModel } from '../src/core/robot/RobotModel.js';
import { mapArmToRobot, DEFAULT_STRATEGY, ROBOT_STRATEGIES } from '../src/core/robot/armToRobot.js';
import { androidOrientationToQuat, androidQuatToBabylon } from '../src/core/math/frames.js';
import { toDeg, toRad } from '../src/core/math/quat.js';

/** Ориентация часов, при которой предплечье смотрит в (азимут, возвышение), со скруткой. */
export function watchQuatFor(azimuthDeg, elevationDeg, twistDeg = 0) {
  // pitch у getOrientation() — это минус возвышение оси устройства, roll — скрутка.
  return androidOrientationToQuat({
    azimuth: toRad(azimuthDeg),
    pitch: -toRad(elevationDeg),
    roll: toRad(twistDeg),
  });
}

export function sweep(strategy, options = {}) {
  const model = new RobotModel();
  const stat = {};
  for (const j of model.joints) stat[j.name] = { min: Infinity, max: -Infinity };

  // Возвышение до −89°, а не до −90°: строго вертикальное предплечье — гимбал-лок,
  // там азимут не определён и неотличим от скрутки (та же дыра, что у getOrientation()).
  // Точка меры нуль, руку так не держат, но замер она бы испортила на десятки градусов.
  const elevations = [];
  for (let el = -89; el < 45; el += 5) elevations.push(el);
  elevations.push(45); // верхний конец берём точно, иначе шаг сетки съел бы пару градусов

  for (let az = -90; az <= 90; az += 5) {
    for (const el of elevations) {
      for (let tw = -180; tw <= 180; tw += 30) {
        const qa = watchQuatFor(az, el, tw);
        const qb = androidQuatToBabylon(qa);
        const target = mapArmToRobot(strategy, qb, model, { watchQuatAndroid: qa, ...options });
        // Считаем по УЖЕ ОБРЕЗАННЫМ углам: то, что мотор физически не проедет,
        // ходом называть нельзя.
        const angles = model.setAngles(target);
        for (const j of model.joints) {
          const v = angles[j.name];
          if (v < stat[j.name].min) stat[j.name].min = v;
          if (v > stat[j.name].max) stat[j.name].max = v;
        }
      }
    }
  }

  return model.joints.map((j) => {
    const span = toDeg(stat[j.name].max - stat[j.name].min);
    const full = j.limits[1] - j.limits[0];
    return {
      name: j.name,
      label: j.label,
      min: toDeg(stat[j.name].min),
      max: toDeg(stat[j.name].max),
      limits: j.limits,
      usage: (span / full) * 100,
    };
  });
}

function pad(s, n) {
  return String(s).padEnd(n);
}
function num(v, n = 6) {
  return v.toFixed(1).padStart(n);
}

const names = process.argv.slice(2).filter((s) => ROBOT_STRATEGIES.includes(s));
for (const strategy of names.length ? names : [DEFAULT_STRATEGY]) {
  console.log(`\nстратегия ${strategy}  (азимут ±90°, возвышение −89…45°, скрутка ±180°)`);
  for (const r of sweep(strategy)) {
    console.log(
      `  ${pad(r.name, 10)} ${num(r.min)}…${num(r.max)}°  из ${num(r.limits[0], 6)}…${num(r.limits[1], 6)}` +
        `  → ${r.usage.toFixed(0)}% хода`,
    );
  }
}
